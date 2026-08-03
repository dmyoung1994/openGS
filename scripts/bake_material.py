# Headless bake: take a BlenderKit procedural material and bake it down to a set
# of tiling PBR maps (base color, roughness, normal, AO, and a HEIGHT map for
# parallax) that Three.js can use. Cycles evaluates the full procedural shader —
# including its displacement — at every surface point; we capture that into images.
#
#   Blender --background <material.blend> --python bake_material.py -- <outdir> <name> <size> <plane_m>
#
# The height map is the key output: it's what lets the real-time material fake the
# displaced-blade depth (parallax) that makes the BlenderKit preview look 3D.
import bpy, sys, os

argv = sys.argv[sys.argv.index("--") + 1:]
outdir   = argv[0]
name     = argv[1]
size     = int(argv[2]) if len(argv) > 2 else 1024
plane_m  = float(argv[3]) if len(argv) > 3 else 2.0
os.makedirs(outdir, exist_ok=True)

# The material we want is the first node-based one in the file. (Don't reset the
# file — that would free this datablock. The .blend has no objects, so we just add
# a plane into the existing scene.)
mat = next(m for m in bpy.data.materials if m.use_nodes and len(m.node_tree.nodes) > 1)
print(f"[bake] material = '{mat.name}'  plane={plane_m}m  size={size}")

# A single UV-unwrapped plane wearing the material.
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_plane_add(size=plane_m)
plane = bpy.context.active_object
plane.data.materials.append(mat)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.uv.smart_project(angle_limit=1.15)
bpy.ops.object.mode_set(mode='OBJECT')

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = int(argv[4]) if len(argv) > 4 else 16
scene.cycles.use_denoising = True
scene.render.bake.margin = size // 64
scene.render.bake.use_selected_to_active = False

nt = mat.node_tree
out_node = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')

def new_target(suffix, non_color):
    img = bpy.data.images.new(f"{name}_{suffix}", width=size, height=size)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.nodes.active = tex
    return img, tex

def save(img, suffix):
    p = os.path.join(outdir, f"{name}_{suffix}.png")
    img.filepath_raw = p
    img.file_format = 'PNG'
    img.save()
    print(f"[bake] wrote {p}")

def bake(kind, **kw):
    bpy.ops.object.bake(type=kind, **kw)

# --- base color (albedo only, no lighting) ---
img, tex = new_target('basecolor', non_color=False)
bake('DIFFUSE', pass_filter={'COLOR'})
save(img, 'basecolor'); nt.nodes.remove(tex)

# --- roughness ---
img, tex = new_target('roughness', non_color=True)
bake('ROUGHNESS')
save(img, 'roughness'); nt.nodes.remove(tex)

# --- tangent-space normal ---
img, tex = new_target('normal', non_color=True)
bake('NORMAL', normal_space='TANGENT')
save(img, 'normal'); nt.nodes.remove(tex)

# (No AO pass: the bake plane is flat, so procedural micro-blades cast no real
# occlusion — an AO bake here is just white. The height map carries that depth.)

# --- HEIGHT: route the displacement signal into an Emission and bake EMIT. The
# signal is whatever feeds Output.Displacement — here the 'Procedural Grass' group's
# 'Displacement' output socket (a height scalar), which is exactly what parallax needs.
disp_sock = out_node.inputs.get('Displacement')
if disp_sock and disp_sock.is_linked:
    fn = disp_sock.links[0].from_node
    src = disp_sock.links[0].from_socket
    # If a Displacement node sits in between, prefer its scalar Height input.
    if fn.type == 'DISPLACEMENT' and fn.inputs['Height'].is_linked:
        src = fn.inputs['Height'].links[0].from_socket
    emit = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(src, emit.inputs['Color'])
    surf = out_node.inputs['Surface']
    saved = surf.links[0].from_socket if surf.is_linked else None
    nt.links.new(emit.outputs['Emission'], surf)
    # Bake into a FLOAT buffer so the sub-millimetre displacement isn't crushed to
    # black, then normalize by the actual max so the 8-bit PNG spans the full 0..1
    # range (parallax reads relative height, so absolute scale is set in-engine).
    import numpy as np
    hy = bpy.data.images.new(f"{name}_height", width=size, height=size, float_buffer=True)
    hy.colorspace_settings.name = 'Non-Color'
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = hy; nt.nodes.active = tex
    bake('EMIT')
    px = np.empty(len(hy.pixels), dtype=np.float32); hy.pixels.foreach_get(px)
    px = px.reshape(-1, 4); mx = float(px[:, 0].max())
    if mx > 1e-9:
        px[:, 0:3] = np.clip(px[:, 0:3] / mx, 0.0, 1.0)
    px[:, 3] = 1.0
    hy.pixels.foreach_set(px.reshape(-1)); hy.update()
    save(hy, 'height'); nt.nodes.remove(tex)
    if saved:
        nt.links.new(saved, surf)
    print(f"[bake] height baked from '{fn.name}' :: '{src.name}'  raw_max={mx:.6f}")
else:
    print("[bake] WARNING: material has no linked Displacement — no height map")

print("[bake] done")
