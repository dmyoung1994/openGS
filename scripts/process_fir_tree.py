#!/usr/bin/env python3
"""Build compact, role-preserving derivatives of Poly Haven Fir Tree 01.

The downloaded source intentionally contains three authored mature silhouettes
side by side.  This baker reads the source accessors directly (no Blender
round-trip), rejects degenerate/needle-thin triangles, and emits one indexed
Float32 canonical primitive per variant and LOD.  The runtime canonical pair is
variant A; the B/C derivatives remain beside it as audited source variants for
future variant selection without changing the current three-draw contract.

Usage::

    python3 scripts/process_fir_tree.py \
      --input public/assets/trees_src/fir_tree_01/fir_tree_01_1k.gltf \
      --output-dir public/assets/trees
"""

from __future__ import annotations

import argparse
import json
import math
import mmap
import pathlib
import struct
from collections import defaultdict


ROLE_ORDER = ("bark", "trunk", "foliage", "branches")
ROLE_SPECS = ((0, "bark"), (1, "trunk"), (2, "foliage"), (3, "branches"))
ROLE_COLORS = {
    # Linear-light diffuse reflectance, not display/sRGB colour. The first bake
    # used display-like 0.17/0.34 values and ACES rendered the firs neon green.
    "bark": (0.070, 0.035, 0.014, 1.0),
    "trunk": (0.090, 0.046, 0.018, 1.0),
    "foliage": (0.038, 0.105, 0.020, 1.0),
    "branches": (0.060, 0.028, 0.010, 1.0),
}
ROLE_BUDGETS = {
    # The original 24k/5.2k foliage quotas retained only a few percent of the
    # source needle area: the tree read as a trunk with wire twigs in the viewer.
    # Preserve the licensed source's dense modeled crown at both perception-
    # sensitive ranges. These are still finite indexed derivatives, not runtime
    # procedural geometry or alpha-card substitutes.
    0: {"bark": 5_000, "trunk": 2_000, "foliage": 180_000, "branches": 5_000},
    1: {"bark": 1_000, "trunk": 600, "foliage": 60_000, "branches": 1_000},
}
AREA_EPSILON = 1.0e-7
ASPECT_LIMIT = 64.0
# The fir's authored needle sheets are intentionally long and narrow. Applying
# the structural aspect/area rejection to that role removed the very foliage
# surfaces that make the source crown read as a crown, leaving only wire-like
# twigs. Keep the structural guard for bark/trunk/branches, but retain valid
# source needle sheets with a much wider (still finite) tolerance.
FOLIAGE_AREA_EPSILON = 1.0e-10
FOLIAGE_ASPECT_LIMIT = 2048.0


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def align4(value: int) -> int:
    return (value + 3) & ~3


class Source:
    def __init__(self, path: pathlib.Path):
        self.path = path
        self.gltf = json.loads(path.read_text(encoding="utf-8"))
        uri = self.gltf["buffers"][0]["uri"]
        self.handle = path.parent.joinpath(uri).open("rb")
        self.mm = mmap.mmap(self.handle.fileno(), 0, access=mmap.ACCESS_READ)

    def close(self) -> None:
        self.mm.close()
        self.handle.close()

    def setup(self, accessor_index: int):
        accessor = self.gltf["accessors"][accessor_index]
        view = self.gltf["bufferViews"][accessor["bufferView"]]
        component = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}[accessor["componentType"]]
        components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        stride = view.get("byteStride", component[1] * components)
        begin = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return accessor, begin, stride, component[0], components

    def value(self, setup, index: int):
        accessor, begin, stride, fmt, components = setup
        return struct.unpack_from("<" + fmt * components, self.mm, begin + index * stride)


def triangle_safe(a, b, c, *, area_epsilon=AREA_EPSILON, aspect_limit=ASPECT_LIMIT) -> bool:
    if not all(math.isfinite(component) for point in (a, b, c) for component in point):
        return False
    edges = (math.dist(a, b), math.dist(b, c), math.dist(c, a))
    if min(edges) <= 1.0e-8:
        return False
    cross = (
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    )
    area = 0.5 * math.sqrt(sum(component * component for component in cross))
    return area > area_epsilon and max(edges) / min(edges) <= aspect_limit


def rng32(value: int) -> int:
    value &= 0xFFFFFFFF
    value ^= (value << 13) & 0xFFFFFFFF
    value ^= value >> 17
    value ^= (value << 5) & 0xFFFFFFFF
    return value & 0xFFFFFFFF


def select_triangles(source: Source, primitive: dict, role: str, target: int) -> list[int]:
    positions = source.setup(primitive["attributes"]["POSITION"])
    indices = source.setup(primitive["indices"])
    count = indices[0]["count"]
    bounds = source.gltf["accessors"][primitive["attributes"]["POSITION"]]
    min_y, max_y = bounds["min"][1], bounds["max"][1]
    bands = 96 if role == "foliage" else 32
    quota = max(1, math.ceil(target / bands))
    reservoirs: dict[int, list[int]] = defaultdict(list)
    seen: dict[int, int] = defaultdict(int)
    for triangle in range(0, count, 3):
        ids = [source.value(indices, triangle + offset)[0] for offset in range(3)]
        points = [source.value(positions, index) for index in ids]
        if not triangle_safe(
            *points,
            area_epsilon=FOLIAGE_AREA_EPSILON if role == "foliage" else AREA_EPSILON,
            aspect_limit=FOLIAGE_ASPECT_LIMIT if role == "foliage" else ASPECT_LIMIT,
        ):
            continue
        band = max(0, min(bands - 1, int((sum(point[1] for point in points) / 3 - min_y) / max(max_y - min_y, 1e-6) * bands)))
        seen[band] += 1
        bucket = reservoirs[band]
        if len(bucket) < quota:
            bucket.append(triangle)
        else:
            slot = rng32(triangle + band * 0x9E3779B9) % seen[band]
            if slot < quota:
                bucket[slot] = triangle
    selected = [triangle for bucket in reservoirs.values() for triangle in bucket]
    selected.sort()
    selected = selected[:target]
    return [source.value(indices, triangle + offset)[0] for triangle in selected for offset in range(3)]


