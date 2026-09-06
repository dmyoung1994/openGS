#!/usr/bin/env python3
"""Pack pinned ambientCG Grass005 maps into the maintained-fairway layout.

Acquire and extract the official lossless source archive first:

  curl -L 'https://ambientcg.com/get?file=Grass005_2K-PNG.zip' -o /tmp/Grass005_2K-PNG.zip
  unzip /tmp/Grass005_2K-PNG.zip -d /tmp/Grass005_2K-PNG
  python3 scripts/pack_ambientcg_grass005.py /tmp/Grass005_2K-PNG

The historical ``blendkit_fairway_*`` names remain stable runtime bindings.

Output channels:
  blendkit_fairway_alb.png: RGB = source sRGB color, A = source roughness
  blendkit_fairway_nrh.png: RG = source OpenGL normal XY, B = displacement, A = AO
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image


ASSET = "Grass005_2K-PNG"
EXPECTED_SHA256 = {
    "Color": "c27fd2fb5bc29403545d08167fcb76271087c1fb1ffcbb63b9b3a4c47258f4f9",
    "NormalGL": "64364bc8b3cec8c35a7f1c835e4158cbc32c2cf5dad59c06efa702012ac4911d",
    "Displacement": "574bfd9268212e30fdcfb6f06b561bd220c66d81178dadeeee66da3f777df3d0",
    "Roughness": "2e05a1d2895ee51a013ed4e5915a1767ff08c6bb342463d723ae4483eb46d462",
    "AmbientOcclusion": "efa6181b02fe9e1f1af52ee604e8ef890de6261ec6b4225d214c96acfef1a719",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_path(source: Path, channel: str) -> Path:
    path = source / f"{ASSET}_{channel}.png"
    expected = EXPECTED_SHA256[channel]
    actual = sha256(path)
    if actual != expected:
        raise SystemExit(f"{path.name}: expected sha256 {expected}, got {actual}")
    return path


def displacement_u8(path: Path) -> Image.Image:
    source = Image.open(path)
    values = np.asarray(source)
    if source.mode != "I;16" or values.dtype != np.uint16:
        raise SystemExit(f"{path.name}: expected a 16-bit grayscale displacement map")
    packed = ((values.astype(np.uint32) + 128) // 257).astype(np.uint8)
    return Image.fromarray(packed, mode="L")


def channel_mean(image: Image.Image, channel: int = 0) -> float:
    values = np.asarray(image, dtype=np.float64)
    if values.ndim == 3:
        values = values[:, :, channel]
    return float(values.mean() / 255.0)


def linear_luminance_mean(image: Image.Image) -> float:
    srgb = np.asarray(image, dtype=np.float64) / 255.0
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    return float((linear * np.array([0.2126, 0.7152, 0.0722])).sum(axis=2).mean())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="extracted official Grass005_2K-PNG directory")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "public/assets/textures",
    )
    args = parser.parse_args()

    color = Image.open(source_path(args.source, "Color")).convert("RGB")
    normal = Image.open(source_path(args.source, "NormalGL")).convert("RGB")
    displacement = displacement_u8(source_path(args.source, "Displacement"))
    roughness = Image.open(source_path(args.source, "Roughness")).convert("L")
    ao = Image.open(source_path(args.source, "AmbientOcclusion")).convert("L")
    images = (color, normal, displacement, roughness, ao)
    if any(image.size != (2048, 2048) for image in images):
        raise SystemExit("Grass005 2K source maps must all be exactly 2048x2048")

    args.output.mkdir(parents=True, exist_ok=True)
    r, g, b = color.split()
    Image.merge("RGBA", (r, g, b, roughness)).save(
        args.output / "blendkit_fairway_alb.png", format="PNG", compress_level=9
    )
    nx, ny, _ = normal.split()
    Image.merge("RGBA", (nx, ny, displacement, ao)).save(
        args.output / "blendkit_fairway_nrh.png", format="PNG", compress_level=9
    )

    print(f"linearAlbedoMean={linear_luminance_mean(color):.8f}")
    print(
        "farMean="
        f"[{channel_mean(displacement):.8f}, {channel_mean(ao):.8f}, {channel_mean(roughness):.8f}]"
    )
    for name in ("blendkit_fairway_alb.png", "blendkit_fairway_nrh.png"):
        path = args.output / name
        print(f"{name} {path.stat().st_size} bytes sha256={sha256(path)}")


if __name__ == "__main__":
    main()
