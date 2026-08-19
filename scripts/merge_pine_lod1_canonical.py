#!/usr/bin/env python3
"""Merge Pine LOD1 into one clean, role-colored canonical beauty primitive.

The source derivative's separate trunk/branch/foliage primitives have proved
unsafe in the live WebGPU path despite offline topology checks. This merge keeps
their retained geometry and embedded source images, but emits one indexed mesh
with stable vertex colors: bark brown for structural parts and pine green for
the crown. The renderer consumes this as the sole near/mid beauty primitive.
"""

from __future__ import annotations

import json
import pathlib
import struct
import sys

from sanitize_pine_lod1 import add_view, accessor_bytes, align4, read_glb, read_scalar_indices, read_vec3


ROLE_COLORS = (
    (0.30, 0.18, 0.095),  # branches
    (0.28, 0.48, 0.16),   # foliage
    (0.24, 0.13, 0.065),  # trunk
)


def main() -> None:
    source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "public/assets/trees/pine_tree_01_lod1.glb").resolve()
    output = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else source).resolve()
    gltf, binary = read_glb(source)
    meshes = gltf.get("meshes", [])
    # A canonical asset may be passed back through the tool solely to repair or
    # refresh strict glTF accessor metadata. Preserve its existing binary payload
    # byte-for-byte and rewrite only the JSON chunk.
    if len(meshes) == 1 and len(meshes[0].get("primitives", [])) == 1:
        primitive = meshes[0]["primitives"][0]
        positions = read_vec3(gltf, binary, primitive["attributes"]["POSITION"])
        accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
        accessor["min"] = [min(value[axis] for value in positions) for axis in range(3)]
        accessor["max"] = [max(value[axis] for value in positions) for axis in range(3)]
        json_payload = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode()
        json_payload += b" " * ((4 - len(json_payload) % 4) % 4)
        bin_payload = binary + b"\0" * ((4 - len(binary) % 4) % 4)
        with output.open("wb") as handle:
            handle.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_payload) + 8 + len(bin_payload)))
            handle.write(struct.pack("<II", len(json_payload), 0x4E4F534A))
            handle.write(json_payload)
            handle.write(struct.pack("<II", len(bin_payload), 0x004E4942))
            handle.write(bin_payload)
        print(f"CANONICAL_METADATA_DONE vertices={len(positions)} bytes={output.stat().st_size}")
        return
    if len(meshes) != 3:
        raise ValueError(f"expected three source roles before merge, got {len(meshes)}")

    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    colors: list[tuple[float, float, float]] = []
    indices: list[int] = []
    for mesh_index, mesh in enumerate(meshes):
        primitive = mesh["primitives"][0]
        role_positions = read_vec3(gltf, binary, primitive["attributes"]["POSITION"])
        _, normal_raw, _ = accessor_bytes(gltf, binary, primitive["attributes"]["NORMAL"])
        role_normals = list(struct.iter_unpack("<3f", normal_raw))
        _, uv_raw, _ = accessor_bytes(gltf, binary, primitive["attributes"]["TEXCOORD_0"])
        role_uvs = list(struct.iter_unpack("<2f", uv_raw))
        if not (len(role_positions) == len(role_normals) == len(role_uvs)):
            raise ValueError(f"attribute count mismatch in source role {mesh_index}")
        base = len(positions)
        positions.extend(role_positions)
        normals.extend(role_normals)
        uvs.extend(role_uvs)
        colors.extend([ROLE_COLORS[mesh_index]] * len(role_positions))
        indices.extend(base + index for index in read_scalar_indices(gltf, binary, primitive["indices"]))

    if len(positions) >= 65536:
        raise ValueError("canonical Pine mesh exceeds uint16 index budget")
    output_binary = bytearray()
    output_views: list[dict] = []
    output_accessors: list[dict] = []

    def add_attribute(payload: bytes, count: int, components: int, *, bounds=None) -> int:
        view = add_view(output_binary, output_views, payload, 34962)
        accessor = {
            "bufferView": view,
            "componentType": 5126,
            "count": count,
            "type": {2: "VEC2", 3: "VEC3"}[components],
        }
        if bounds is not None:
            accessor["min"], accessor["max"] = bounds
        output_accessors.append(accessor)
        return len(output_accessors) - 1

    position_bounds = (
        [min(value[axis] for value in positions) for axis in range(3)],
        [max(value[axis] for value in positions) for axis in range(3)],
    )
    position_accessor = add_attribute(
        b"".join(struct.pack("<3f", *value) for value in positions),
        len(positions), 3, bounds=position_bounds,
    )
    normal_accessor = add_attribute(b"".join(struct.pack("<3f", *value) for value in normals), len(normals), 3)
    uv_accessor = add_attribute(b"".join(struct.pack("<2f", *value) for value in uvs), len(uvs), 2)
    color_accessor = add_attribute(b"".join(struct.pack("<3f", *value) for value in colors), len(colors), 3)
    index_view = add_view(output_binary, output_views, struct.pack("<" + "H" * len(indices), *indices), 34963)
    output_accessors.append({
        "bufferView": index_view,
        "componentType": 5123,
        "count": len(indices),
        "type": "SCALAR",
    })
    index_accessor = len(output_accessors) - 1

    # Keep the six embedded CC0 source images in the package for provenance and
    # future material variants, but do not sample the unsafe packed atlas in the
    # canonical beauty primitive. Vertex colors carry a stable structural/crown
    # response without any atlas gutter or UV seam failure.
    canonical_material = {
        "name": "pine_tree_01_canonical",
        "doubleSided": True,
        "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1],
            "metallicFactor": 0,
            "roughnessFactor": 0.88,
        },
    }
    output_mesh = {
        "name": "pine_tree_01_canonical_lod1",
        "primitives": [{
            "attributes": {
                "POSITION": position_accessor,
                "NORMAL": normal_accessor,
                "TEXCOORD_0": uv_accessor,
                "COLOR_0": color_accessor,
            },
            "indices": index_accessor,
            "material": 0,
        }],
    }

    # Copy embedded image views verbatim, retaining the authored texture lineage.
    image_views: dict[int, int] = {}
    for image in gltf.get("images", []):
        if "bufferView" not in image:
            continue
        old_view = gltf["bufferViews"][image["bufferView"]]
        begin = old_view.get("byteOffset", 0)
        payload = binary[begin : begin + old_view["byteLength"]]
        image_views[image["bufferView"]] = add_view(output_binary, output_views, payload)
    images = []
    for image in gltf.get("images", []):
        if image.get("bufferView") not in image_views:
            continue
        rewritten = dict(image)
        rewritten["bufferView"] = image_views[image["bufferView"]]
        rewritten.pop("uri", None)
        images.append(rewritten)

    output_gltf = {key: value for key, value in gltf.items() if key not in ("buffers", "bufferViews", "accessors", "meshes", "nodes", "materials", "images")}
    output_gltf["scene"] = 0
    output_gltf["scenes"] = [{"name": "Scene", "nodes": [0]}]
    output_gltf["nodes"] = [{"mesh": 0, "name": "pine_tree_01_canonical_lod1"}]
    output_gltf["meshes"] = [output_mesh]
    output_gltf["materials"] = [canonical_material]
    output_gltf["images"] = images
    output_gltf["buffers"] = [{"byteLength": len(output_binary)}]
    output_gltf["bufferViews"] = output_views
    output_gltf["accessors"] = output_accessors
    output.parent.mkdir(parents=True, exist_ok=True)
    json_payload = json.dumps(output_gltf, separators=(",", ":"), ensure_ascii=False).encode()
    json_payload += b" " * ((4 - len(json_payload) % 4) % 4)
    bin_payload = bytes(output_binary)
    bin_payload += b"\0" * ((4 - len(bin_payload) % 4) % 4)
    with output.open("wb") as handle:
        handle.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_payload) + 8 + len(bin_payload)))
        handle.write(struct.pack("<II", len(json_payload), 0x4E4F534A))
        handle.write(json_payload)
        handle.write(struct.pack("<II", len(bin_payload), 0x004E4942))
        handle.write(bin_payload)
    print(f"CANONICAL_DONE vertices={len(positions)} triangles={len(indices)//3} images={len(images)} bytes={output.stat().st_size}")


if __name__ == "__main__":
    main()
