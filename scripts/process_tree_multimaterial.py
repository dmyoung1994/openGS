# Blender headless: import a Poly Haven photoscan tree (gltf), decimate it to a
# game-ready budget, and export a compact GLB for instancing in Three.js.
#
# Unlike the original process_tree.py, this decimates PER MATERIAL so the leaf
# canopy survives. The old script joined everything and collapse-decimated at a
# single tiny global ratio (~0.002), which preferentially deleted the many small
# disconnected leaf islands -> the entire leaves material vanished from the GLB,
# leaving bare trunk+branch "dead sticks". Here we separate by material, give the
# canopy a far larger face budget than the trunk, then rejoin and export.
#
#   Blender --background --python process_tree2.py -- <in.gltf> <out.glb> <tex_size>
import bpy, sys, os

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]
tex_size = int(argv[2]) if len(argv) > 2 else 512

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

# Join every imported mesh into one object so we can re-split cleanly by material.
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active

# Split into one object per material slot.
bpy.context.view_layer.objects.active = obj
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.separate(type='MATERIAL')
bpy.ops.object.mode_set(mode='OBJECT')

# Per-material face budgets. Foliage keeps far more geometry than the trunk so the
# canopy reads as a full volume; trunk/branches decimate hard since they are small.
def budget_for(name):
    n = name.lower()
    if any(k in n for k in ('leaf', 'leaves', 'twig', 'needle')):
        return 14000   # the canopy — the part that must stay lush
    if 'branch' in n:
        return 5000
    if any(k in n for k in ('bark', 'trunk', 'stem')):
        return 3000
    return 4000

parts = [o for o in bpy.data.objects if o.type == 'MESH']
for o in parts:
    mat = o.data.materials[0].name if o.data.materials else ''
    faces = len(o.data.polygons)
    target = budget_for(mat)
    ratio = min(1.0, target / max(1, faces))
    if ratio < 1.0:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = ratio
        m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)
    print(f"  part {mat!r}: {faces} -> {len(o.data.polygons)} faces (target {target})")

# Rejoin all parts back into a single multi-material object.
bpy.ops.object.select_all(action='DESELECT')
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
if len(parts) > 1:
    bpy.ops.object.join()
final = bpy.context.view_layer.objects.active
final.location = (0, 0, 0)

# Shrink textures for a distant tree line.
for img in bpy.data.images:
    if img.has_data and max(img.size) > tex_size:
        img.scale(tex_size, tex_size)

bpy.ops.object.select_all(action='DESELECT')
final.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=out, export_format='GLB', use_selection=True,
    export_draco_mesh_compression_enable=False,
    export_yup=True,
)
print(f"TREE_DONE -> {len(final.data.polygons)} faces, {os.path.getsize(out)} bytes, {out}")
