#!/usr/bin/env python3
"""Build runtime Pine Tree 01 canonical meshes from the clean source.

This intentionally reads ``trees_src`` directly.  The old processed GLB is
not an input: its collapsed foliage contained the long, fan-shaped triangles
that tear in the WebGPU path.  Variant B is retained, semantic source roles
are sampled independently, and the result is one indexed, vertex-coloured
primitive with no source atlas sampling. ``--lod`` controls the authored
triangle budgets; both derivatives retain volumetric modeled needles and share
the same role ordering and grounding contract.
"""

from __future__ import annotations

import argparse
import json
import math
import mmap
import pathlib
import struct
from collections import defaultdict


# Mesh primitive, output role, maximum retained triangles. Near geometry is
# deliberately dense enough to preserve each needle tier while remaining below
# the former fir's ~510k-vertex payload; the middle derivative is the existing
# WebGPU budget and still has a volumetric crown.
ROLE_SPECS_BY_LOD = {
    0: (
        (0, "bark", 5_000),
        (1, "trunk", 3_000),
        (2, "foliage", 80_000),
        (3, "branches", 7_000),
    ),
    1: (
        (0, "bark", 7_000),
        (1, "trunk", 3_000),
        (2, "foliage", 16_000),
        (3, "branches", 3_000),
    ),
}
ROLE_COLORS = {
    "bark": (0.26, 0.14, 0.065, 1.0),
    "trunk": (0.31, 0.18, 0.085, 1.0),
    "branches": (0.22, 0.115, 0.045, 1.0),
    "foliage": (0.18, 0.39, 0.095, 1.0),
}
AREA_EPSILON = 1.0e-7
ASPECT_LIMIT = 64.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="clean source .gltf")
    parser.add_argument("--output", required=True, help="canonical output .glb")
    parser.add_argument("--lod", type=int, choices=(0, 1), default=1)
    return parser.parse_args()


def align4(value: int) -> int:
    return (value + 3) & ~3


def add_view(binary: bytearray, views: list[dict], payload: bytes, target: int | None = None) -> int:
    start = align4(len(binary))
    binary.extend(b"\0" * (start - len(binary)))
    binary.extend(payload)
    view = {"buffer": 0, "byteOffset": start, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


class Source:
    def __init__(self, gltf_path: pathlib.Path):
        self.gltf_path = gltf_path
        self.gltf = json.loads(gltf_path.read_text())
        uri = self.gltf["buffers"][0]["uri"]
        self.file = gltf_path.parent.joinpath(uri).open("rb")
        self.mm = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)

    def close(self) -> None:
        self.mm.close()
        self.file.close()

    def setup(self, accessor_index: int):
        accessor = self.gltf["accessors"][accessor_index]
        view = self.gltf["bufferViews"][accessor["bufferView"]]
        component = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}[accessor["componentType"]]
        components = {"SCALAR": 1, "VEC3": 3}[accessor["type"]]
        stride = view.get("byteStride", component[1] * components)
        begin = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return accessor, begin, stride, component[0], components

    def value(self, setup, index: int):
        accessor, begin, stride, fmt, components = setup
        return struct.unpack_from("<" + fmt * components, self.mm, begin + index * stride)


def triangle_safe(a, b, c) -> bool:
    edges = (math.dist(a, b), math.dist(b, c), math.dist(c, a))
    if min(edges) <= 1.0e-8:
        return False
    cross = (
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    )
    area = 0.5 * math.sqrt(sum(component * component for component in cross))
    return area > AREA_EPSILON and max(edges) / min(edges) <= ASPECT_LIMIT


def deterministic_random(state: int) -> int:
    # xorshift32, stable across Python versions and sufficient for sampling.
    state &= 0xFFFFFFFF
    state ^= (state << 13) & 0xFFFFFFFF
    state ^= state >> 17
    state ^= (state << 5) & 0xFFFFFFFF
    return state & 0xFFFFFFFF


