#!/usr/bin/env python3
"""Build source-faithful production LODs from Poly Haven Fir Tree 01.

The production converter historically sampled individual twig triangles and
replaced the source materials with role colours.  This candidate keeps complete
connected twig-card components, source UVs/normals/vertex colours, and the
licensed diffuse/normal/roughness maps. The resulting GLBs are eligible for the
runtime catalog only after their hashes, topology, and production render path
have passed the repository's fail-closed checks.
"""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import mmap
import pathlib
import struct
from dataclasses import dataclass
from io import BytesIO

from PIL import Image


ROLE_PRIMITIVES = (("bark", 0), ("trunk", 1), ("foliage", 2), ("branches", 3))
ROLE_MATERIALS = {"bark": 0, "trunk": 1, "foliage": 2, "branches": 3}
COMPONENT_BANDS = {"bark": 32, "trunk": 40, "foliage": 96, "branches": 32}
# Whole-component foliage quotas. The former 250/120 per-band experiment
# retained only 88,874/42,647 foliage faces from variant B and read as a
# skeletal pole line in golfer views. Structural roles are never sampled: both
# LODs retain the complete authored bark, trunk, and dead-branch component set.
# Foliage uses one LOD-independent ranking, so the lower quota is a strict
# connected-component subset of the higher quota.
LOD_COMPONENT_QUOTAS = {
    0: {"bark": None, "trunk": None, "foliage": 1400, "branches": None},
    1: {"bark": None, "trunk": None, "foliage": 850, "branches": None},
}
SEED = 0xF1A701


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--variant", choices=("a", "b", "c"), default="a")
    return parser.parse_args()


def align4(value: int) -> int:
    return (value + 3) & ~3


def hash32(value: int) -> int:
    value &= 0xFFFFFFFF
    value ^= (value >> 16)
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= (value >> 15)
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    return (value ^ (value >> 16)) & 0xFFFFFFFF


@dataclass
class Component:
    source_index: int
    triangles: list[int]
    vertices: list[int]
    min_y: float
    max_y: float


class Source:
    def __init__(self, path: pathlib.Path):
        self.path = path
        self.gltf = json.loads(path.read_text(encoding="utf-8"))
        self.handle = path.parent.joinpath(self.gltf["buffers"][0]["uri"]).open("rb")
        self.mm = mmap.mmap(self.handle.fileno(), 0, access=mmap.ACCESS_READ)

    def close(self) -> None:
        self.mm.close()
        self.handle.close()

    def setup(self, accessor_index: int):
        accessor = self.gltf["accessors"][accessor_index]
        view = self.gltf["bufferViews"][accessor["bufferView"]]
        component = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}[accessor["componentType"]]
        count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        stride = view.get("byteStride", component[1] * count)
        begin = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return accessor, begin, stride, component[0], count

    def value(self, setup, index: int):
        accessor, begin, stride, fmt, count = setup
        values = struct.unpack_from("<" + fmt * count, self.mm, begin + index * stride)
        if accessor.get("normalized"):
            divisor = 255.0 if accessor["componentType"] == 5121 else 65535.0
            return tuple(value / divisor for value in values)
        return values


def iter_components(source: Source, primitive: dict) -> list[Component]:
    """Return contiguous connected components without splitting authored cards."""
    position_setup = source.setup(primitive["attributes"]["POSITION"])
    index_setup = source.setup(primitive["indices"])
    triangle_count = index_setup[0]["count"] // 3
    components: list[Component] = []
    triangles: list[int] = []
    vertices: set[int] = set()
    min_y = math.inf
    max_y = -math.inf
    for triangle in range(triangle_count):
        ids = [source.value(index_setup, triangle * 3 + offset)[0] for offset in range(3)]
        shared = vertices.intersection(ids)
        if triangles and not shared:
            components.append(Component(len(components), triangles, sorted(vertices), min_y, max_y))
            triangles = []
            vertices = set()
            min_y = math.inf
            max_y = -math.inf
        triangles.append(triangle)
        vertices.update(ids)
        for index in ids:
            min_y = min(min_y, source.value(position_setup, index)[1])
            max_y = max(max_y, source.value(position_setup, index)[1])
    if triangles:
        components.append(Component(len(components), triangles, sorted(vertices), min_y, max_y))
    return components


