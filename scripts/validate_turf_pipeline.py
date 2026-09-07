#!/usr/bin/env python3
"""Validate the checked-in maintained-turf derivative contract.

This is intentionally a read-only gate. It does not download source material,
rewrite images, or infer a license. The source/version/provenance records stay in
docs; this script verifies that the runtime derivatives still have the channel
layout and hashes that Terrain.js was authored against.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path


RUNTIME_MAPS = {
    "blendkit_fairway_alb.png": "129d315bbc22e6ff05a6fb5a3c54474ec9845b86afbdf615a4e8a21f996cdc76",
    "blendkit_fairway_nrh.png": "300200a8f864dd383ba05dc8688e97196081419d06005362dd45b7a334932970",
    "blendkit_green_alb.png": "502dcafa3446fe49774093effd914e507905dabf6ea6088ea2c71928873af73b",
    "blendkit_green_nrh.png": "820a6fc5c3be0a271ac95975e42f4cf079627d2aa88017192044cd485fa96668",
}

PROVENANCE_RECORDS = {
    "blendkit-turf-provenance.md": (
        "34a832ef-bb9d-4213-89e9-9143b137d99e",
        "Royalty Free",
        "blendkit_green_nrh.png",
    ),
    "ambientcg-grass005-fairway-provenance.md": (
        "Grass005",
        "Creative Commons CC0 1.0 Universal",
        "1.20 m × 1.20 m",
        "blendkit_fairway_alb.png",
    ),
}


def png_header(path: Path) -> tuple[int, int, int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("invalid PNG signature")
    length = struct.unpack(">I", data[8:12])[0]
    if data[12:16] != b"IHDR" or length != 13:
        raise ValueError("missing PNG IHDR")
    width, height, depth, color_type = struct.unpack(">IIBB", data[16:26])
    return width, height, depth, color_type


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(root: Path) -> dict[str, object]:
    errors: list[str] = []
    texture_root = root / "public/assets/textures"

    maps: dict[str, object] = {}
    for name, expected_hash in RUNTIME_MAPS.items():
        path = texture_root / name
        if not path.is_file():
            errors.append(f"missing runtime derivative: {path}")
            continue
        try:
            width, height, depth, color_type = png_header(path)
        except (OSError, ValueError) as error:
            errors.append(f"{name}: {error}")
            continue
        actual_hash = sha256(path)
        maps[name] = {
            "width": width,
            "height": height,
            "bitDepth": depth,
            "colorType": color_type,
            "sha256": actual_hash,
        }
        if (width, height, depth, color_type) != (2048, 2048, 8, 6):
            errors.append(f"{name}: expected 2048² 8-bit RGBA, got {width}x{height} depth={depth} type={color_type}")
        if actual_hash != expected_hash:
            errors.append(f"{name}: SHA-256 changed; re-bake only through the pinned deterministic pipeline")

    for name, markers in PROVENANCE_RECORDS.items():
        provenance_path = root / "docs" / name
        if not provenance_path.is_file():
            errors.append(f"missing provenance record: {provenance_path}")
            continue
        provenance = provenance_path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in provenance:
                errors.append(f"{name} is missing marker: {marker}")

    return {"ok": not errors, "maps": maps, "errors": errors}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    result = validate(args.root.resolve())
    if args.as_json:
        print(json.dumps(result, indent=2, sort_keys=True))
    elif result["ok"]:
        print(f"validated {len(result['maps'])} maintained-turf derivatives")
    else:
        for error in result["errors"]:
            print(f"ERROR: {error}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
