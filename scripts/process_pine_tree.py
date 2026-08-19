"""Bake the Poly Haven Pine Tree 01 into role-preserving runtime LOD GLBs.

The source is a dense, fully modeled conifer (not a flat leaf-card tree).  The
source has three authored variants and six materials.  This baker chooses one
variant, remaps those materials into exactly three semantic roles, then
decimates each role independently so the needle crown cannot be deleted by a
single global ratio.  The output contract is the same three-part prototype used
by ``src/scene/Trees.js``: trunk, branches/deadwood, and needle foliage.

Usage:
  blender --background --python scripts/process_pine_tree.py -- \
    --input public/assets/trees_src/pine_tree_01/pine_tree_01_1k.gltf \
    --output public/assets/trees/pine_tree_01_lod0.glb --lod 0
"""

from __future__ import annotations

import argparse
import bpy
from pathlib import Path


ROLE_ORDER = ("trunk", "branches", "foliage")


def parse_args() -> argparse.Namespace:
    argv = __import__("sys").argv[__import__("sys").argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--variant", default="b", choices=("a", "b", "c"))
    parser.add_argument("--lod", type=int, choices=(0, 1), required=True)
    parser.add_argument("--tex-size", type=int, default=1024)
    return parser.parse_args(argv)


def role_for_material(name: str) -> str:
    lowered = name.lower()
    if "twig" in lowered or "needle" in lowered or "foliage" in lowered:
        return "foliage"
    if "dead" in lowered or "branch" in lowered:
        return "branches"
    return "trunk"


def target_faces(role: str, lod: int) -> int:
    # Pine Tree 01's source needle geometry is deliberately dense (4M+ tris per
    # variant).  96k leaves preserve the layered crown while avoiding the old
    # 500k+ face fir cost; LOD1 remains volumetric and never becomes a card.
    if lod == 0:
        return {"trunk": 9000, "branches": 10000, "foliage": 96000}[role]
    return {"trunk": 2200, "branches": 2600, "foliage": 24000}[role]


def make_role_material(source: bpy.types.Material, role: str) -> bpy.types.Material:
    material = source.copy()
    material.name = f"pine_tree_01_{role}"
    if role == "foliage":
        # The source is opaque modeled needles; keep it opaque so the runtime
        # PBR path never turns it into black alpha cardboard.
        material.surface_render_method = "DITHERED"
    return material


def apply_role_decimate(obj: bpy.types.Object, role: str, lod: int) -> None:
    before = len(obj.data.polygons)
    target = target_faces(role, lod)
    if before > target:
        modifier = obj.modifiers.new(f"pine_{role}_lod{lod}_decimate", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = target / before
        modifier.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    print(f"ROLE role={role} lod={lod} faces={before}->{len(obj.data.polygons)} target={target}")


def main() -> None:
    args = parse_args()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))

    wanted = f"pine_tree_01_{args.variant}_LOD0"
    source = next((o for o in bpy.context.scene.objects if o.type == "MESH" and o.name == wanted), None)
    if source is None:
        raise RuntimeError(f"missing source variant {wanted}")
    # The source glTF places variants side-by-side for review. Remove that
    # presentation translation before exporting the playable prototype.
    source.location = (0, 0, 0)
    bpy.context.view_layer.objects.active = source
    source.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for obj in list(bpy.context.scene.objects):
        if obj != source:
            bpy.data.objects.remove(obj, do_unlink=True)

    # Split the source into one object per material, classify, then join each
    # semantic role. This keeps all parts and their bounds while enforcing the
    # loader's stable three-role contract.
    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    by_role: dict[str, list[bpy.types.Object]] = {role: [] for role in ROLE_ORDER}
    for piece in pieces:
        if not piece.data.materials:
            raise RuntimeError(f"source piece {piece.name} has no material")
        role = role_for_material(piece.data.materials[0].name)
        by_role[role].append(piece)

    role_objects: list[bpy.types.Object] = []
    for role in ROLE_ORDER:
        parts = by_role[role]
        if not parts:
            raise RuntimeError(f"source has no {role} geometry")
        source_material = parts[0].data.materials[0]
        role_material = make_role_material(source_material, role)
        for part in parts:
            part.data.materials.clear()
            part.data.materials.append(role_material)
            for polygon in part.data.polygons:
                polygon.material_index = 0
        bpy.ops.object.select_all(action="DESELECT")
        for part in parts:
            part.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        if len(parts) > 1:
            bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = f"pine_tree_01_{role}_lod{args.lod}"
        apply_role_decimate(merged, role, args.lod)
        role_objects.append(merged)

    # Normalize the ground contact after decimation. Keep the source's authored
    # vertical scale; only remove tiny negative noise so placement burial remains
    # deterministic and consistent across both LODs.
    minimum = min(vertex.co.z for obj in role_objects for vertex in obj.data.vertices)
    for obj in role_objects:
        for vertex in obj.data.vertices:
            vertex.co.z -= minimum
        obj.location = (0, 0, 0)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in role_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = role_objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_selection=True,
        export_apply=False, export_texcoords=True, export_normals=True,
        export_materials="EXPORT", export_image_format="AUTO", export_texture_dir=str(output.parent),
        # Embed the decoded source images in the GLB. Keeping originals makes
        # Blender emit 1x1 white placeholders for external glTF images, which
        # destroys the pine's green/bark albedo at runtime.
        export_keep_originals=False, export_yup=True,
    )
    print(f"PINE_TREE_DONE output={output} lod={args.lod} bytes={output.stat().st_size}")


if __name__ == "__main__":
    main()