def select_triangles(src: Source, primitive: dict, role: str, target: int) -> list[int]:
    positions = src.setup(primitive["attributes"]["POSITION"])
    indices = src.setup(primitive["indices"])
    index_count = indices[0]["count"]
    candidates: list[int] = []
    # Structural roles are authored as compact shells; keep every safe triangle.
    if index_count // 3 <= target:
        for triangle in range(0, index_count, 3):
            ids = [src.value(indices, triangle + offset)[0] for offset in range(3)]
            if triangle_safe(*(src.value(positions, index_id) for index_id in ids)):
                candidates.extend(ids)
        return candidates

    # The needle mesh is millions of triangles. Reservoirs per vertical band
    # retain an even, volumetric crown rather than a source-order clump. The
    # fixed band quota also prevents a rare upper tier from vanishing. Trunk is
    # smaller but uses the same path so its lower silhouette stays distributed.
    bounds = src.gltf["accessors"][primitive["attributes"]["POSITION"]]
    min_y, max_y = bounds["min"][1], bounds["max"][1]
    bands = 96 if role == "foliage" else 32
    quota = max(1, math.ceil(target / bands))
    reservoirs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    seen: dict[int, int] = defaultdict(int)
    for triangle in range(0, index_count, 3):
        ids = [src.value(indices, triangle + offset)[0] for offset in range(3)]
        points = [src.value(positions, index_id) for index_id in ids]
        if not triangle_safe(*points):
            continue
        y = sum(point[1] for point in points) / 3
        band = max(0, min(bands - 1, int((y - min_y) / max(max_y - min_y, 1.0e-6) * bands)))
        seen[band] += 1
        bucket = reservoirs[band]
        # Reservoir sampling is independent per band, deterministic, and uses
        # bounded memory while scanning the 12M-index source accessor.
        if len(bucket) < quota:
            bucket.append((triangle, seen[band]))
        else:
            slot = deterministic_random(triangle + band * 0x9E3779B9) % seen[band]
            if slot < quota:
                bucket[slot] = (triangle, seen[band])
    selected = [triangle for bucket in reservoirs.values() for triangle, _ in bucket]
    selected.sort()
    selected = selected[:target]
    for triangle in selected:
        candidates.extend(src.value(indices, triangle + offset)[0] for offset in range(3))
    return candidates


