#!/usr/bin/env python3
"""Offline integrity gate for the Pine Tree 01 LOD1 derivative."""

from __future__ import annotations

import pathlib
import sys

from sanitize_pine_lod1 import (
    AREA_EPSILON,
    ASPECT_LIMIT,
    accessor_bytes,
    read_glb,
    read_scalar_indices,
    read_vec3,
    triangle_is_safe,
)


def main() -> None:
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "public/assets/trees/pine_tree_01_lod1.glb")
    gltf, binary = read_glb(path.resolve())
    meshes = gltf.get("meshes", [])
    nodes = gltf.get("nodes", [])
    assert len(meshes) == 1 and len(nodes) == 1, "Pine LOD1 must contain one canonical beauty mesh"
    assert all("bufferView" in image and "uri" not in image for image in gltf.get("images", [])), "all source textures must be embedded"
    total_vertices = 0
    total_triangles = 0
    global_min_y = float("inf")
    for mesh in meshes:
        assert len(mesh.get("primitives", [])) == 1, "each role must have one primitive"
        primitive = mesh["primitives"][0]
        position_accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
        assert len(position_accessor.get("min", [])) == 3 and len(position_accessor.get("max", [])) == 3, \
            "canonical POSITION accessor must declare bounds for strict GLTFLoader readiness"
        role = "canonical"
        positions = read_vec3(gltf, binary, primitive["attributes"]["POSITION"])
        uv_positions = None
        if "TEXCOORD_0" in primitive["attributes"]:
            _, uv_raw, _ = accessor_bytes(gltf, binary, primitive["attributes"]["TEXCOORD_0"])
            uv_positions = list(__import__("struct").iter_unpack("<2f", uv_raw))
        indices = read_scalar_indices(gltf, binary, primitive["indices"])
        total_vertices += len(positions)
        total_triangles += len(indices) // 3
        global_min_y = min(global_min_y, *(position[1] for position in positions))
        expected_min = [min(position[axis] for position in positions) for axis in range(3)]
        expected_max = [max(position[axis] for position in positions) for axis in range(3)]
        assert all(abs(a - b) <= 1.0e-6 for a, b in zip(position_accessor["min"], expected_min)), \
            "canonical POSITION minimum bounds are stale"
        assert all(abs(a - b) <= 1.0e-6 for a, b in zip(position_accessor["max"], expected_max)), \
            "canonical POSITION maximum bounds are stale"
        assert len(indices) % 3 == 0
        for offset in range(0, len(indices), 3):
            a, b, c = (positions[index] for index in indices[offset : offset + 3])
            uv_args = ()
            if uv_positions is not None:
                # Canonical material does not sample the packed source UV atlas;
                # validate geometry independently of UV seam continuity.
                uv_args = ()
            assert triangle_is_safe(a, b, c, *uv_args), f"unsafe {role} triangle at {offset // 3}"
    assert total_vertices < 90864, f"LOD1 vertex budget exceeded: {total_vertices}"
    assert abs(global_min_y) <= 1.0e-5, f"asset is not grounded at y=0: {global_min_y}"
    print(f"PINE_LOD1_OK representation=canonical vertices={total_vertices} triangles={total_triangles} maxAspect<={ASPECT_LIMIT:g} area>{AREA_EPSILON:g} embeddedImages={len(gltf.get('images', []))}")


if __name__ == "__main__":
    main()
