#!/usr/bin/env python3
"""
Voice Separator engine: ek audio/video file ko tod kar 3 WAV files banata hai.

  <name>_voice_clean.wav     voice + noise removal (DeepFilterNet)
  <name>_voice_original.wav  voice, bina denoise ke (Demucs)
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
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE.parent / "models"          # --runtime se badal jata hai


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


def to_wav(src, dst, ffmpeg):
    """Kisi bhi audio/video ko 44.1kHz stereo WAV mein badal do."""
    cmd = [ffmpeg, "-y", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100",
           "-c:a", "pcm_s16le", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        fail("FFmpeg convert fail: " + r.stderr[-400:])


def separate(wav, workdir, device):
    """Demucs (htdemucs) se vocals aur no_vocals nikalo."""
    out = workdir / "sep"
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals",
           "-n", "htdemucs", "-d", device, "-o", str(out), str(wav)]
    r = subprocess.run(cmd, capture_output=True, text=True, env=os.environ.copy())
    if r.returncode != 0:
        fail("Demucs fail: " + (r.stderr or r.stdout)[-600:])
    folder = out / "htdemucs" / wav.stem
    return folder / "vocals.wav", folder / "no_vocals.wav"


def denoise(vocals_path, out_path, strength):
    """DeepFilterNet se voice saaf karo. strength: 0..100."""
    import soundfile as sf
    from df.enhance import enhance, init_df, load_audio

    bundled = MODELS / "DeepFilterNet3"
    if bundled.is_dir():
        model, df_state, _ = init_df(model_base_dir=str(bundled), log_file=None)
    else:
        model, df_state, _ = init_df()
    audio, _ = load_audio(str(vocals_path), sr=df_state.sr())

    # 100 = poora noise hatao. Kam strength = thoda noise rehne do (natural lagti hai)
    atten = None if strength >= 100 else 3 + (strength / 100.0) * 37  # 3..40 dB
    clean = enhance(model, df_state, audio, atten_lim_db=atten)

    sf.write(str(out_path), clean.detach().cpu().numpy().T, df_state.sr())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("input", nargs="?")
    p.add_argument("-o", "--out", help="output folder")
    p.add_argument("--runtime", help="runtime folder (python, models, bin)")
    p.add_argument("--check", action="store_true", help="install check chalao")
    p.add_argument("--strength", type=int, default=100,
                   help="noise removal 0-100 (default 100)")
    p.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg ka path")
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    a = p.parse_args()

    global MODELS
    if a.runtime:
        MODELS = Path(a.runtime) / "models"
    setup_offline_env()

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
        to_wav(src, wav, a.ffmpeg)

        emit("separate", 15, device=device)
        vocals, music = separate(wav, tmp, device)

        emit("denoise", 70)
        clean = out_dir / f"{name}_voice_clean.wav"
        denoise(vocals, clean, a.strength)

        emit("export", 95)
        orig = out_dir / f"{name}_voice_original.wav"
        mus = out_dir / f"{name}_music.wav"
        shutil.copy(vocals, orig)
        shutil.copy(music, mus)

    emit("done", 100, files={"voice_clean": str(clean),
                             "voice_original": str(orig),
                             "music": str(mus)})


if __name__ == "__main__":
    main()
