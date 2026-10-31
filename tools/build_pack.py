#!/usr/bin/env python3
"""
Pack builder (GitHub Actions par ya apne PC par).

  python tools/build_pack.py --id win-cpu --version 1.0.0

Banata hai:  dist/<id>-<version>.tar.gz   aur   dist/<id>.json (version, size, sha256)
Ids: win-cpu, win-gpu, mac-arm64, mac-x64
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "panel" / "engine" / "engine.py"
DIST = ROOT / "dist"
WORK = ROOT / "work"

WIN_PY = "3.10.11"
PBS_TAG, PBS_PY = "20240224", "3.10.13"
TORCH = ["torch==2.1.2", "torchaudio==2.1.2"]
UA = {"User-Agent": "Mozilla/5.0 VoiceIsolatorBuild"}


def run(cmd, env=None):
    cmd = [str(c) for c in cmd]
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, env=env)


def download(url, dest):
    print("download", url, flush=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)


def pip(py, *args):
    run([py, "-m", "pip", "install", "--no-warn-script-location", *args])


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def flatten_symlinks(root):
    """Symlinks ki jagah asli files rakho (Windows tar.exe symlink nahi bana sakta).
    HuggingFace cache: snapshots/<hash>/file -> ../../blobs/<sha>.  Phir blobs hata do."""
    root = Path(root)
    links = []
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = Path(dp) / n
            if p.is_symlink():
                links.append(p)
    for p in links:
        target = p.resolve()
        p.unlink()
        if target.is_dir():
            shutil.copytree(target, p)
        else:
            shutil.copy2(target, p)
    for b in [d for d in root.rglob("blobs") if d.is_dir() and d.parent.name.startswith("models--")]:
        shutil.rmtree(b)
    return len(links)


def find_symlinks(root):
    out = []
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = Path(dp) / n
            if p.is_symlink():
                out.append(p)
    return out


def make_pack(W, pid, version):
    """W folder ko tar.gz banao aur descriptor json likho."""
    DIST.mkdir(exist_ok=True)
    (W / "pack.json").write_text(json.dumps({"id": pid, "version": version}))
    for d in [p for p in W.rglob("__pycache__")]:
        shutil.rmtree(d, ignore_errors=True)
    fname = f"{pid}-{version}.tar.gz"
    out = DIST / fname
    with tarfile.open(out, "w:gz", compresslevel=6) as tf:
        tf.add(W, arcname=".")
    desc = {"id": pid, "version": version, "file": fname,
            "sha256": sha256_of(out), "size": out.stat().st_size}
    (DIST / f"{pid}.json").write_text(json.dumps(desc))
    print("pack:", desc, flush=True)
    return desc


def setup_python(W, pid):
    """Relocatable Python W/python mein rakho. py ka path return karta hai."""
    WORK.mkdir(exist_ok=True)
    if pid.startswith("win"):
        z = WORK / "py-embed.zip"
        download(f"https://www.python.org/ftp/python/{WIN_PY}/python-{WIN_PY}-embed-amd64.zip", z)
        import zipfile
        with zipfile.ZipFile(z) as zf:
            zf.extractall(W / "python")
        (W / "python" / "python310._pth").write_text("python310.zip\n.\nLib\\site-packages\nimport site\n")
        gp = WORK / "get-pip.py"
        download("https://bootstrap.pypa.io/get-pip.py", gp)
        py = W / "python" / "python.exe"
        run([py, gp, "--no-warn-script-location"])
        return py
    arch = "aarch64" if pid == "mac-arm64" else "x86_64"
    t = WORK / "py-pbs.tar.gz"
    download(f"https://github.com/indygreg/python-build-standalone/releases/download/{PBS_TAG}/"
             f"cpython-{PBS_PY}+{PBS_TAG}-{arch}-apple-darwin-install_only.tar.gz", t)
    with tarfile.open(t) as tf:
        tf.extractall(W)
    return W / "python" / "bin" / "python3"


def build(pid, version):
    is_win = pid.startswith("win")
    gpu = pid.endswith("gpu")
    W = WORK / pid
    if W.exists():
        shutil.rmtree(W)
    W.mkdir(parents=True)

    print("== [1/6] Python", flush=True)
    py = setup_python(W, pid)

    print("== [2/6] Libraries", flush=True)
    if gpu:
        pip(py, *TORCH, "--index-url", "https://download.pytorch.org/whl/cu121")
    else:
        pip(py, *TORCH)
    if pid == "mac-x64":
        # Intel Mac: Demucs ki library "sphn" ka Intel wheel maujood nahi (compile fail hota tha).
        # Demucs sphn sirf audio padhne ke liye try karta hai aur ffmpeg par fallback karta hai,
        # isliye demucs ko bina sphn install karke ek chhota stub rakh dete hain.
        pip(py, "demucs", "--no-deps")
        pip(py, "einops", "huggingface-hub", "julius", "lameenc", "pyyaml", "safetensors", "tqdm")
        pip(py, "deepfilternet", "soundfile", "imageio-ffmpeg", "numpy<2")
        site = subprocess.check_output([str(py), "-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"],
                                       text=True).strip()
        stub = Path(site) / "sphn"
        stub.mkdir(exist_ok=True)
        (stub / "__init__.py").write_text(
            '"""Stub: sphn is not available on Intel Mac. Demucs falls back to ffmpeg."""\n'
            'def read(*a, **k):\n    raise RuntimeError("sphn not available")\n'
            'def write(*a, **k):\n    raise RuntimeError("sphn not available")\n')
    else:
        pip(py, "demucs", "deepfilternet", "soundfile", "imageio-ffmpeg", "numpy<2")

    print("== [3/6] FFmpeg", flush=True)
    (W / "bin").mkdir()
    ff = W / "bin" / ("ffmpeg.exe" if is_win else "ffmpeg")
    run([py, "-c", "import imageio_ffmpeg,shutil,sys;"
         "shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), sys.argv[1])", ff])
    if not is_win:
        ff.chmod(0o755)
    run([py, "-m", "pip", "uninstall", "-y", "imageio-ffmpeg"])

    print("== [4/6] AI models", flush=True)
    env = dict(os.environ)
    env["TORCH_HOME"] = str(W / "models" / "torch")
    env["HF_HOME"] = str(W / "models" / "hf")
    (W / "models" / "torch").mkdir(parents=True)
    (W / "models" / "hf").mkdir(parents=True)
    run([py, "-c", "from demucs.pretrained import get_model; get_model('htdemucs')"], env=env)
    run([py, "-c", "import shutil,sys; from df.enhance import maybe_download_model;"
         "p=maybe_download_model('DeepFilterNet3');"
         "shutil.copytree(p, sys.argv[1], dirs_exist_ok=True)", W / "models" / "DeepFilterNet3"], env=env)
    total = sum(f.stat().st_size for f in (W / "models").rglob("*") if f.is_file())
    if total < 100 * 1024 * 1024:
        sys.exit("Models theek se download nahi hue (size bohat chhota).")
    print("symlinks -> files:", flatten_symlinks(W / "models"), flush=True)

    if is_win:
        try:
            download("https://aka.ms/vs/17/release/vc_redist.x64.exe", W / "vc_redist.x64.exe")
        except Exception as e:  # noqa: BLE001
            print("vc_redist download fail (zaroori nahi):", e)

    print("== [5/6] Test", flush=True)
    run([py, ENGINE, "--check", "--runtime", W])
    test_wav = WORK / "test.wav"
    run([ff, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", test_wav])
    out = WORK / f"testout_{pid}"
    run([py, ENGINE, test_wav, "-o", out, "--ffmpeg", ff, "--runtime", W])
    for n in ("test_voice_clean.wav", "test_music.wav", "test_voice_original.wav"):
        if not (out / n).exists():
            sys.exit("Test fail: " + n + " nahi bani")

    print("== [6/6] Pack", flush=True)
    if is_win:
        left = find_symlinks(W)
        if left:
            sys.exit("Windows pack mein symlinks bache hain: " + ", ".join(map(str, left[:5])))
    make_pack(W, pid, version)
    shutil.rmtree(W, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True, choices=["win-cpu", "win-gpu", "mac-arm64", "mac-x64"])
    ap.add_argument("--version", required=True)
    a = ap.parse_args()
    print("platform:", platform.platform(), flush=True)
    build(a.id, a.version)