def select_components(source: Source, primitive: dict, role: str, lod: int) -> list[Component]:
    components = iter_components(source, primitive)
    quota = LOD_COMPONENT_QUOTAS[lod][role]
    if quota is None:
        return components
    bands = COMPONENT_BANDS[role]
    minimum = min(component.min_y for component in components)
    maximum = max(component.max_y for component in components)
    buckets: list[list[tuple[int, int, Component]]] = [[] for _ in range(bands)]
    for component in components:
        centre = (component.min_y + component.max_y) * 0.5
        band = max(0, min(bands - 1, int((centre - minimum) / max(maximum - minimum, 1.0) * bands)))
        score = hash32(SEED ^ component.source_index)
        heap = buckets[band]
        heapq.heappush(heap, (-score, component.source_index, component))
        if len(heap) > quota:
            heapq.heappop(heap)
    selected = [entry[2] for bucket in buckets for entry in bucket]
    selected.sort(key=lambda component: component.triangles[0])
    return selected


def flatten_indices(source: Source, primitive: dict, components: list[Component]) -> list[int]:
    index_setup = source.setup(primitive["indices"])
    return [source.value(index_setup, triangle * 3 + offset)[0]
            for component in components
            for triangle in component.triangles
            for offset in range(3)]


def source_mesh_base_y(source: Source, mesh: dict) -> float:
    """Return the authored mesh grounding, independent of an LOD selection."""
    minima = []
    for _role, primitive_index in ROLE_PRIMITIVES:
        primitive = mesh["primitives"][primitive_index]
        accessor_index = primitive["attributes"]["POSITION"]
        accessor = source.gltf["accessors"][accessor_index]
        if "min" in accessor:
            minima.append(float(accessor["min"][1]))
            continue
        setup = source.setup(accessor_index)
        minima.append(min(source.value(setup, index)[1] for index in range(accessor["count"])))
    return min(minima)


