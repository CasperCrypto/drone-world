"""optimize-textures.py — makes the fetched textures small enough for the web.

Does: converts every colour, normal and ARM map in web/assets/textures from
JPEG/PNG to WebP (colour q82, ARM q85, normal q92 because normals show
blocking first), deletes the originals and points manifest.json at the new
files.
Does NOT: change resolution or content. Run after tools/fetch-assets.mjs.

Usage: python3 tools/optimize-textures.py    (needs Pillow)
"""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / "web" / "assets" / "textures"
QUALITY = {"diff": 82, "arm": 85, "nor_gl": 92}


def main():
    manifest_path = TEX / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    before = after = 0
    for slot in manifest["slots"].values():
        for kind, rel in slot["files"].items():
            src = TEX / rel
            if src.suffix == ".webp":
                continue
            dst = src.with_suffix(".webp")
            img = Image.open(src).convert("RGB")
            img.save(dst, "WEBP", quality=QUALITY[kind], method=6)
            before += src.stat().st_size
            after += dst.stat().st_size
            src.unlink()
            slot["files"][kind] = str(dst.relative_to(TEX))
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
