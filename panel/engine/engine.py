#!/usr/bin/env python3
"""
Voice Isolator engine: ek audio/video file ko tod kar 3 WAV files banata hai.

  <name>_voice_enhanced.wav  clean voice + studio polish (EQ, de-esser, compressor, loudness)  [--enhance]
  <name>_voice_clean.wav     voice + noise removal (DeepFilterNet)
  <name>_voice_original.wav  voice, bina denoise ke (Demucs)
  <name>_noise.wav           wo noise jo voice se hataya gaya (original voice - clean voice)
  <name>_music.wav           baqi sab kuch (music / song / background)

Usage:
  python engine.py input.mp4 -o out_folder --strength 80

Agar ../models folder maujood ho (offline package), to saare models wahi se
load hote hain aur internet ki zaroorat nahi hoti.
Progress stdout par JSON lines mein aati hai (panel parhta hai).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE.parent / "models"          # --runtime se badal jata hai


def _patch_git_calls():
    """DeepFilterNet sirf logging ke liye `git` chalata hai aur sirf "git fail hua" (CalledProcessError)
    sambhalta hai. Customer ke PC par git hota hi nahi, to FileNotFoundError aata tha aur process crash
    ho jata tha (Mac par git ka shim Xcode ka popup bhi dikha deta hai). Hamein git ki zaroorat nahi,
    isliye git ko chalate hi nahi: seedha CalledProcessError uthate hain, jise df khud sambhal leta hai."""
    real = subprocess.check_output

    def safe(cmd, *a, **k):
        first = cmd[0] if isinstance(cmd, (list, tuple)) and cmd else cmd
        name = os.path.basename(str(first)).lower()
        if name in ("git", "git.exe"):
            raise subprocess.CalledProcessError(127, cmd)
        return real(cmd, *a, **k)

    subprocess.check_output = safe


_patch_git_calls()   # df import hone se pehle


def setup_offline_env():
    """Downloaded runtime ke models mil jaayein to har library ko wahi dikhao, internet band."""
    if (MODELS / "hf").exists() or (MODELS / "torch").exists():
        os.environ["HF_HOME"] = str(MODELS / "hf")
        os.environ["TORCH_HOME"] = str(MODELS / "torch")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"


def self_check():
    """Install ke baad check: sab libraries load hoti hain? JSON print karta hai."""
    try:
        import torch
        import soundfile  # noqa: F401
        import demucs  # noqa: F401
        from df.enhance import init_df  # noqa: F401
        dev = pick_device()
        info = {"stage": "check", "ok": True, "device": dev, "torch": torch.__version__}
        if dev == "cuda":
            info["gpu"] = torch.cuda.get_device_name(0)
        print(json.dumps(info), flush=True)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"stage": "check", "ok": False, "message": repr(e)}), flush=True)
        sys.exit(2)


def emit(stage, percent, **extra):
    print(json.dumps({"stage": stage, "percent": percent, **extra}), flush=True)


def fail(msg):
    print(json.dumps({"stage": "error", "message": msg}), flush=True)
    sys.exit(1)


def pick_device():
    import torch
    # MPS (Mac) jaan boojh kar auto nahi: Demucs ke kuch ops wahan fail hote hain
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def to_wav(src, dst, ffmpeg, start=0.0, duration=0.0):
    """Kisi bhi audio/video ko 44.1kHz stereo WAV mein badal do.
    start/duration (seconds) dein to sirf utna hissa nikalta he."""
    cmd = [ffmpeg, "-y"]
    if start and start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(src)]
    if duration and duration > 0:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        fail("FFmpeg convert fail: " + r.stderr[-400:])


def best_model_available():
    """Pack mein htdemucs_ft (Best/Maximum) maujood he? Build marker file likhta he jab model offline load ho chuka ho."""
    if not ((MODELS / "hf").exists() or (MODELS / "torch").exists()):
        return True            # dev mode: Demucs zaroorat par khud download kar lega
    return (MODELS / "ft_ok.txt").exists()


def separate(wav, workdir, device, model="htdemucs", extra=None):
    """Demucs se vocals aur no_vocals nikalo.
    model: htdemucs (Fast) ya htdemucs_ft (Best/Maximum).  extra: jaise ["--shifts", "3", "--overlap", "0.5"]."""
    out = workdir / "sep"
    base = [sys.executable, "-m", "demucs", "--two-stems=vocals",
            "-n", model, "-d", device, "-o", str(out)] + list(extra or [])
    r = None
    for hi_res in (["--int24"], []):          # pehle 24-bit output, na chale to normal
        r = subprocess.run(base + hi_res + [str(wav)], capture_output=True, text=True, env=os.environ.copy())
        if r.returncode == 0:
            break
    if r.returncode != 0:
        raise RuntimeError("Demucs fail: " + (r.stderr or r.stdout)[-600:])
    folder = out / model / wav.stem
    return folder / "vocals.wav", folder / "no_vocals.wav"


def denoise(vocals_path, out_path, strength, cleanup="normal"):
    """DeepFilterNet se voice saaf karo. strength: 0..100.
    cleanup: normal = ek pass | strong = + post-filter (bachi hui hiss kam) | max = + dusra pass."""
    import soundfile as sf
    from df.enhance import enhance, init_df, load_audio

    pf = cleanup in ("strong", "max")
    bundled = MODELS / "DeepFilterNet3"
    kw = {"model_base_dir": str(bundled)} if bundled.is_dir() else {}
    try:
        model, df_state, _ = init_df(post_filter=pf, log_file=None, **kw)
    except TypeError:                       # is DeepFilterNet version mein post_filter nahi
        model, df_state, _ = init_df(log_file=None, **kw)
    audio, _ = load_audio(str(vocals_path), sr=df_state.sr())

    # 100 = poora noise hatao. Kam strength = thoda noise rehne do (natural lagti hai)
    atten = None if strength >= 100 else 3 + (strength / 100.0) * 37  # 3..40 dB
    clean = enhance(model, df_state, audio, atten_lim_db=atten)
    if cleanup == "max":
        clean = enhance(model, df_state, clean, atten_lim_db=atten)

    sf.write(str(out_path), clean.detach().cpu().numpy().T, df_state.sr(), subtype="PCM_24")


def extra_denoise(path, amount, ffmpeg, workdir):
    """DeepFilterNet ke baad bachi hui hiss/noise par FFmpeg afftdn (noise ko khud track karta he).
    amount 0..100  ->  noise reduction 6..30 dB.  0 = off."""
    if amount <= 0:
        return
    nr = 6.0 + 0.24 * float(amount)
    tmp = Path(workdir) / "hiss_tmp.wav"
    _ffmpeg_run([ffmpeg, "-hide_banner", "-nostats", "-y", "-i", str(path),
                 "-af", f"afftdn=nr={nr:.1f}:nf=-50:tn=1:nt=w",
                 "-c:a", "pcm_s24le", str(tmp)])
    shutil.move(str(tmp), str(path))


# ---------------------------------------------------------------------------
# Voice enhance (aakhri step): DSP chain, koi extra model nahi, FFmpeg se.
# Har cheez ek number se control hoti hai (panel ke sliders):
#   lowcut    Hz   0..200   rumble/hum hatao (0 = off)
#   mud       dB   0..8     250 Hz par boxiness kam karo (0 = off)
#   presence  dB   0..6     3.2 kHz par awaaz saaf/aagay (0 = off)
#   air       dB   0..6     9.5 kHz par chamak (0 = off)
#   deess     0..100        "s" sounds narm (0 = off)
#   comp      0..100        compression/barabri (0 = off)
#   gate      0..100        noise gate: bolne ke beech ki halki hiss dabao (0 = off)
#   lufs      -30..-8       final loudness
# Presets: natural = halka, studio = poora. "custom" = panel ke sliders jo bhi hon.
# Peak ceiling -1.5 dBTP.
# ---------------------------------------------------------------------------
LOUDNESS_TARGET = -16.0
LIMITER_CEILING_DB = -1.5     # output peak

ENHANCE_PRESETS = {
    "natural": {"lowcut": 70, "mud": 0, "presence": 0, "air": 0, "deess": 0, "comp": 20, "gate": 0,
                "lufs": -16, "attack": 20, "release": 250},
    "studio":  {"lowcut": 80, "mud": 2, "presence": 2.5, "air": 1.5, "deess": 40, "comp": 40, "gate": 30,
                "lufs": -16, "attack": 10, "release": 180},
}
ENHANCE_LIMITS = {
    "lowcut": (0, 200), "mud": (0, 8), "presence": (0, 6), "air": (0, 6),
    "deess": (0, 100), "comp": (0, 100), "gate": (0, 100), "lufs": (-30, -8),
}


def resolve_enhance_params(level, overrides=None):
    """Preset + panel ke sliders -> saaf (clamped) numbers ka dict."""
    base = ENHANCE_PRESETS.get(level, ENHANCE_PRESETS["studio"])
    p = dict(base)
    p.setdefault("attack", 12)
    p.setdefault("release", 200)
    for k, v in (overrides or {}).items():
        if k in ENHANCE_LIMITS:
            try:
                lo, hi = ENHANCE_LIMITS[k]
                p[k] = max(lo, min(hi, float(v)))
            except (TypeError, ValueError):
                pass
    return p


def build_chain(p):
    """Params -> FFmpeg audio filter chain (string)."""
    parts = []
    if p["lowcut"] > 0:
        parts.append(f"highpass=f={p['lowcut']:g}")
    if p["gate"] > 0:
        thr = 10 ** ((-65.0 + 0.25 * p["gate"]) / 20.0)          # 30 -> -57.5 dB, 100 -> -40 dB
        floor = 10 ** (-(6.0 + 0.18 * p["gate"]) / 20.0)         # 30 -> -11.4 dB, 100 -> -24 dB
        ratio = 2.0 + p["gate"] / 100.0 * 4.0
        parts.append(f"agate=threshold={thr:.5f}:ratio={ratio:.2f}:attack=15:release=300:range={floor:.4f}")
    if p["mud"] > 0:
        parts.append(f"equalizer=f=250:t=q:w=1.2:g=-{p['mud']:g}")
    if p["presence"] > 0:
        parts.append(f"equalizer=f=3200:t=q:w=1:g={p['presence']:g}")
    if p["air"] > 0:
        parts.append(f"highshelf=f=9500:g={p['air']:g}")
    if p["deess"] > 0:
        parts.append(f"deesser=i={p['deess'] / 100.0:.2f}:m=0.5:f=0.5:s=o")
    if p["comp"] > 0:
        ratio = 1.0 + p["comp"] / 100.0 * 5.0          # 20 -> 2:1, 40 -> 3:1, 100 -> 6:1
        thr = -26.0 + 0.1 * p["comp"]                   # 20 -> -24 dB, 40 -> -22 dB
        makeup = 1.0 + 0.05 * p["comp"]                 # 20 -> x2, 40 -> x3
        parts.append(f"acompressor=threshold={thr:g}dB:ratio={ratio:g}:"
                     f"attack={p['attack']:g}:release={p['release']:g}:makeup={makeup:g}")
    return ",".join(parts) if parts else "anull"


def _ffmpeg_run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("FFmpeg: " + (r.stderr or "")[-300:])
    return r.stderr or ""


def enhance_voice(src, dst, level, ffmpeg, overrides=None):
    """src (denoised voice wav) -> dst (24-bit wav).

    Step 1: chain ke baad loudness napo (loudnorm sirf measurement ke liye).
    Step 2: seedha utni gain lagao ke target LUFS aaye, phir limiter se peaks sambhalo.
    (loudnorm ka apna peak-rule awaaz ko kam uthata tha, is tareeqe se target poora milta hai.)
    """
    import soundfile as sf
    if level not in ("natural", "studio", "custom"):
        raise ValueError("unknown enhance level: " + str(level))
    params = resolve_enhance_params(level, overrides)
    chain = build_chain(params)
    target = params["lufs"]
    sr = sf.info(str(src)).samplerate
    base = [ffmpeg, "-hide_banner", "-nostats", "-y", "-i", str(src)]

    err = _ffmpeg_run(base + ["-af", f"{chain},loudnorm=I={target:g}:TP=-1.5:LRA=11:print_format=json",
                              "-f", "null", "-"])
    gain_db = 0.0
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if m:
        try:
            j = json.loads(m.group(0))
            in_i, in_tp = float(j["input_i"]), float(j["input_tp"])
            if abs(in_i) != float("inf") and in_i == in_i and abs(in_tp) != float("inf") and in_tp == in_tp:
                gain_db = target - in_i
                # limiter peak ko zyada se zyada ~6 dB dabaye (warna awaaz kharab hoti hai)
                gain_db = min(gain_db, (LIMITER_CEILING_DB + 6.0) - in_tp)
                gain_db = max(-30.0, min(gain_db, 40.0))
        except (ValueError, KeyError):
            gain_db = 0.0   # khamoshi / parse fail: sirf chain lagao

    ceiling = 10 ** (LIMITER_CEILING_DB / 20.0)
    _ffmpeg_run(base + ["-af", f"{chain},volume={gain_db:.2f}dB,"
                               f"alimiter=limit={ceiling:.3f}:attack=5:release=80:level=disabled",
                        "-ar", str(sr), "-c:a", "pcm_s24le", str(dst)])


def extract_noise(vocals_path, clean_path, out_path, ffmpeg, workdir):
    """Noise = original voice stem - denoised voice. (DeepFilterNet 48 kHz deta hai, Demucs 44.1 kHz,
    isliye pehle clean ko 44.1 kHz par laate hain.)"""
    import numpy as np
    import soundfile as sf
    clean44 = Path(workdir) / "clean44.wav"
    _ffmpeg_run([ffmpeg, "-hide_banner", "-nostats", "-y", "-i", str(clean_path),
                 "-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", str(clean44)])
    v, _ = sf.read(str(vocals_path), dtype="float32", always_2d=True)
    c, _ = sf.read(str(clean44), dtype="float32", always_2d=True)
    ch = min(v.shape[1], c.shape[1])
    n = min(len(v), len(c))
    noise = np.clip(v[:n, :ch] - c[:n, :ch], -1.0, 1.0)
    sf.write(str(out_path), noise, 44100, subtype="PCM_24")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("input", nargs="?")
    p.add_argument("-o", "--out", help="output folder")
    p.add_argument("--runtime", help="runtime folder (python, models, bin)")
    p.add_argument("--check", action="store_true", help="install check chalao")
    p.add_argument("--strength", type=int, default=100,
                   help="noise removal 0-100 (default 100)")
    p.add_argument("--enhance", default="off", choices=["off", "natural", "studio", "custom"],
                   help="voice enhance (aakhri polish): off / natural / studio / custom")
    p.add_argument("--start", type=float, default=0.0, help="sirf is second se shuru karo")
    p.add_argument("--duration", type=float, default=0.0, help="sirf itne second process karo (0 = poori)")
    p.add_argument("--preview", type=float, default=0.0,
                   help="chhota sample: itne second (range ke beech se) process karo")
    p.add_argument("--keep-input", action="store_true", help="<name>_input.wav (jo hissa process hua) bhi do")
    p.add_argument("--quality", default="fast", choices=["fast", "best", "max"],
                   help="separation quality: fast (htdemucs) / best (htdemucs_ft, ~4x slower) / "
                        "max (htdemucs_ft + shifts 3 + overlap 0.5, ~10x slower)")
    p.add_argument("--hiss", type=int, default=0,
                   help="extra hiss/noise reduction 0-100 (FFmpeg afftdn, denoise ke baad)")
    p.add_argument("--cleanup", default="normal", choices=["normal", "strong", "max"],
                   help="noise cleanup: normal / strong (post-filter) / max (post-filter + 2nd pass)")
    p.add_argument("--enhance-params", default="",
                   help='JSON: {"lowcut":80,"mud":2,"presence":2.5,"air":1.5,"deess":40,"comp":40,"lufs":-16}')
    p.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg ka path")
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    a = p.parse_args()

    global MODELS
    if a.runtime:
        MODELS = Path(a.runtime) / "models"
    setup_offline_env()

    # Demucs agar kabhi ffmpeg maange to wahi mile jo hum ne bundle kiya hai
    ffp = Path(a.ffmpeg)
    if ffp.exists():
        os.environ["PATH"] = str(ffp.resolve().parent) + os.pathsep + os.environ.get("PATH", "")
    elif (MODELS.parent / "bin").exists():
        os.environ["PATH"] = str(MODELS.parent / "bin") + os.pathsep + os.environ.get("PATH", "")

    if a.check:
        self_check()
        return
    if not a.input or not a.out:
        fail("input aur -o dono chahiye")

    src = Path(a.input)
    if not src.exists():
        fail("Input file nahi mili: " + str(src))
    if shutil.which(a.ffmpeg) is None and not Path(a.ffmpeg).exists():
        fail("FFmpeg nahi mila. --ffmpeg se path dein.")

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    device = pick_device() if a.device == "auto" else a.device
    name = src.stem

    with tempfile.TemporaryDirectory(prefix="vsep_") as tmp:
        tmp = Path(tmp)

        emit("convert", 5)
        wav = tmp / "input.wav"
        to_wav(src, wav, a.ffmpeg, a.start, a.duration)

        if a.preview > 0:
            import soundfile as sf
            total = sf.info(str(wav)).duration
            if total > a.preview + 0.5:
                cut = tmp / "preview.wav"
                _ffmpeg_run([a.ffmpeg, "-hide_banner", "-nostats", "-y", "-ss", f"{(total - a.preview) / 2:.3f}",
                             "-i", str(wav), "-t", f"{a.preview:.3f}", "-c:a", "pcm_s24le", str(cut)])
                wav = cut
        input_copy = None
        if a.keep_input:
            input_copy = out_dir / f"{name}_input.wav"
            shutil.copy(wav, input_copy)

        model = "htdemucs"
        sep_extra = []
        if a.quality in ("best", "max"):
            if best_model_available():
                model = "htdemucs_ft"
                if a.quality == "max":
                    sep_extra = ["--shifts", "3", "--overlap", "0.5"]
            else:
                print(json.dumps({"stage": "warn", "message":
                      "Best quality needs the updated engine pack, so Fast was used. Use 'Update available' / 'Reinstall' in the panel."}),
                      flush=True)
        emit("separate", 15, device=device, model=model)
        try:
            vocals, music = separate(wav, tmp, device, model, sep_extra)
        except RuntimeError as first_err:
            # 24-bit input kisi library ko pasand na aaye to 16-bit input se dobara koshish
            wav16 = tmp / "input16.wav"
            _ffmpeg_run([a.ffmpeg, "-hide_banner", "-nostats", "-y", "-i", str(wav), "-c:a", "pcm_s16le", str(wav16)])
            try:
                vocals, music = separate(wav16, tmp, device, model, sep_extra)
            except RuntimeError:
                fail(str(first_err))

        emit("denoise", 70)
        clean = out_dir / f"{name}_voice_clean.wav"
        denoise(vocals, clean, a.strength, a.cleanup)

        if a.hiss > 0:
            try:
                extra_denoise(clean, a.hiss, a.ffmpeg, tmp)
            except Exception as e:  # noqa: BLE001
                print(json.dumps({"stage": "warn", "message": "Extra hiss reduction skipped: " + str(e)[:200]}), flush=True)

        noise = None
        emit("noise", 78)
        try:
            noise = out_dir / f"{name}_noise.wav"
            extract_noise(vocals, clean, noise, a.ffmpeg, tmp)
        except Exception as e:  # noqa: BLE001  (noise file optional hai)
            noise = None
            print(json.dumps({"stage": "warn", "message": "Noise file skipped: " + str(e)[:200]}), flush=True)

        enhanced = None
        if a.enhance != "off":
            emit("enhance", 85)
            try:
                overrides = json.loads(a.enhance_params) if a.enhance_params else {}
            except ValueError:
                overrides = {}
            try:
                enhanced = out_dir / f"{name}_voice_enhanced.wav"
                try:
                    enhance_voice(clean, enhanced, a.enhance, a.ffmpeg, overrides)
                except Exception:  # noqa: BLE001  (kisi FFmpeg filter ka masla: gate ke baghair dobara koshish)
                    if (overrides.get("gate", ENHANCE_PRESETS.get(a.enhance, {}).get("gate", 0)) or 0) <= 0:
                        raise
                    enhance_voice(clean, enhanced, a.enhance, a.ffmpeg, dict(overrides, gate=0))
            except Exception as e:  # noqa: BLE001  (polish optional hai, baqi kaam na rukay)
                enhanced = None
                print(json.dumps({"stage": "warn", "message": "Voice enhance skipped: " + str(e)[:200]}), flush=True)

        emit("export", 95)
        orig = out_dir / f"{name}_voice_original.wav"
        mus = out_dir / f"{name}_music.wav"
        shutil.copy(vocals, orig)
        shutil.copy(music, mus)

    files = {"voice_clean": str(clean), "voice_original": str(orig), "music": str(mus)}
    if enhanced is not None:
        files["voice_enhanced"] = str(enhanced)
    if noise is not None:
        files["noise"] = str(noise)
    if input_copy is not None:
        files["input"] = str(input_copy)
    emit("done", 100, files=files)


if __name__ == "__main__":
    main()
