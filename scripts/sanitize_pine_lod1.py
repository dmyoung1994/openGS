#!/usr/bin/env python3
"""Topology-safe, texture-preserving Pine Tree 01 LOD1 sanitizer.

This is the offline fallback for machines without Blender.  It reads the
already source-derived LOD1 GLB, removes only triangles with collapsed edges
or an extreme aspect ratio, compacts the surviving indexed attributes, and
re-emits the GLB with all six embedded 1K images untouched.  It deliberately
does not weld or re-triangulate: both operations can turn disconnected needle
islands into the black fan corruption this asset previously showed.

Usage:
  python3 scripts/sanitize_pine_lod1.py \
    --input public/assets/trees/pine_tree_01_lod1.glb \
    --output public/assets/trees/pine_tree_01_lod1.glb
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import struct
from typing import Any


ROLE_ORDER = ("branches", "foliage", "trunk")
ASPECT_LIMIT = 64.0
AREA_EPSILON = 1.0e-7
# Blender's previous collapse pass connected vertices across authored UV
# islands. The position triangles still looked numerically valid, but their
# interpolated texture coordinates crossed the source atlas's black gutter and
# rendered as needle-tip shards / fan-shaped trunk faces. Keep this per-role:
# foliage needles are small and tolerate less UV stretch; structural branches
# have genuinely elongated bark shells.
UV_STRETCH_LIMIT = {"branches": 32.0, "foliage": 5.0, "trunk": 16.0}
COMPONENT_BYTES = {5121: 1, 5123: 2, 5125: 4, 5126: 4}
COMPONENT_FORMAT = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}
TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def read_glb(path: pathlib.Path) -> tuple[dict[str, Any], bytes]:
    blob = path.read_bytes()
    if blob[:4] != b"glTF":
        raise ValueError(f"not a GLB: {path}")
    version, length = struct.unpack_from("<II", blob, 4)
    if version != 2 or length != len(blob):
        raise ValueError(f"invalid GLB header: version={version} length={length} actual={len(blob)}")
    offset = 12
    json_chunk = None
    bin_chunk = None
    while offset < len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        payload = blob[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == 0x4E4F534A:
            json_chunk = payload
        elif chunk_type == 0x004E4942:
            bin_chunk = payload
    if json_chunk is None or bin_chunk is None:
        raise ValueError("GLB must contain JSON and BIN chunks")
    return json.loads(json_chunk.decode("utf-8")), bin_chunk


def align4(value: int) -> int:
    return (value + 3) & ~3


def accessor_bytes(gltf: dict[str, Any], binary: bytes, index: int) -> tuple[dict[str, Any], bytes, int]:
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    component_size = COMPONENT_BYTES[accessor["componentType"]]
    components = TYPE_COMPONENTS[accessor["type"]]
    item_size = component_size * components
    stride = view.get("byteStride", item_size)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    raw = bytearray()
    for row in range(accessor["count"]):
        begin = start + row * stride
        raw.extend(binary[begin : begin + item_size])
    return accessor, bytes(raw), item_size


def read_scalar_indices(gltf: dict[str, Any], binary: bytes, index: int) -> list[int]:
    accessor, raw, _ = accessor_bytes(gltf, binary, index)
    fmt = "<" + COMPONENT_FORMAT[accessor["componentType"]]
    width = COMPONENT_BYTES[accessor["componentType"]]
    return [struct.unpack_from(fmt, raw, i)[0] for i in range(0, len(raw), width)]


def read_vec3(gltf: dict[str, Any], binary: bytes, index: int) -> list[tuple[float, float, float]]:
    accessor, raw, _ = accessor_bytes(gltf, binary, index)
    if accessor["componentType"] != 5126 or accessor["type"] != "VEC3":
        raise ValueError("POSITION must be float VEC3")
    return list(struct.iter_unpack("<3f", raw))


def triangle_is_safe(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
    c: tuple[float, float, float],
    uv_a: tuple[float, float] | None = None,
    uv_b: tuple[float, float] | None = None,
    uv_c: tuple[float, float] | None = None,
    uv_limit: float | None = None,
) -> bool:
    edges = (
        math.dist(a, b),
        math.dist(b, c),
        math.dist(c, a),
    )
    if min(edges) <= 1.0e-8:
        return False
    cross = (
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    )
    area = 0.5 * math.sqrt(sum(component * component for component in cross))
    if area <= AREA_EPSILON or max(edges) / min(edges) > ASPECT_LIMIT:
        return False
    if uv_a is not None and uv_b is not None and uv_c is not None and uv_limit is not None:
        uv_edges = (
            math.dist(uv_a, uv_b),
            math.dist(uv_b, uv_c),
            math.dist(uv_c, uv_a),
        )
        if max(uv_edge / edge for uv_edge, edge in zip(uv_edges, edges)) > uv_limit:
            return False
    return True


def copy_accessor_header(accessor: dict[str, Any], count: int) -> dict[str, Any]:
    return {
        key: value
        for key, value in accessor.items()
        if key not in ("bufferView", "byteOffset", "count", "min", "max")
    } | {"count": count}


def add_view(binary: bytearray, views: list[dict[str, Any]], payload: bytes, target: int | None = None) -> int:
    start = align4(len(binary))
    binary.extend(b"\0" * (start - len(binary)))
    binary.extend(payload)
    view: dict[str, Any] = {"buffer": 0, "byteOffset": start, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


def main() -> None:
    args = parse_args()
    source_path = pathlib.Path(args.input).resolve()
    output_path = pathlib.Path(args.output).resolve()
    gltf, binary = read_glb(source_path)
    meshes = gltf.get("meshes", [])
    if len(meshes) != 3:
        raise ValueError(f"expected exactly 3 semantic meshes, got {len(meshes)}")

    # Preserve the current loader contract: branches, opaque modeled foliage,
    # then trunk.  Material names are made explicit below so the order is not
    # dependent on an exporter-generated object name.
    roles: list[str] = []
    for mesh in meshes:
        if len(mesh.get("primitives", [])) != 1:
            raise ValueError("each Pine LOD1 role must have exactly one primitive")
        material = mesh["primitives"][0].get("material")
        name = gltf.get("materials", [])[material].get("name", "") if material is not None else ""
        role = next((candidate for candidate in ROLE_ORDER if candidate in name), None)
        if role is None:
            raise ValueError(f"cannot infer semantic role from material {name!r}")
        roles.append(role)
    if tuple(roles) != ROLE_ORDER:
        raise ValueError(f"unexpected role order {roles}; expected {ROLE_ORDER}")

    # The source LOD0 is authored on y=0.  Decimation can discard the lowest
    # trunk ring, so restore the shared ground plane before writing the
    # derivative.  Applying one rigid offset to every role keeps the crown and
    # branches locked together instead of independently re-grounding them.
    all_positions = [
        read_vec3(gltf, binary, mesh["primitives"][0]["attributes"]["POSITION"])
        for mesh in meshes
    ]
    ground_offset = min(point[1] for part in all_positions for point in part)

    output_binary = bytearray()
    output_views: list[dict[str, Any]] = []
    output_accessors: list[dict[str, Any]] = []
    output_meshes: list[dict[str, Any]] = []
    removed = {role: 0 for role in ROLE_ORDER}
    kept = {role: 0 for role in ROLE_ORDER}
    vertices = {role: 0 for role in ROLE_ORDER}

    for mesh, role in zip(meshes, roles):
        primitive = mesh["primitives"][0]
        position_accessor = primitive["attributes"]["POSITION"]
        positions = read_vec3(gltf, binary, position_accessor)
        uv_positions = None
        if "TEXCOORD_0" in primitive["attributes"]:
            uv_accessor, uv_raw, _ = accessor_bytes(gltf, binary, primitive["attributes"]["TEXCOORD_0"])
            if uv_accessor["componentType"] == 5126 and uv_accessor["type"] == "VEC2":
                uv_positions = list(struct.iter_unpack("<2f", uv_raw))
        indices = read_scalar_indices(gltf, binary, primitive["indices"])
        if len(indices) % 3:
            raise ValueError(f"{role} indices are not triangles")
        selected: list[int] = []
        face_normals: dict[int, list[float]] = {}
        for triangle in range(0, len(indices), 3):
            i0, i1, i2 = indices[triangle : triangle + 3]
            uv_args = ()
            if uv_positions is not None:
                uv_args = (uv_positions[i0], uv_positions[i1], uv_positions[i2], UV_STRETCH_LIMIT[role])
            if triangle_is_safe(positions[i0], positions[i1], positions[i2], *uv_args):
                selected.extend((i0, i1, i2))
                ax, ay, az = positions[i0]
                bx, by, bz = positions[i1]
                cx, cy, cz = positions[i2]
                ux, uy, uz = bx - ax, by - ay, bz - az
                vx, vy, vz = cx - ax, cy - ay, cz - az
                nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
                # Favor outward-facing normals. The source foliage/branch mesh
                # contains a few reversed islands; letting those reach the
                # runtime lighting path is what turns otherwise valid triangles
                # into black shards under a moving sun.
                mx, my, mz = (ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3
                if nx * mx + ny * (my - 7.0) + nz * mz < 0:
                    nx, ny, nz = -nx, -ny, -nz
                for vertex in (i0, i1, i2):
                    accumulated = face_normals.setdefault(vertex, [0.0, 0.0, 0.0])
                    accumulated[0] += nx; accumulated[1] += ny; accumulated[2] += nz
            else:
                removed[role] += 1
        if not selected:
            raise ValueError(f"sanitizer removed all {role} triangles")
        kept[role] = len(selected) // 3

        remap: dict[int, int] = {}
        compact_indices: list[int] = []
        for old in selected:
            if old not in remap:
                remap[old] = len(remap)
            compact_indices.append(remap[old])
        vertices[role] = len(remap)

        attributes: dict[str, int] = {}
        for semantic, old_accessor_index in primitive["attributes"].items():
            old_accessor, raw, item_size = accessor_bytes(gltf, binary, old_accessor_index)
            selected_bytes = b"".join(raw[old * item_size : (old + 1) * item_size] for old in remap)
            if semantic == "NORMAL":
                normals = []
                for old in remap:
                    nx, ny, nz = face_normals.get(old, [0.0, 1.0, 0.0])
                    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                    normals.append((nx / length, ny / length, nz / length))
                selected_bytes = b"".join(struct.pack("<3f", *normal) for normal in normals)
            view = add_view(output_binary, output_views, selected_bytes, 34962)
            accessor = copy_accessor_header(old_accessor, len(remap))
            accessor["bufferView"] = view
            if semantic == "POSITION":
                points = [
                    (positions[old][0], positions[old][1] - ground_offset, positions[old][2])
                    for old in remap
                ]
                # POSITION is the only float VEC3 attribute in this asset. The
                # copied bytes above are rewritten so all three roles use the
                # same authored y=0 plane.
                selected_bytes = b"".join(struct.pack("<3f", *point) for point in points)
                # The view was added before this branch; replace its payload in
                # place while retaining the compact/tightly-packed layout.
                view_start = output_views[view].get("byteOffset", 0)
                output_binary[view_start : view_start + len(selected_bytes)] = selected_bytes
                accessor["min"] = [min(point[i] for point in points) for i in range(3)]
                accessor["max"] = [max(point[i] for point in points) for i in range(3)]
            output_accessors.append(accessor)
            attributes[semantic] = len(output_accessors) - 1

        index_payload = struct.pack("<" + "H" * len(compact_indices), *compact_indices)
        index_view = add_view(output_binary, output_views, index_payload, 34963)
        index_accessor = {
            "bufferView": index_view,
            "componentType": 5123,
            "count": len(compact_indices),
            "type": "SCALAR",
        }
        output_accessors.append(index_accessor)
        output_meshes.append({
            "name": f"pine_tree_01_{role}_lod1",
            "primitives": [{"attributes": attributes, "indices": len(output_accessors) - 1, "material": primitive["material"]}],
        })

    # Copy embedded image payloads verbatim. No re-encoding means the source
    # 1K bark/twig textures remain bit-identical and still live inside the GLB.
    image_views: dict[int, int] = {}
    for image in gltf.get("images", []):
        if "bufferView" not in image:
            raise ValueError("Pine LOD1 images must be embedded")
        old_view = gltf["bufferViews"][image["bufferView"]]
        begin = old_view.get("byteOffset", 0)
        payload = binary[begin : begin + old_view["byteLength"]]
        image_views[image["bufferView"]] = add_view(output_binary, output_views, payload)
    output_images = []
    for image in gltf.get("images", []):
        rewritten = dict(image)
        rewritten["bufferView"] = image_views[image["bufferView"]]
        rewritten.pop("uri", None)
        output_images.append(rewritten)

    output = {key: value for key, value in gltf.items() if key not in ("buffers", "bufferViews", "accessors", "meshes", "images")}
    output["buffers"] = [{"byteLength": len(output_binary)}]
    output["bufferViews"] = output_views
    output["accessors"] = output_accessors
    output["meshes"] = output_meshes
    output["images"] = output_images
    for index, material in enumerate(output.get("materials", [])):
        if index < len(ROLE_ORDER):
            material = dict(material)
            material["name"] = f"pine_tree_01_{ROLE_ORDER[index]}"
            output["materials"][index] = material
    output["nodes"] = [
        {"mesh": index, "name": f"pine_tree_01_{role}_lod1"}
        for index, role in enumerate(ROLE_ORDER)
    ]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    json_payload = json.dumps(output, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_payload += b" " * ((4 - len(json_payload) % 4) % 4)
    bin_payload = bytes(output_binary)
    bin_payload += b"\0" * ((4 - len(bin_payload) % 4) % 4)
    total_length = 12 + 8 + len(json_payload) + 8 + len(bin_payload)
    with output_path.open("wb") as output_file:
        output_file.write(struct.pack("<4sII", b"glTF", 2, total_length))
        output_file.write(struct.pack("<II", len(json_payload), 0x4E4F534A))
        output_file.write(json_payload)
        output_file.write(struct.pack("<II", len(bin_payload), 0x004E4942))
        output_file.write(bin_payload)
    print(f"SAFE_ROLE roles={','.join(ROLE_ORDER)}")
    print(f"SAFE_TRIANGLES kept={kept} removed={removed}")
    print(f"SAFE_VERTICES {vertices} total={sum(vertices.values())}")
    print(f"SAFE_DONE output={output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
