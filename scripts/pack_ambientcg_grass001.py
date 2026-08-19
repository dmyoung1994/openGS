#!/usr/bin/env python3
"""Pack ambientCG Grass001 1K JPG maps into the production two-sample turf layout.

Download and extract the pinned official archive first:

  curl -L 'https://ambientcg.com/get?file=Grass001_1K-JPG.zip' -o /tmp/Grass001_1K-JPG.zip
  unzip /tmp/Grass001_1K-JPG.zip -d /tmp/Grass001_1K-JPG
  python3 scripts/pack_ambientcg_grass001.py /tmp/Grass001_1K-JPG

Output channels:
  turfdetail_alb.png: RGB = sRGB color, A = linear roughness
  turfdetail_nrh.png: RG = OpenGL normal XY, B = displacement, A = ambient occlusion

The runtime already reads one albedo and one NRH texel. Packing roughness into the
otherwise-unused albedo alpha adds no texture, sample, pass, or runtime allocation.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from PIL import Image


ASSET = "Grass001_1K-JPG"
EXPECTED_SHA256 = {
    "Color": "b9b6d61bc3b6137b868a3447eef18737896acd26d58fe2f4b83ce8c0e9d3f8ad",
    "NormalGL": "eef0b56db5f00a6fcb3d0e0f8463e4e141e88aa85b26527a04d617b75a4ab5d2",
    "Displacement": "1879e4fb292a6c091b73366b4b92b2cccff4dcf150b3f34c8943aea26d52ae53",
    "Roughness": "8810effd44756341170d551501b7d0c645dc2395dbce46a8c7f1e61045258a06",
    "AmbientOcclusion": "a5e6e6a1c4329562e99f009313f09e44dd179dedbfb5dd679feeaf17ca122ab9",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_path(source: Path, channel: str) -> Path:
    path = source / f"{ASSET}_{channel}.jpg"
    expected = EXPECTED_SHA256[channel]
    actual = sha256(path)
    if actual != expected:
        raise SystemExit(f"{path.name}: expected sha256 {expected}, got {actual}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="extracted official Grass001_1K-JPG directory")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "public/assets/textures",
    )
    args = parser.parse_args()

    color = Image.open(source_path(args.source, "Color")).convert("RGB")
    normal = Image.open(source_path(args.source, "NormalGL")).convert("RGB")
    displacement = Image.open(source_path(args.source, "Displacement")).convert("L")
    roughness = Image.open(source_path(args.source, "Roughness")).convert("L")
    ao = Image.open(source_path(args.source, "AmbientOcclusion")).convert("L")
    images = (color, normal, displacement, roughness, ao)
    if any(image.size != (1024, 1024) for image in images):
        raise SystemExit("Grass001 1K source maps must all be exactly 1024x1024")

    args.output.mkdir(parents=True, exist_ok=True)
    r, g, b = color.split()
    Image.merge("RGBA", (r, g, b, roughness)).save(
        args.output / "turfdetail_alb.png", format="PNG", compress_level=9
    )
    nx, ny, _ = normal.split()
    Image.merge("RGBA", (nx, ny, displacement, ao)).save(
        args.output / "turfdetail_nrh.png", format="PNG", compress_level=9
    )

    for name in ("turfdetail_alb.png", "turfdetail_nrh.png"):
        path = args.output / name
        print(f"{name} {path.stat().st_size} bytes sha256={sha256(path)}")


if __name__ == "__main__":
    main()
