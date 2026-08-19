"""Print source-tree inventory for asset review.

Run with Blender 5.x:
  blender --background --python scripts/inventory_tree_sources.py -- \
    public/assets/trees_src/pine_tree_01/pine_tree_01_1k.gltf

This deliberately reports every mesh/material role and world-space bounds before
the derivative bake. It is kept in the repository so future tree replacements
retain an auditable source inventory instead of silently accepting a broken
single-primitive import.
"""

from __future__ import annotations

import sys
import bpy
from mathutils import Vector


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :]
    if len(argv) != 1:
        raise SystemExit("usage: -- SOURCE.gltf")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=argv[0])
    print("TREE_SOURCE_INVENTORY")
    for obj in sorted((o for o in bpy.context.scene.objects if o.type == "MESH"), key=lambda o: o.name):
        obj.update_tag(refresh={"DATA"})
        bbox = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        lo = Vector((min(v.x for v in bbox), min(v.y for v in bbox), min(v.z for v in bbox)))
        hi = Vector((max(v.x for v in bbox), max(v.y for v in bbox), max(v.z for v in bbox)))
        print(f"mesh name={obj.name!r} polygons={len(obj.data.polygons)} vertices={len(obj.data.vertices)} bounds_min={tuple(round(v, 4) for v in lo)} bounds_max={tuple(round(v, 4) for v in hi)}")
        for slot, material in enumerate(obj.data.materials):
            if material is None:
                continue
            alpha_mode = material.surface_render_method if hasattr(material, "surface_render_method") else "unknown"
            print(f"  material slot={slot} name={material.name!r} alpha={alpha_mode}")
    print("TOTALS", sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == "MESH"))


if __name__ == "__main__":
    main()
