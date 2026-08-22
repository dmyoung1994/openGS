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
from dataclasses import dataclass

import numpy as np


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
    parser.add_argument("--foliage-selection", choices=("triangle", "component"), default="triangle")
    parser.add_argument("--variant", choices=("a", "b", "c", "all"), default="all")
    parser.add_argument("--prefix", default=None)
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


@dataclass(frozen=True)
class ComponentSelection:
    indices: list[int]
    centres: dict[int, tuple[float, float, float]]
    scale: float
    source_triangles: int
    selected_components: int
    source_components: int


def _accessor_array(source: Source, accessor_index: int) -> np.ndarray:
    """Return a zero-copy strided NumPy view over a scalar/vector accessor."""
    accessor = source.gltf["accessors"][accessor_index]
    view = source.gltf["bufferViews"][accessor["bufferView"]]
    dtype = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[accessor["componentType"]]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    item_bytes = np.dtype(dtype).itemsize * components
    stride = view.get("byteStride", item_bytes)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    shape = (accessor["count"],) if components == 1 else (accessor["count"], components)
    strides = (stride,) if components == 1 else (stride, np.dtype(dtype).itemsize)
    return np.ndarray(shape=shape, dtype=dtype, buffer=source.mm, offset=offset, strides=strides)


def _hash32(values: np.ndarray) -> np.ndarray:
    values = values.astype(np.uint32, copy=True)
    values ^= values << np.uint32(13)
    values ^= values >> np.uint32(17)
    values ^= values << np.uint32(5)
    return values


