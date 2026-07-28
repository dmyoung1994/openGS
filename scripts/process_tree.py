# Blender headless: import a Poly Haven photoscan tree (gltf), decimate to a
# game-ready triangle budget, shrink textures, and export a compact GLB for
# instancing in Three.js.
#
#   Blender --background --python process_tree.py -- <in.gltf> <out.glb> <target_faces> <tex_size>
import bpy, sys, os

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]
target_faces = int(argv[2]) if len(argv) > 2 else 6000
tex_size = int(argv[3]) if len(argv) > 3 else 512

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active

faces_before = len(obj.data.polygons)
ratio = min(1.0, target_faces / max(1, faces_before))
dec = obj.modifiers.new('dec', 'DECIMATE')
dec.decimate_type = 'COLLAPSE'
dec.ratio = ratio
dec.use_collapse_triangulate = True
bpy.ops.object.modifier_apply(modifier=dec.name)

# Shrink textures for a distant tree line.
for img in bpy.data.images:
    if img.has_data and max(img.size) > tex_size:
        img.scale(tex_size, tex_size)

# Sit the tree on the origin/ground.
obj.location = (0, 0, 0)

bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=out, export_format='GLB', use_selection=True,
    export_draco_mesh_compression_enable=False,  # avoid needing a DRACOLoader in Three
    export_yup=True,
)
print(f"TREE_DONE faces {faces_before} -> {len(obj.data.polygons)} size {os.path.getsize(out)}")
