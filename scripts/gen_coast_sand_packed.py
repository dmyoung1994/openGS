#!/usr/bin/env python3
"""Pack the pinned coast albedo RGB and roughness L into one lossless RGBA texture."""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "public/assets/materials/aerial_beach_01"
ALBEDO = ASSET_DIR / "aerial_beach_01_diff_2k.jpg"
ROUGHNESS = ASSET_DIR / "aerial_beach_01_rough_2k.jpg"
OUTPUT = ASSET_DIR / "aerial_beach_01_diff_rough_2k.png"


def main() -> None:
    with Image.open(ALBEDO) as albedo_source, Image.open(ROUGHNESS) as roughness_source:
        albedo = albedo_source.convert("RGB")
        roughness = roughness_source.convert("L")
        if albedo.size != (2048, 2048) or roughness.size != albedo.size:
            raise ValueError("Coast source maps must remain registered 2048x2048 images")
        red, green, blue = albedo.split()
        packed = Image.merge("RGBA", (red, green, blue, roughness))
        packed.save(OUTPUT, format="PNG", optimize=True, compress_level=9)
    print(OUTPUT)


if __name__ == "__main__":
    main()