def add_view(binary: bytearray, views: list[dict], payload: bytes, target: int | None = None) -> int:
    start = align4(len(binary))
    binary.extend(b"\0" * (start - len(binary)))
    binary.extend(payload)
    view = {"buffer": 0, "byteOffset": start, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


def add_attribute(binary: bytearray, views: list[dict], accessors: list[dict], values: list[tuple[float, ...]], typ: str,
                  *, minmax: bool = False) -> int:
    payload = b"".join(struct.pack("<" + "f" * len(value), *value) for value in values)
    view = add_view(binary, views, payload, 34962)
    record = {"bufferView": view, "componentType": 5126, "count": len(values), "type": typ}
    if minmax:
        record["min"] = [min(value[index] for value in values) for index in range(len(values[0]))]
        record["max"] = [max(value[index] for value in values) for index in range(len(values[0]))]
    accessors.append(record)
    return len(accessors) - 1


def combined_twig_texture(root: pathlib.Path) -> bytes:
    diffuse = Image.open(root / "textures/fir_tree_01_twig_diff_1k.jpg").convert("RGB")
    alpha = Image.open(root / "textures/fir_tree_01_twig_alpha_1k.png").convert("L")
    if diffuse.size != alpha.size:
        raise ValueError(f"twig diffuse/alpha dimensions differ: {diffuse.size} vs {alpha.size}")
    rgba = diffuse.copy()
    rgba.putalpha(alpha)
    output = BytesIO()
    rgba.save(output, format="PNG", optimize=True)
    return output.getvalue()


def source_texture_bytes(root: pathlib.Path, uri: str) -> bytes:
    return (root / uri).read_bytes()


def build_candidate(source: Source, output: pathlib.Path, lod: int, variant: str) -> dict:
    mesh = source.gltf["meshes"][("a", "b", "c").index(variant)]
    role_data = []
    for role, primitive_index in ROLE_PRIMITIVES:
        primitive = mesh["primitives"][primitive_index]
        components = select_components(source, primitive, role, lod)
        role_data.append((role, primitive, components, flatten_indices(source, primitive, components)))

    base_y = source_mesh_base_y(source, mesh)

    binary = bytearray()
    views: list[dict] = []
    accessors: list[dict] = []
    primitives = []
    role_vertex_counts = {}
    position_min = [math.inf, math.inf, math.inf]
    position_max = [-math.inf, -math.inf, -math.inf]
    vertex_total = 0

    for role, primitive, components, old_indices in role_data:
        attributes = primitive["attributes"]
        setups = {name: source.setup(accessor) for name, accessor in attributes.items()}
        remap: dict[int, int] = {}
        local_indices = []
        positions = []
        normals = []
        uvs = []
        color0 = []
        color1 = []
        for old in old_indices:
            if old not in remap:
                remap[old] = len(positions)
                position = setups["POSITION"] and source.value(setups["POSITION"], old)
                position = (position[0], position[1] - base_y, position[2])
                positions.append(position)
                normals.append(source.value(setups["NORMAL"], old))
                if "TEXCOORD_0" in setups:
                    uvs.append(source.value(setups["TEXCOORD_0"], old))
                if "COLOR_0" in setups:
                    color0.append(source.value(setups["COLOR_0"], old))
                if "COLOR_1" in setups:
                    color1.append(source.value(setups["COLOR_1"], old))
                for axis in range(3):
                    position_min[axis] = min(position_min[axis], position[axis])
                    position_max[axis] = max(position_max[axis], position[axis])
            local_indices.append(remap[old])
        attrs = {
            "POSITION": add_attribute(binary, views, accessors, positions, "VEC3", minmax=True),
            "NORMAL": add_attribute(binary, views, accessors, normals, "VEC3"),
        }
        if uvs:
            attrs["TEXCOORD_0"] = add_attribute(binary, views, accessors, uvs, "VEC2")
        if color0:
            attrs["COLOR_0"] = add_attribute(binary, views, accessors, color0, "VEC4")
        if color1:
            attrs["COLOR_1"] = add_attribute(binary, views, accessors, color1, "VEC4")
        index_component = "I" if len(positions) >= 65536 else "H"
        index_type = 5125 if index_component == "I" else 5123
        index_view = add_view(binary, views, struct.pack("<" + index_component * len(local_indices), *local_indices), 34963)
        accessors.append({"bufferView": index_view, "componentType": index_type, "count": len(local_indices), "type": "SCALAR"})
        primitives.append({"attributes": attrs, "indices": len(accessors) - 1, "material": ROLE_MATERIALS[role]})
        role_vertex_counts[role] = len(positions)
        vertex_total += len(positions)

    if (lod == 0 and vertex_total > 800_000) or (lod == 1 and vertex_total > 550_000):
        raise ValueError(f"candidate LOD{lod} exceeds vertex budget: {vertex_total}")

    root = source.path.parent
    # Preserve authored source maps. Twig diffuse and alpha are combined only
    # because the source glTF leaves alpha as a sidecar PNG instead of a material
    # texture; no colour/light baking is performed.
    image_payloads = [
        ("fir_tree_01_bark_nor_gl", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_bark_nor_gl_1k.jpg")),
        ("fir_tree_01_bark_diff", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_bark_diff_1k.jpg")),
        ("fir_tree_01_bark_arm", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_bark_arm_1k.jpg")),
        ("fir_tree_01_trunk_a_nor_gl", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_trunk_a_nor_gl_1k.jpg")),
        ("fir_tree_01_trunk_a_diff", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_trunk_a_diff_1k.jpg")),
        ("fir_tree_01_trunk_a_arm", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_trunk_a_arm_1k.jpg")),
        ("fir_tree_01_twig_nor_gl", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_twig_nor_gl_1k.jpg")),
        ("fir_tree_01_twig_diff_alpha", "image/png", combined_twig_texture(root)),
        ("fir_tree_01_twig_arm", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_twig_arm_1k.jpg")),
        ("fir_tree_01_dead_branch_nor_gl", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_bark_nor_gl_1k.jpg")),
        ("fir_tree_01_dead_branch_diff", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_bark_diff_1k.jpg")),
        ("fir_tree_01_dead_branch_arm", "image/jpeg", source_texture_bytes(root, "textures/fir_tree_01_bark_arm_1k.jpg")),
    ]
    image_indices = []
    for _name, mime, payload in image_payloads:
        view = add_view(binary, views, payload)
        image_indices.append(view)
    images = [{"name": name, "mimeType": mime, "bufferView": view} for (name, mime, _payload), view in zip(image_payloads, image_indices)]
    textures = [{"sampler": 0, "source": index} for index in range(len(images))]
    def material(name, normal, diffuse, rough, *, alpha=False):
        record = {
            "name": name, "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": diffuse}, "metallicFactor": 0,
                "metallicRoughnessTexture": {"index": rough},
            },
            "normalTexture": {"index": normal},
        }
        if alpha:
            # The sidecar alpha is authored foliage coverage. MASK keeps the
            # source card crisp and uses the production alpha-test path rather
            # than sorted transparency, which is unstable for tree crowns.
            record["alphaMode"] = "MASK"
            record["alphaCutoff"] = 0.06
        return record
    materials = [
        material("fir_source_bark", 0, 1, 2),
        material("fir_source_trunk_a", 3, 4, 5),
        material("fir_source_twig_authored_alpha", 6, 7, 8, alpha=True),
        material("fir_source_dead_branches", 9, 10, 11),
    ]

    document = {
        "asset": {"version": "2.0", "generator": "build_fir_tree_source_candidate@5-nested-source-faithful-lods"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"name": f"fir_tree_01_source_candidate_lod{lod}", "mesh": 0}],
        "meshes": [{"name": f"fir_tree_01_source_candidate_lod{lod}", "primitives": primitives}],
        "materials": materials, "images": images, "textures": textures,
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors,
        "extras": {
            "productionDerivative": True, "sourceAsset": "fir_tree_01_1k.gltf", "sourceMesh": f"variant-{variant}",
            "sourceSha256": hashlib.sha256(source.path.read_bytes()).hexdigest(),
            "selection": "complete structural roles; foliage uses one deterministic per-band connected-component ranking shared by all LODs",
            "lod": lod, "vertices": vertex_total, "roleVertices": role_vertex_counts,
            "baseY": base_y, "boundsMin": position_min, "boundsMax": position_max,
            "alphaSource": "fir_tree_01_twig_alpha_1k.png", "diffuseSource": "fir_tree_01_twig_diff_1k.jpg",
        },
    }
    json_chunk = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary_chunk = bytes(binary) + b"\0" * ((4 - len(binary) % 4) % 4)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)))
        handle.write(struct.pack("<II", len(json_chunk), 0x4E4F534A)); handle.write(json_chunk)
        handle.write(struct.pack("<II", len(binary_chunk), 0x004E4942)); handle.write(binary_chunk)
    return {
        "lod": lod,
        "vertices": vertex_total,
        "triangles": sum(len(p[3]) // 3 for p in role_data),
        "bytes": output.stat().st_size,
        "roleVertices": role_vertex_counts,
        "roleComponents": {role: len(components) for role, _primitive, components, _indices in role_data},
        "roleTriangles": {role: len(indices) // 3 for role, _primitive, _components, indices in role_data},
        "baseY": base_y,
    }


def main() -> None:
    parsed = parse_args()
    source = Source(pathlib.Path(parsed.input).resolve())
    try:
        output_dir = pathlib.Path(parsed.output_dir).resolve()
        for lod in (0, 1):
            # Variant B won the production crown review. Keep the runtime
            # filename canonical while retaining the exact variant in extras.
            stem = "fir_tree_01_source" if parsed.variant == "b" else f"fir_tree_01_variant_{parsed.variant}_source"
            output = output_dir / f"{stem}_lod{lod}.glb"
            report = build_candidate(source, output, lod, parsed.variant)
            print("FIR_SOURCE_CANDIDATE", json.dumps({"variant": parsed.variant, **report}, sort_keys=True))
    finally:
        source.close()


if __name__ == "__main__":
    main()
