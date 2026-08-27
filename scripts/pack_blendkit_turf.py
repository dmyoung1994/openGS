#!/usr/bin/env python3
"""Pack baked Blendkit turf maps into the runtime two-texture layout.

Each source bake contains separate base color, roughness, tangent normal, and
height images. The WebGPU terrain shader keeps two texture reads per tier, so
the runtime layout is:

  *_alb.png: RGB = sRGB base color, A = linear roughness
  *_nrh.png: RG = OpenGL normal XY, B = normalized height, A = canopy AO

The AO channel defaults to white because the source material bakes are flat
planes: directional canopy occlusion is computed from the height field in the
terrain shader instead of baking a false shadow pattern into the albedo.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def gray(path: Path, size: tuple[int, int]) -> Image.Image:
    image = Image.open(path).convert("L")
    if image.size != size:
        raise SystemExit(f"{path}: expected {size}, got {image.size}")
    return image


def normal_from_height_if_flat(normal: Image.Image, height: Image.Image,
                               tile_m: float, canopy_m: float) -> Image.Image:
    """Retain an authored normal, or derive one when the source exported dead flat."""
    source = np.asarray(normal, dtype=np.uint8)
    if np.ptp(source[:, :, 0]) > 2 or np.ptp(source[:, :, 1]) > 2:
        return normal

    # A small prefilter keeps single-pixel procedural salt from becoming a noisy
    # normal field. Central differences then convert the normalized source height to
    # the material's real canopy depth over its declared physical texel spacing.
    filtered = height.filter(ImageFilter.GaussianBlur(radius=1.25))
    h = np.asarray(filtered, dtype=np.float32) / 255.0
    texel_m = tile_m / height.width
    slope_scale = canopy_m / (2.0 * texel_m)
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * slope_scale
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * slope_scale
    nx, ny, nz = -dx, -dy, np.ones_like(h)
    inv_length = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    encoded = np.stack((nx * inv_length, ny * inv_length, nz * inv_length), axis=2)
    encoded = np.clip(np.rint((encoded * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)
    return Image.fromarray(encoded, mode="RGB")


def pack(source: Path, output: Path, source_name: str, output_name: str,
         tile_m: float, canopy_m: float) -> None:
    base = Image.open(source / f"{source_name}_basecolor.png").convert("RGB")
    size = base.size
    rough_path = source / f"{source_name}_roughness.png"
    if not rough_path.exists():
        rough_path = source / f"{source_name}_rough.png"
    normal_path = source / f"{source_name}_normal.png"
    if not normal_path.exists():
        normal_path = source / f"{source_name}_nor.png"
    rough = gray(rough_path, size)
    normal = Image.open(normal_path).convert("RGB")
    if normal.size != size:
        raise SystemExit(f"{source / f'{source_name}_normal.png'}: expected {size}, got {normal.size}")
    height = gray(source / f"{source_name}_height.png", size)
    normal = normal_from_height_if_flat(normal, height, tile_m, canopy_m)
    ao = Image.new("L", size, 255)

    alb = Image.merge("RGBA", (*base.split(), rough))
    nx, ny, _ = normal.split()
    nrh = Image.merge("RGBA", (nx, ny, height, ao))
    output.mkdir(parents=True, exist_ok=True)
    alb.save(output / f"blendkit_{output_name}_alb.png", format="PNG", optimize=True)
    nrh.save(output / f"blendkit_{output_name}_nrh.png", format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fairway-source", type=Path,
                        help="directory containing the fairway bake")
    parser.add_argument("--fairway-name", default="fairway",
                        help="basename of the fairway bake files")
    parser.add_argument("--green-source", type=Path,
                        help="directory containing the Golf Bentgrass bake")
    parser.add_argument("--green-name", default="green",
                        help="basename of the green bake files")
    args = parser.parse_args()
    pack(args.fairway_source or args.source, args.output, args.fairway_name, "fairway", 1.8, 0.011)
    pack(args.green_source or args.source, args.output, args.green_name, "green", 1.5, 0.004)


if __name__ == "__main__":
    main()