def main() -> None:
    args = parse_args()
    source_path = pathlib.Path(args.input).resolve()
    output_path = pathlib.Path(args.output).resolve()
    src = Source(source_path)
    try:
        mesh = src.gltf["meshes"][1]  # variant B; do not use a processed derivative
        role_indices: dict[str, list[int]] = {}
        role_sources: dict[str, tuple] = {}
        for primitive_index, role, target in ROLE_SPECS_BY_LOD[args.lod]:
            primitive = mesh["primitives"][primitive_index]
            role_sources[role] = primitive
            role_indices[role] = select_triangles(src, primitive, role, target)
            print(f"SOURCE_ROLE role={role} triangles={len(role_indices[role]) // 3}")

        # One rigid ground offset for every role. Variant B's trunk extends a
        # few centimetres below zero; moving all parts together preserves joints.
        # Sampling can omit the authored absolute lowest vertex. Ground the
        # retained mesh itself (one rigid offset for every semantic role), so
        # the runtime contract is exact even after reservoir selection.
        min_y = min(
            src.value(src.setup(primitive["attributes"]["POSITION"]), index)[1]
            for role, primitive in role_sources.items()
            for index in role_indices[role]
        )
        positions: list[tuple[float, float, float]] = []
        normals: list[tuple[float, float, float]] = []
        colors: list[tuple[float, float, float, float]] = []
        indices: list[int] = []
        # Keep role order visually stable: trunk/branches before the crown.
        for role in ("bark", "trunk", "branches", "foliage"):
            primitive = role_sources[role]
            pos_setup = src.setup(primitive["attributes"]["POSITION"])
            normal_setup = src.setup(primitive["attributes"]["NORMAL"])
            remap: dict[int, int] = {}
            for old in role_indices[role]:
                if old not in remap:
                    remap[old] = len(positions)
                    x, y, z = src.value(pos_setup, old)
                    positions.append((x, y - min_y, z))
                    normals.append(src.value(normal_setup, old))
                    colors.append(ROLE_COLORS[role])
                indices.append(remap[old])

        if len(indices) % 3:
            raise RuntimeError("canonical index stream is not triangles")
        bounds = (
            [min(point[axis] for point in positions) for axis in range(3)],
            [max(point[axis] for point in positions) for axis in range(3)],
        )
        binary = bytearray()
        views: list[dict] = []
        accessors: list[dict] = []

        def attribute(payload: bytes, count: int, typ: str, *, minmax=None) -> int:
            view = add_view(binary, views, payload, 34962)
            record = {"bufferView": view, "componentType": 5126, "count": count, "type": typ}
            if minmax is not None:
                record["min"], record["max"] = minmax
            accessors.append(record)
            return len(accessors) - 1

        position_accessor = attribute(b"".join(struct.pack("<3f", *point) for point in positions), len(positions), "VEC3", minmax=bounds)
        normal_accessor = attribute(b"".join(struct.pack("<3f", *normal) for normal in normals), len(normals), "VEC3")
        color_accessor = attribute(b"".join(struct.pack("<4f", *color) for color in colors), len(colors), "VEC4")
        # Near geometry is one canonical primitive, so a dense crown can exceed
        # the 16-bit vertex limit without reintroducing a second GPU draw. Use
        # the glTF/WebGPU-supported uint32 index component when required.
        index_component = "I" if len(positions) >= 65536 else "H"
        index_type = 5125 if index_component == "I" else 5123
        index_view = add_view(binary, views, struct.pack("<" + index_component * len(indices), *indices), 34963)
        accessors.append({"bufferView": index_view, "componentType": index_type, "count": len(indices), "type": "SCALAR"})
        index_accessor = len(accessors) - 1

        # Include source textures as embedded, unused provenance payloads. The
        # canonical primitive deliberately has no UV/map, avoiding atlas seams.
        images = []
        for image in src.gltf.get("images", []):
            image_path = source_path.parent.joinpath(image["uri"]).resolve()
            payload = image_path.read_bytes()
            image_view = add_view(binary, views, payload)
            images.append({"name": image.get("name", image_path.stem), "mimeType": image["mimeType"], "bufferView": image_view})

        output = {
            "asset": {"version": "2.0", "generator": "build_pine_canonical.py@2"},
            "scene": 0,
            "scenes": [{"name": "Scene", "nodes": [0]}],
            "nodes": [{"mesh": 0, "name": f"pine_tree_01_canonical_lod{args.lod}"}],
            "meshes": [{"name": f"pine_tree_01_canonical_lod{args.lod}", "primitives": [{
                "attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor, "COLOR_0": color_accessor},
                "indices": index_accessor, "material": 0,
            }]}],
            "materials": [{"name": "pine_tree_01_canonical", "doubleSided": True, "pbrMetallicRoughness": {
                "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.92,
            }}],
            "images": images,
            "buffers": [{"byteLength": len(binary)}],
            "bufferViews": views,
            "accessors": accessors,
            "extras": {
                "sourceAsset": "polyhaven-pine-tree-01",
                "sourceVariant": "b",
                "sourceUrl": "https://polyhaven.com/a/pine_tree_01",
                "lod": args.lod,
                "roles": ["bark", "trunk", "branches", "foliage"],
                "materialMode": "source-role-vertex-colors",
            },
        }
        json_chunk = json.dumps(output, separators=(",", ":"), ensure_ascii=False).encode()
        json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
        binary_chunk = bytes(binary) + b"\0" * ((4 - len(binary) % 4) % 4)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("wb") as handle:
            handle.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)))
            handle.write(struct.pack("<II", len(json_chunk), 0x4E4F534A)); handle.write(json_chunk)
            handle.write(struct.pack("<II", len(binary_chunk), 0x004E4942)); handle.write(binary_chunk)
        print(f"CANONICAL_DONE vertices={len(positions)} triangles={len(indices) // 3} bytes={output_path.stat().st_size}")
    finally:
        src.close()


if __name__ == "__main__":
    main()
