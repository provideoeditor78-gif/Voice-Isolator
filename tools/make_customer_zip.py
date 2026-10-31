#!/usr/bin/env python3
"""Customer ke liye chhota panel zip banata hai (baseUrl khud likh deta hai).

  python tools/make_customer_zip.py --base-url https://github.com/USER/REPO/releases/latest/download/ --version 1.0.0
"""
import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def build(base_url, version):
    DIST.mkdir(exist_ok=True)
    top = f"VoiceIsolator_Panel_v{version}"
    out = DIST / f"{top}.zip"
    cfg_path = ROOT / "panel" / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
    cfg["baseUrl"] = base_url if base_url.endswith("/") else base_url + "/"

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((ROOT / "panel").rglob("*")):
            if f.is_dir() or "__pycache__" in f.parts or f.name == ".debug":
                continue
            rel = f.relative_to(ROOT / "panel").as_posix()
            if rel == "config.json":
                z.writestr(f"{top}/panel/config.json", json.dumps(cfg, indent=2))
            else:
                z.write(f, f"{top}/panel/{rel}")
        for f in sorted((ROOT / "installers").iterdir()):
            data = f.read_bytes()
            info = zipfile.ZipInfo(f"{top}/{f.name}")
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if f.suffix == ".command" else 0o644) << 16
            z.writestr(info, data)
    print("customer zip:", out)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--version", required=True)
    a = ap.parse_args()
    build(a.base_url, a.version)
