#!/usr/bin/env python3
"""Validate the checked-in maintained-turf derivative contract.

This is intentionally a read-only gate. It does not download Blendkit material,
invoke Blender, rewrite images, or infer a license. The source/version/provenance
record stays in docs/blendkit-turf-provenance.md; this script verifies that the
runtime derivatives still have the channel layout and hashes that Terrain.js was
authored against.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path


RUNTIME_MAPS = {
    "blendkit_fairway_alb.png": "ecfa186e0296084e044f4143465e36c6836d81c22f9475901d5c1c347f7ec4c2",
    "blendkit_fairway_nrh.png": "6a5a70cb1c15e2cc3477928f42897cbdcb64e7c1c1d0d2c2f152a4dd6fca4db5",
    "blendkit_green_alb.png": "502dcafa3446fe49774093effd914e507905dabf6ea6088ea2c71928873af73b",
    "blendkit_green_nrh.png": "820a6fc5c3be0a271ac95975e42f4cf079627d2aa88017192044cd485fa96668",
}

PROVENANCE_MARKERS = (
    "5b9e35dc-d8e7-4e16-a038-b48d5b8a925f",
    "34a832ef-bb9d-4213-89e9-9143b137d99e",
    "Royalty Free",
    "blendkit_fairway_alb.png",
    "blendkit_green_nrh.png",
)


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
    provenance_path = root / "docs/blendkit-turf-provenance.md"

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

    if not provenance_path.is_file():
        errors.append(f"missing provenance record: {provenance_path}")
    else:
        provenance = provenance_path.read_text(encoding="utf-8")
        for marker in PROVENANCE_MARKERS:
            if marker not in provenance:
                errors.append(f"provenance record is missing marker: {marker}")

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
