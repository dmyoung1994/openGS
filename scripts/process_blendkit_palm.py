#!/usr/bin/env python3
"""Build a material-preserving palm LOD1 from the licensed BlendKit source GLB.

Run with Blender so its glTF importer/exporter carries the authored PBR material
graph, UV sets, normals, vertex colours, and embedded leaf alpha through intact:

  blender --background --python scripts/process_blendkit_palm.py -- \
    source.glb palm_lod1.glb --ratio 0.42

The runtime LOD0 is produced separately with `gltf-transform copy`, which only
removes the unsupported Draco transport encoding and does not pass the hero mesh
through Blender.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ratio", type=float, default=0.42)
    args = parser.parse_args(argv)
    if not 0 < args.ratio <= 1:
        parser.error("--ratio must be in (0, 1]")
    return args


def triangle_count(mesh: bpy.types.Mesh) -> int:
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    output.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source), merge_vertices=False)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("source GLB contains no mesh objects")

    before = sum(triangle_count(obj.data) for obj in meshes)
    for obj in meshes:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        modifier = obj.modifiers.new(name="Authored palm LOD1", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = args.ratio
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)

    after = sum(triangle_count(obj.data) for obj in meshes)
    if after >= before:
        raise RuntimeError(f"decimation did not reduce the mesh ({before} -> {after})")

    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_image_format="AUTO",
        export_materials="EXPORT",
        export_texcoords=True,
        export_normals=True,
        export_vertex_color="ACTIVE",
        export_cameras=False,
        export_lights=False,
        export_draco_mesh_compression_enable=False,
    )
    print(f"Palm LOD1: {before} -> {after} triangles ({after / before:.1%})")


if __name__ == "__main__":
    main()
