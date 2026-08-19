"""Quick neutral preview render of a tree blend for species/shape review.

Usage: blender -b <in.blend> --python scripts/preview_tree.py -- <out.png> [cam_dist_scale]
"""
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out = argv[0]
dist_scale = float(argv[1]) if len(argv) > 1 else 1.0

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 720
scene.render.resolution_y = 960
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'

# Neutral world + single sun so materials read true.
world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
world.use_nodes = True
bg = world.node_tree.nodes.get('Background')
bg.inputs[0].default_value = (0.72, 0.76, 0.80, 1.0)
bg.inputs[1].default_value = 0.55
scene.world = world

for light in [o for o in bpy.data.objects if o.type == 'LIGHT']:
    bpy.data.objects.remove(light, do_unlink=True)
sun_data = bpy.data.lights.new('sun', 'SUN')
sun_data.energy = 1.4
sun_data.color = (1.0, 0.96, 0.9)
sun = bpy.data.objects.new('sun', sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(55), 0, math.radians(-35))

# Bounds of all visible meshes.
minv = Vector((1e18, 1e18, 1e18))
maxv = Vector((-1e18, -1e18, -1e18))
n = 0
for obj in bpy.data.objects:
    if obj.type != 'MESH' or not obj.visible_get():
        continue
    n += 1
    for corner in obj.bound_box:
        w = obj.matrix_world @ Vector(corner)
        minv.x = min(minv.x, w.x)
        minv.y = min(minv.y, w.y)
        minv.z = min(minv.z, w.z)
        maxv.x = max(maxv.x, w.x)
        maxv.y = max(maxv.y, w.y)
        maxv.z = max(maxv.z, w.z)
if n == 0:
    raise SystemExit('no visible meshes')
centre = (minv + maxv) / 2
size = max(maxv.x - minv.x, maxv.y - minv.y, maxv.z - minv.z)

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 50
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
d = size * 1.9 * dist_scale
cam.location = centre + Vector((d, d * 0.9, size * 0.55))
direction = centre - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam

scene.render.filepath = out
bpy.ops.render.render(write_still=True)