def select_foliage_components(source: Source, primitive: dict, target: int, lod: int) -> ComponentSelection:
    """Retain complete authored foliage islands with spatially even coverage.

    The old reservoir selected unrelated individual triangles in Y bands.  A
    needle spray therefore arrived as disconnected glitter even when its total
    triangle count met budget.  This path first recovers source connected
    components, distributes them through a 3-D crown grid, and enlarges each
    surviving component by a bounded amount around its own centroid.  It is the
    offline equivalent of SpeedTree leaf-size compensation / Nanite Preserve
    Area: fewer aggregate elements, but no missing crown zones and no broken
    source element.
    """
    index_values = np.asarray(_accessor_array(source, primitive["indices"]), dtype=np.uint32)
    triangles = index_values.reshape(-1, 3)
    vertex_count = source.gltf["accessors"][primitive["attributes"]["POSITION"]]["count"]
    parent = np.arange(vertex_count, dtype=np.int32)
    rank = np.zeros(vertex_count, dtype=np.uint8)

    def find(value: int) -> int:
        root = value
        while int(parent[root]) != root:
            root = int(parent[root])
        while int(parent[value]) != value:
            next_value = int(parent[value])
            parent[value] = root
            value = next_value
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if rank[ra] < rank[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        if rank[ra] == rank[rb]:
            rank[ra] += 1

    for a, b, c in triangles:
        union(int(a), int(b))
        union(int(a), int(c))

    used = np.unique(index_values)
    roots = np.fromiter((find(int(value)) for value in used), dtype=np.int32, count=len(used))
    unique_roots, inverse = np.unique(roots, return_inverse=True)
    root_to_component = np.full(vertex_count, -1, dtype=np.int32)
    root_to_component[unique_roots] = np.arange(len(unique_roots), dtype=np.int32)

    positions = np.asarray(_accessor_array(source, primitive["attributes"]["POSITION"]), dtype=np.float64)
    component_counts = np.bincount(inverse, minlength=len(unique_roots))
    centres = np.column_stack([
        np.bincount(inverse, weights=positions[used, axis], minlength=len(unique_roots)) / component_counts
        for axis in range(3)
    ])
    triangle_components = root_to_component[np.fromiter(
        (find(int(value)) for value in triangles[:, 0]), dtype=np.int32, count=len(triangles),
    )]
    triangle_counts = np.bincount(triangle_components, minlength=len(unique_roots))

    # Crown bins are deliberately finer vertically than horizontally: fir tiers
    # are the most visible holes, while 12x12 azimuthal cells prevent one camera
    # side receiving all of a random reservoir's surviving sprays.
    bounds_min = centres.min(axis=0)
    bounds_span = np.maximum(centres.max(axis=0) - bounds_min, 1e-9)
    grid = np.array((12, 48, 12), dtype=np.int32)
    cell = np.minimum(((centres - bounds_min) / bounds_span * grid).astype(np.int32), grid - 1)
    cell_id = cell[:, 0] + grid[0] * (cell[:, 1] + grid[1] * cell[:, 2])
    fraction = min(1.0, target / max(len(triangles), 1))
    seed = np.uint32((0x9E3779B9 + lod * 0x85EBCA6B) & 0xFFFFFFFF)
    score = _hash32(unique_roots.astype(np.uint32) ^ seed)
    order = np.lexsort((score, cell_id))
    ordered_cells = cell_id[order]
    starts = np.flatnonzero(np.r_[True, ordered_cells[1:] != ordered_cells[:-1]])
    ends = np.r_[starts[1:], len(order)]
    selected = np.zeros(len(unique_roots), dtype=bool)
    for start, end in zip(starts, ends):
        count = end - start
        keep = min(count, max(1, int(round(count * fraction))))
        selected[order[start:start + keep]] = True

    selected_triangles = selected[triangle_components]
    kept_indices = index_values.reshape(-1, 3)[selected_triangles].reshape(-1)
    kept_vertices = np.unique(kept_indices)
    kept_roots = np.fromiter((find(int(value)) for value in kept_vertices), dtype=np.int32, count=len(kept_vertices))
    kept_components = root_to_component[kept_roots]
    centre_by_vertex = {
        int(vertex): tuple(float(value) for value in centres[int(component)])
        for vertex, component in zip(kept_vertices, kept_components)
    }
    # Bounded rather than exact area conservation: exact sqrt(source/kept)
    # would make a 4:1 LOD reduction double every needle spray and erase the
    # authored negative space. These values restore mass without blobs.
    scale = 1.36 if lod == 0 else 1.72
    return ComponentSelection(
        indices=[int(value) for value in kept_indices],
        centres=centre_by_vertex,
        scale=scale,
        source_triangles=len(triangles),
        selected_components=int(selected.sum()),
        source_components=len(unique_roots),
    )


def add_view(binary: bytearray, views: list[dict], payload: bytes, target: int | None = None) -> int:
    start = align4(len(binary))
    binary.extend(b"\0" * (start - len(binary)))
    binary.extend(payload)
    view = {"buffer": 0, "byteOffset": start, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


def build_variant(source: Source, mesh_index: int, variant: str, lod: int, output: pathlib.Path,
                  foliage_selection: str = "triangle") -> dict:
    mesh = source.gltf["meshes"][mesh_index]
    role_indices: dict[str, list[int]] = {}
    role_sources: dict[str, dict] = {}
    component_selection: ComponentSelection | None = None
    for primitive_index, role in ROLE_SPECS:
        primitive = mesh["primitives"][primitive_index]
        role_sources[role] = primitive
        if role == "foliage" and foliage_selection == "component":
            component_selection = select_foliage_components(source, primitive, ROLE_BUDGETS[lod][role], lod)
            role_indices[role] = component_selection.indices
        else:
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
                if role == "foliage" and component_selection is not None:
                    centre = component_selection.centres[old]
                    position = tuple(
                        centre[axis] + (position[axis] - centre[axis]) * component_selection.scale
                        for axis in range(3)
                    )
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
        "asset": {"version": "2.0", "generator": (
            "process_fir_tree.py@2-component-area-preserve"
            if component_selection is not None else "process_fir_tree.py@1"
        )},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor, "COLOR_0": color_accessor}, "indices": index_accessor, "material": 0}]}],
        "materials": [{"name": "fir_tree_01_role_colors", "doubleSided": True, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.88}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views,
        "accessors": accessors,
        "extras": {
            "candidateOnly": component_selection is not None,
            "sourceAsset": "fir_tree_01",
            "sourceVariant": variant,
            "sourceMeshIndex": mesh_index,
            "lod": lod,
            "roles": list(ROLE_ORDER),
            "materialMode": "baked-role-colors",
            "foliageSelection": ({
                "method": "connected-components-3d-stratified-area-preserving",
                "sourceTriangles": component_selection.source_triangles,
                "selectedTriangles": len(component_selection.indices) // 3,
                "sourceComponents": component_selection.source_components,
                "selectedComponents": component_selection.selected_components,
                "componentScale": component_selection.scale,
                "grid": [12, 48, 12],
            } if component_selection is not None else {"method": "triangle-height-reservoir"}),
        },
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
        variants = ("a", "b", "c") if parsed.variant == "all" else (parsed.variant,)
        for variant in variants:
            mesh_index = ("a", "b", "c").index(variant)
            for lod in (0, 1):
                if parsed.prefix:
                    output = output_dir / f"{parsed.prefix}_lod{lod}.glb"
                else:
                    suffix = "" if variant == "a" else f"_variant_{variant}"
                    output = output_dir / f"fir_tree_01{suffix}_lod{lod}.glb"
                report = build_variant(
                    source, mesh_index, variant, lod, output,
                    foliage_selection=parsed.foliage_selection,
                )
                reports.append(report)
                print("FIR_TREE_DONE", json.dumps(report, sort_keys=True))
    finally:
        source.close()


if __name__ == "__main__":
    main()
