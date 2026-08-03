# Headless inspector: dump what a BlenderKit .blend actually contains so we can
# decide the Three.js pipeline (bake procedural material -> PBR maps, vs. export
# real grass geometry). Usage:
#   Blender --background <file.blend> --python inspect_blend.py
import bpy

print("=== OBJECTS ===")
for o in bpy.data.objects:
    mods = [m.type for m in o.modifiers] if hasattr(o, "modifiers") else []
    ngons = len(o.data.polygons) if o.type == 'MESH' and o.data else 0
    print(f"  {o.type:8} '{o.name}'  polys={ngons}  modifiers={mods}")

print("=== MATERIALS ===")
for m in bpy.data.materials:
    if not m.use_nodes:
        print(f"  '{m.name}' (no nodes)"); continue
    ntypes = {}
    has_disp = False
    for n in m.node_tree.nodes:
        ntypes[n.type] = ntypes.get(n.type, 0) + 1
        if n.type == 'OUTPUT_MATERIAL':
            disp = n.inputs.get('Displacement')
            if disp and disp.is_linked:
                has_disp = True
    print(f"  '{m.name}'  displacement_linked={has_disp}")
    print(f"      nodes={dict(sorted(ntypes.items()))}")

print("=== NODE GROUPS (geometry/shader) ===")
for g in bpy.data.node_groups:
    print(f"  {g.bl_idname}  '{g.name}'  nodes={len(g.nodes)}")

print("=== IMAGES ===")
for img in bpy.data.images:
    if img.name in ('Render Result', 'Viewer Node'):
        continue
    print(f"  '{img.name}'  size={tuple(img.size)}  file='{img.filepath}'")
