#!/usr/bin/env python3
"""Inventory a BlenderKit .blend candidate: size, tris, materials, textures."""
import sys

import bpy
from mathutils import Vector


def main(path: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.open_mainfile(filepath=path)
    minv = Vector((1e18, 1e18, 1e18))
    maxv = Vector((-1e18, -1e18, -1e18))
    total_tris = 0
    meshes = 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        meshes += 1
        mesh = obj.data
        total_tris += sum(len(p.vertices) - 2 for p in mesh.polygons)
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            minv.x = min(minv.x, w.x)
            minv.y = min(minv.y, w.y)
            minv.z = min(minv.z, w.z)
            maxv.x = max(maxv.x, w.x)
            maxv.y = max(maxv.y, w.y)
            maxv.z = max(maxv.z, w.z)
    print(f'== {path}')
    print(f'meshes={meshes} tris={total_tris}')
    print(f'width={maxv.x - minv.x:.2f} height={maxv.z - minv.z:.2f} depth={maxv.y - minv.y:.2f}')
    print(f'baseZ={minv.z:.2f} topZ={maxv.z:.2f}')
    mats = set()
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        for slot in obj.material_slots:
            if slot.material is None:
                continue
            mats.add(slot.material.name)
            for node in slot.material.node_tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image:
                    img = node.image
                    print(f'  mat={slot.material.name!r} tex={img.name} {img.size[0]}x{img.size[1]} packed={img.packed_file is not None}')
    print(f'materials={sorted(mats)}')


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
