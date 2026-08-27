# Headless bake: take a BlenderKit procedural material and bake it down to a set
# of tiling PBR maps (base color, roughness, normal, AO, and a HEIGHT map for
# parallax) that Three.js can use. Cycles evaluates the full procedural shader —
# including its displacement — at every surface point; we capture that into images.
#
#   Blender --background <material.blend> --python bake_material.py -- <outdir> <name> <size> <plane_m> <samples>
#
# The height map is the key output: it's what lets the real-time material fake the
# displaced-blade depth (parallax) that makes the BlenderKit preview look 3D.
import bpy, sys, os

argv = sys.argv[sys.argv.index("--") + 1:]
outdir   = argv[0]
name     = argv[1]
size     = int(argv[2]) if len(argv) > 2 else 2048
plane_m  = float(argv[3]) if len(argv) > 3 else 2.0
samples  = int(argv[4]) if len(argv) > 4 else 64
os.makedirs(outdir, exist_ok=True)

# The material we want is the first node-based one in the file. (Don't reset the
# file — that would free this datablock. The .blend has no objects, so we just add
# a plane into the existing scene.)
mat = next(m for m in bpy.data.materials if m.use_nodes and len(m.node_tree.nodes) > 1)
print(f"[bake] material = '{mat.name}'  plane={plane_m}m  size={size}")

# A single exact 0..1 UV plane wearing the material. Blender's primitive plane already
# has the required square UVs; smart-projecting it can inset or rotate the island and
# turns a seamless procedural source into a bake with padded edges.
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_plane_add(size=plane_m)
plane = bpy.context.active_object
plane.data.materials.append(mat)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = samples
scene.cycles.use_denoising = False
scene.render.bake.margin = size // 64
scene.render.bake.use_selected_to_active = False
scene.render.image_settings.color_depth = '8'

# CPU is the reproducible default. Metal can be requested explicitly, but compiling
# Cycles' first shader-evaluation kernel can take several minutes on a clean machine.
# These procedural COLOR/NORMAL/ROUGHNESS bakes are deterministic; resolution and
# subpixel sampling, not path-tracing noise, are the quality limits.
bake_device = os.environ.get('GOLFSIM_BAKE_DEVICE', 'CPU').upper()
if bake_device == 'METAL':
    try:
        cycles = bpy.context.preferences.addons['cycles'].preferences
        cycles.compute_device_type = 'METAL'
        cycles.get_devices()
        gpu_devices = [device for device in cycles.devices if device.type != 'CPU']
        for device in cycles.devices:
            device.use = device in gpu_devices
        if not gpu_devices:
            raise RuntimeError('no Metal device was reported by Cycles')
        scene.cycles.device = 'GPU'
        print(f"[bake] device = METAL ({', '.join(device.name for device in gpu_devices)})")
    except Exception as error:
        scene.cycles.device = 'CPU'
        print(f"[bake] device = CPU (Metal unavailable: {error})")
else:
    scene.cycles.device = 'CPU'
    print('[bake] device = CPU')

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
    # Blendkit commonly wraps the Displacement node inside the material group. Expose
    # its scalar Height through a temporary group output instead of baking the vector
    # displacement socket (which can be negative and collapsed the old export to black).
    elif fn.type == 'GROUP' and fn.node_tree:
        group_tree = fn.node_tree
        group_output = next((n for n in group_tree.nodes if n.type == 'GROUP_OUTPUT'), None)
        inner_target = group_output.inputs.get(src.name) if group_output else None
        if inner_target and inner_target.is_linked:
            inner_node = inner_target.links[0].from_node
            if inner_node.type == 'DISPLACEMENT' and inner_node.inputs['Height'].is_linked:
                inner_height = inner_node.inputs['Height'].links[0].from_socket
                height_name = 'Bake Height'
                if group_tree.interface.items_tree.get(height_name) is None:
                    group_tree.interface.new_socket(
                        name=height_name, in_out='OUTPUT', socket_type='NodeSocketFloat')
                height_target = group_output.inputs.get(height_name)
                for link in list(height_target.links):
                    group_tree.links.remove(link)
                group_tree.links.new(inner_height, height_target)
                src = fn.outputs.get(height_name)
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
    px = px.reshape(-1, 4)
    lo, hi = np.percentile(px[:, 0], [0.5, 99.5])
    px[:, 0:3] = np.clip((px[:, 0:3] - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
    px[:, 3] = 1.0
    hy.pixels.foreach_set(px.reshape(-1)); hy.update()
    save(hy, 'height'); nt.nodes.remove(tex)
    if saved:
        nt.links.new(saved, surf)
    print(f"[bake] height baked from '{fn.name}' :: '{src.name}'  raw_range={lo:.6f}..{hi:.6f}")
else:
    # Some excellent turf materials are entirely procedural in colour and
    # roughness and deliberately expose no Material Output displacement. Keep
    # their runtime representation height-aware by exporting one of the source
    # material's own fine procedural fields as a normalized micro-height map.
    # This is only a bake-time bridge; the browser still owns lighting and never
    # executes Blender nodes.
    group_node = next((n for n in nt.nodes if n.type == 'GROUP' and n.node_tree), None)
    height_name = 'Bake Height'
    if group_node:
        group_tree = group_node.node_tree
        group_output = next((n for n in group_tree.nodes if n.type == 'GROUP_OUTPUT'), None)
        if group_output:
            output_socket = group_tree.interface.items_tree.get(height_name)
            if output_socket is None:
                output_socket = group_tree.interface.new_socket(
                    name=height_name, in_out='OUTPUT', socket_type='NodeSocketFloat')
            target = group_output.inputs.get(height_name)
            noise = next((n for n in group_tree.nodes
                          if n.type == 'TEX_NOISE' and '001' in n.name), None)
            noise = noise or next((n for n in group_tree.nodes if n.type == 'TEX_NOISE'), None)
            if target and noise and noise.outputs.get('Fac'):
                for link in list(target.links):
                    group_tree.links.remove(link)
                group_tree.links.new(noise.outputs['Fac'], target)
                src = group_node.outputs.get(height_name)
                emit = nt.nodes.new('ShaderNodeEmission')
                nt.links.new(src, emit.inputs['Color'])
                surf = out_node.inputs['Surface']
                saved = surf.links[0].from_socket if surf.is_linked else None
                nt.links.new(emit.outputs['Emission'], surf)
                import numpy as np
                hy = bpy.data.images.new(f"{name}_height", width=size, height=size, float_buffer=True)
                hy.colorspace_settings.name = 'Non-Color'
                tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = hy; nt.nodes.active = tex
                bake('EMIT')
                px = np.empty(len(hy.pixels), dtype=np.float32); hy.pixels.foreach_get(px)
                px = px.reshape(-1, 4)
                lo, hi = np.percentile(px[:, 0], [1.0, 99.0])
                px[:, 0:3] = np.clip((px[:, 0:3] - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
                px[:, 3] = 1.0
                hy.pixels.foreach_set(px.reshape(-1)); hy.update()
                save(hy, 'height'); nt.nodes.remove(tex); nt.nodes.remove(emit)
                if saved:
                    nt.links.new(saved, surf)
                print(f"[bake] height baked from '{group_tree.name}:{noise.name}:Fac' via group output")
            else:
                print("[bake] WARNING: material has no displacement or scalar noise height source")
        else:
            print("[bake] WARNING: material has no displacement or group output for height source")
    else:
        print("[bake] WARNING: material has no displacement or procedural group height source")

print("[bake] done")
