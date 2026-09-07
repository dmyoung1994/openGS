"""Build a whole-component mesh LOD from the exact Poly Haven Island Tree 01 GLB."""

from __future__ import annotations

import argparse
from array import array
import bpy
import hashlib
from pathlib import Path
import sys

SOURCE_SHA256 = "04352129b531b887b297e532893480374d381167cb7e1c6b161e3321266193d6"
PIPELINE_VERSION = "island-tree-01-blender-5.2-whole-component-lods@2"
TARGETS = {
    0: {"island_tree_01": 6000, "island_tree_01_leaves": 250000, "island_tree_01_branches": 75000},
    1: {"island_tree_01": 4000, "island_tree_01_leaves": 120000, "island_tree_01_branches": 40000},
}
SOURCE_MATERIAL_ORDER = ["island_tree_01", "island_tree_01_leaves", "island_tree_01_branches"]


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--level", required=True, type=int, choices=(0, 1))
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def root(parent: array, value: int) -> int:
    while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
    return value


def retain_components(obj: bpy.types.Object, target: int) -> None:
    mesh = obj.data
    parent = array("I", range(len(mesh.vertices)))
    for edge in mesh.edges:
        left, right = root(parent, edge.vertices[0]), root(parent, edge.vertices[1])
        if left != right:
            parent[max(left, right)] = min(left, right)
    counts: dict[int, int] = {}
    for polygon in mesh.polygons:
        component = root(parent, polygon.vertices[0])
        counts[component] = counts.get(component, 0) + 1

    def rank(component: int) -> int:
        value = (component ^ 0x9E3779B9) & 0xFFFFFFFF
        value ^= value >> 16
        value = (value * 0x7FEB352D) & 0xFFFFFFFF
        value ^= value >> 15
        value = (value * 0x846CA68B) & 0xFFFFFFFF
        return value ^ (value >> 16)

    retained: set[int] = set()
    faces = 0
    for component, count in sorted(counts.items(), key=lambda item: rank(item[0])):
        retained.add(component)
        faces += count
        if faces >= target:
            break
    for polygon in mesh.polygons:
        polygon.select = root(parent, polygon.vertices[0]) not in retained
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="FACE")
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"COMPONENT_LOD role={obj.name} components={len(counts)} retained={len(retained)} faces={len(mesh.polygons)}")


def main() -> None:
    options = args()
    if bpy.app.version[:2] != (5, 2):
        raise RuntimeError(f"{PIPELINE_VERSION} requires Blender 5.2.x")
    source = Path(options.input).resolve()
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Island Tree 01 source GLB SHA-256 mismatch")
    output = Path(options.output).resolve()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    tree = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    bpy.context.view_layer.objects.active = tree
    tree.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    parts = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for part in parts:
        material_name = part.data.materials[0].name
        part.name = material_name
        target = TARGETS[options.level][material_name]
        before = len(part.data.polygons)
        if material_name == "island_tree_01":
            modifier = part.modifiers.new(f"island_tree_01_lod{options.level}_decimate", "DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = min(1.0, target / before)
            modifier.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = part
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        else:
            retain_components(part, target)
        print(f"ROLE role={material_name} faces={before}->{len(part.data.polygons)} target={target}")

    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    joined = next(part for part in parts if part.name == "island_tree_01")
    bpy.context.view_layer.objects.active = joined
    bpy.ops.object.join()
    old_names = [material.name for material in joined.data.materials]
    polygon_materials = [old_names[polygon.material_index] for polygon in joined.data.polygons]
    materials = {material.name: material for material in joined.data.materials}
    joined.data.materials.clear()
    for material_name in SOURCE_MATERIAL_ORDER:
        joined.data.materials.append(materials[material_name])
    new_indices = {material_name: index for index, material_name in enumerate(SOURCE_MATERIAL_ORDER)}
    for polygon, material_name in zip(joined.data.polygons, polygon_materials):
        polygon.material_index = new_indices[material_name]
    joined.name = f"island_tree_01_LOD{options.level}"
    bpy.ops.object.select_all(action="DESELECT")
    joined.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", use_selection=True,
      export_texcoords=True, export_normals=True, export_materials="EXPORT",
      export_keep_originals=False, export_yup=True)
    result_hash = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"ISLAND_TREE_DONE pipeline={PIPELINE_VERSION} output={output} bytes={output.stat().st_size} sha256={result_hash}")


if __name__ == "__main__":
    main()
