#!/usr/bin/env python3
"""Pack the generated fresh pine-straw albedo into registered terrain PBR maps."""

import argparse
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps


SIZE = 2048


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if "_albedo_" not in args.source.stem:
        raise SystemExit("source filename must contain _albedo_")
    color_name = args.source.stem.replace("_albedo_", "_color_roughness_") + ".png"
    normal_name = args.source.stem.replace("_albedo_", "_normal_height_ao_") + ".png"

    albedo = Image.open(args.source).convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    height = ImageOps.autocontrast(
        ImageOps.grayscale(albedo).filter(ImageFilter.GaussianBlur(0.8)), cutoff=1,
    )
    normal_x = height.filter(ImageFilter.Kernel(
        (3, 3), (-1, 0, 1, -2, 0, 2, -1, 0, 1), scale=7, offset=128,
    ))
    normal_y = height.filter(ImageFilter.Kernel(
        (3, 3), (-1, -2, -1, 0, 0, 0, 1, 2, 1), scale=7, offset=128,
    ))
    roughness = height.point(lambda value: 240 - round(value * 0.10))
    ao = height.filter(ImageFilter.GaussianBlur(2.5)).point(
        lambda value: 166 + round(value * 0.35),
    )

    Image.merge("RGBA", (*albedo.split(), roughness)).save(
        args.output_dir / color_name, optimize=True,
    )
    Image.merge("RGBA", (normal_x, normal_y, height, ao)).save(
        args.output_dir / normal_name, optimize=True,
    )


if __name__ == "__main__":
    main()