def add_view(binary: bytearray, views: list[dict], payload: bytes, target: int | None = None) -> int:
    start = align4(len(binary))
    binary.extend(b"\0" * (start - len(binary)))
    binary.extend(payload)
    view = {"buffer": 0, "byteOffset": start, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


def build_variant(source: Source, mesh_index: int, variant: str, lod: int, output: pathlib.Path) -> dict:
    mesh = source.gltf["meshes"][mesh_index]
    role_indices: dict[str, list[int]] = {}
    role_sources: dict[str, dict] = {}
    for primitive_index, role in ROLE_SPECS:
        primitive = mesh["primitives"][primitive_index]
        role_sources[role] = primitive
        role_indices[role] = select_triangles(source, primitive, role, ROLE_BUDGETS[lod][role])

    min_y = min(
        source.value(source.setup(primitive["attributes"]["POSITION"]), index)[1]
        for role, primitive in role_sources.items()
        for index in role_indices[role]
    )
    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    colors: list[tuple[float, float, float, float]] = []
    indices: list[int] = []
    for role in ROLE_ORDER:
        primitive = role_sources[role]
        pos_setup = source.setup(primitive["attributes"]["POSITION"])
        normal_setup = source.setup(primitive["attributes"]["NORMAL"])
        remap: dict[int, int] = {}
        for old in role_indices[role]:
            if old not in remap:
                remap[old] = len(positions)
                position = source.value(pos_setup, old)
                normal = source.value(normal_setup, old)
                if not all(math.isfinite(value) for value in (*position, *normal)):
                    raise ValueError(f"non-finite source attribute in {variant} LOD{lod}")
                positions.append((position[0], position[1] - min_y, position[2]))
                normals.append(normal)
                colors.append(ROLE_COLORS[role])
            indices.append(remap[old])
    if len(indices) % 3 or not positions or not indices:
        raise ValueError(f"invalid output topology for {variant} LOD{lod}")
    bounds = ([min(p[axis] for p in positions) for axis in range(3)], [max(p[axis] for p in positions) for axis in range(3)])
    binary = bytearray()
    views: list[dict] = []
    accessors: list[dict] = []

    def attribute(payload: bytes, count: int, typ: str, minmax=None) -> int:
        view = add_view(binary, views, payload, 34962)
        record = {"bufferView": view, "componentType": 5126, "count": count, "type": typ}
        if minmax is not None:
            record["min"], record["max"] = minmax
        accessors.append(record)
        return len(accessors) - 1

    position_accessor = attribute(b"".join(struct.pack("<3f", *p) for p in positions), len(positions), "VEC3", bounds)
    normal_accessor = attribute(b"".join(struct.pack("<3f", *n) for n in normals), len(normals), "VEC3")
    color_accessor = attribute(b"".join(struct.pack("<4f", *c) for c in colors), len(colors), "VEC4")
    index_component = "I" if len(positions) >= 65536 else "H"
    index_type = 5125 if index_component == "I" else 5123
    index_view = add_view(binary, views, struct.pack("<" + index_component * len(indices), *indices), 34963)
    accessors.append({"bufferView": index_view, "componentType": index_type, "count": len(indices), "type": "SCALAR"})
    index_accessor = len(accessors) - 1

    name = f"fir_tree_01_variant_{variant}_lod{lod}"
    output_gltf = {
        "asset": {"version": "2.0", "generator": "process_fir_tree.py@1"},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor, "COLOR_0": color_accessor}, "indices": index_accessor, "material": 0}]}],
        "materials": [{"name": "fir_tree_01_role_colors", "doubleSided": True, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.88}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views,
        "accessors": accessors,
        "extras": {"sourceAsset": "fir_tree_01", "sourceVariant": variant, "sourceMeshIndex": mesh_index, "lod": lod, "roles": list(ROLE_ORDER), "materialMode": "baked-role-colors"},
    }
    json_chunk = json.dumps(output_gltf, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary_chunk = bytes(binary) + b"\0" * ((4 - len(binary) % 4) % 4)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)))
        handle.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
        handle.write(json_chunk)
        handle.write(struct.pack("<II", len(binary_chunk), 0x004E4942))
        handle.write(binary_chunk)
    return {"variant": variant, "lod": lod, "vertices": len(positions), "triangles": len(indices) // 3, "bytes": output.stat().st_size}


def main() -> None:
    parsed = args()
    source = Source(pathlib.Path(parsed.input).resolve())
    try:
        output_dir = pathlib.Path(parsed.output_dir).resolve()
        reports = []
        for mesh_index, variant in enumerate(("a", "b", "c")):
            for lod in (0, 1):
                suffix = "" if variant == "a" else f"_variant_{variant}"
                output = output_dir / f"fir_tree_01{suffix}_lod{lod}.glb"
                report = build_variant(source, mesh_index, variant, lod, output)
                reports.append(report)
                print("FIR_TREE_DONE", json.dumps(report, sort_keys=True))
    finally:
        source.close()


if __name__ == "__main__":
    main()
