#!/usr/bin/env python3
"""Pack the pinned Poly Haven Forest Ground 03 2K sources into two RGBA maps."""

import argparse
from pathlib import Path
from PIL import Image


def rgba(path: Path) -> Image.Image:
    image = Image.open(path).convert("RGB")
    if image.size != (2048, 2048):
        raise SystemExit(f"{path} must be the official 2048x2048 source")
    return image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    source = args.source_dir
    output = args.output_dir
    output.mkdir(parents=True, exist_ok=True)

    diffuse = rgba(source / "forrest_ground_03_diff_2k.jpg")
    normal = rgba(source / "forrest_ground_03_nor_gl_2k.jpg")
    arm = rgba(source / "forrest_ground_03_arm_2k.jpg")
    height = rgba(source / "forrest_ground_03_disp_2k.jpg")

    color_roughness = Image.merge("RGBA", (*diffuse.split(), arm.getchannel("G")))
    normal_height_ao = Image.merge("RGBA", (
        normal.getchannel("R"), normal.getchannel("G"),
        height.getchannel("R"), arm.getchannel("R"),
    ))
    color_roughness.save(output / "forrest_ground_03_color_roughness_2k.png", optimize=True)
    normal_height_ao.save(output / "forrest_ground_03_normal_height_ao_2k.png", optimize=True)


if __name__ == "__main__":
    main()
