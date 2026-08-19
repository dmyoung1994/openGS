"""Rebuild Pine Tree 01 LOD1 from the already processed LOD0 derivative.

The first LOD1 bake collapsed the high-resolution trunk too aggressively and
produced long sliver triangles at UV seams.  This pass starts from the known
role-separated, texture-embedded LOD0, decimates each semantic object with
less aggressive ratios, and deliberately leaves Blender's source triangulation
alone (``use_collapse_triangulate`` is false).  That keeps the crown volumetric
while avoiding a second triangulation pass over collapsed edges.

Usage (Blender):
  blender --background --python scripts/rebuild_pine_lod1_safe.py -- \
    --input public/assets/trees/pine_tree_01_lod0.glb \
    --output public/assets/trees/pine_tree_01_lod1.glb
"""

from __future__ import annotations

import argparse
from pathlib import Path
import bpy


TARGET_FACES = {
    "branches": 1800,
    "foliage": 16000,
    "trunk": 4000,
}


def args() -> argparse.Namespace:
    argv = __import__("sys").argv
    values = argv[argv.index("--") + 1 :]
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    return p.parse_args(values)


def role(obj: bpy.types.Object) -> str:
    name = f"{obj.name} {obj.data.materials[0].name if obj.data.materials else ''}".lower()
    if "foliage" in name or "twig" in name or "needle" in name:
        return "foliage"
    if "branch" in name or "dead" in name:
        return "branches"
    if "trunk" in name or "bark" in name:
        return "trunk"
    raise RuntimeError(f"cannot classify Pine role: {obj.name}")


def main() -> None:
    a = args()
    output = Path(a.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(Path(a.input).resolve()))

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if len(meshes) != 3:
        raise RuntimeError(f"expected 3 semantic mesh objects, got {len(meshes)}")
    for obj in meshes:
        semantic = role(obj)
        before = len(obj.data.polygons)
        target = TARGET_FACES[semantic]
        if before > target:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new(f"pine_safe_{semantic}_lod1", "DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = target / before
            # Input GLBs are already triangulated. Re-triangulating after edge
            # collapse creates the fan-like slivers this derivative replaces.
            modifier.use_collapse_triangulate = False
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        print(f"SAFE_ROLE role={semantic} faces={before}->{len(obj.data.polygons)} target={target}")
        obj.name = f"pine_tree_01_{semantic}_lod1"

    # Ensure every role remains grounded at the same authored origin.
    minimum = min(v.co.z for obj in meshes for v in obj.data.vertices)
    for obj in meshes:
        for vertex in obj.data.vertices:
            vertex.co.z -= minimum
        obj.location = (0, 0, 0)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_selection=True,
        export_apply=False, export_texcoords=True, export_normals=True,
        export_materials="EXPORT", export_image_format="AUTO",
        export_texture_dir=str(output.parent), export_keep_originals=False,
        export_yup=True,
    )
    print(f"SAFE_DONE output={output} bytes={output.stat().st_size}")


if __name__ == "__main__":
    main()
