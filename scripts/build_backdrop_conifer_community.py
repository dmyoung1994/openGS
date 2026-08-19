#!/usr/bin/env python3
"""Build the bounded far-forest community atlas from the verified tree atlas.

This is an offline, deterministic alpha composition step.  It does not bake
lighting or normals: the result remains a neutral albedo/alpha source for the
runtime MeshStandardNodeMaterial.  Several source crowns are overlapped in
each 512px frame so a single instanced card represents a small, irregular age
class rather than an isolated open-crowned pole.
"""

from __future__ import annotations

import argparse
import hashlib
import random
from pathlib import Path

from PIL import Image, ImageOps


VERSION = "backdrop-community-impostor-v1"
TILE = 512
COLS = 4
ROWS = 2


def source_frames(source: Image.Image) -> list[Image.Image]:
    source = source.convert("RGBA")
    frames: list[Image.Image] = []
    for row in range(ROWS):
        for col in range(COLS):
            tile = source.crop((col * TILE, row * TILE, (col + 1) * TILE, (row + 1) * TILE))
            bounds = tile.getchannel("A").getbbox()
            if bounds is None:
                raise ValueError(f"source frame {col},{row} has no alpha")
            # Tight crops preserve transparent gutters in the output tile and
            # make the placement recipe independent of source padding.
            frames.append(tile.crop(bounds))
    return frames


def compose_frame(source: Image.Image, frame: int) -> Image.Image:
    rng = random.Random(0xC01F3E + frame * 0x9E3779B1)
    out = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    # Back-to-front age classes: a tall central leader, irregular middle
    # trees, then two low foreground crowns.  The small horizontal overlap is
    # intentional; it makes continuous thickets while leaving alpha gutters
    # around the community silhouette.
    recipe = [
        (0.72, -0.02, 0.95),
        (0.62, -0.27, 0.92),
        (0.59, 0.25, 0.90),
        (0.49, -0.42, 0.87),
        (0.46, 0.40, 0.86),
        (0.34, -0.10, 0.76),
        (0.31, 0.15, 0.72),
    ]
    for scale, x_bias, y_bias in recipe:
        # Use source-derived variation without changing the albedo response.
        # Mirroring changes the silhouette while keeping the same material.
        tree = ImageOps.mirror(source) if rng.random() > 0.52 else source
        scale *= 0.94 + rng.random() * 0.12
        width = max(1, round(tree.width * scale))
        height = max(1, round(tree.height * scale))
        tree = tree.resize((width, height), Image.Resampling.LANCZOS)
        jitter_x = rng.uniform(-0.035, 0.035) * TILE
        jitter_y = rng.uniform(-0.018, 0.018) * TILE
        left = round((TILE - width) * 0.5 + x_bias * TILE + jitter_x)
        # Align the source bases in a shallow, irregular forest floor.  A
        # handful of forward crowns rise into the gaps, preventing a flat row.
        bottom = round(TILE * (0.975 - (1.0 - y_bias) * 0.035) + jitter_y)
        out.alpha_composite(tree, (left, bottom - height))
    return out


def build(source_path: Path, output_path: Path) -> tuple[str, str]:
    source = Image.open(source_path)
    if source.size != (TILE * COLS, TILE * ROWS):
        raise ValueError(f"expected {TILE * COLS}x{TILE * ROWS} source, got {source.size}")
    frames = source_frames(source)
    atlas = Image.new("RGBA", source.size, (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        composed = compose_frame(frame, index)
        x = (index % COLS) * TILE
        y = (index // COLS) * TILE
        atlas.alpha_composite(composed, (x, y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path, format="PNG", optimize=True)
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    output_hash = hashlib.sha256(output_path.read_bytes()).hexdigest()
    return source_hash, output_hash


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("public/assets/trees/conifer_v3_impostor.png"))
    parser.add_argument("--output", type=Path, default=Path("public/assets/trees/conifer_community_v1_impostor.png"))
    args = parser.parse_args()
    source_hash, output_hash = build(args.source, args.output)
    print(f"version={VERSION}")
    print(f"source_sha256={source_hash}")
    print(f"output_sha256={output_hash}")


if __name__ == "__main__":
    main()
