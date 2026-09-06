"""Original, metre-scale photo-study clubhouse. No photograph pixels are used.

Blender --background --python scripts/build_grasslands_clubhouse.py
Visible proportions are inferred from the user reference, not a measured survey.
Generated model and script: CC0-1.0. Building architecture is an interpretation.
"""
import bpy
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/assets/environment/grasslands-clubhouse'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
random.seed(91842)

def material(name, color, roughness=.8, metallic=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*color, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    return mat

brick = [material(f'handmade brick {i}', (.19+i*.012, .075+i*.006, .045+i*.004)) for i in range(5)]
mortar = material('recessed warm lime mortar', (.29,.26,.21), .95)
stone = material('pale sandstone trim', (.52,.49,.39), .88)
roof = [material(f'charcoal slate {i}', (.026+i*.002,.033+i*.002,.039+i*.002), .84) for i in range(4)]
paint = material('warm off white painted timber', (.72,.70,.62), .55)
glass = material('dark window glass', (.019,.034,.04), .13, .1)
metal = material('aged dark exterior metal', (.025,.028,.026), .4, .7)
warm = material('warm lamp glass', (1,.47,.11), .25, 0, 3)
door = material('dark stained door', (.055,.038,.025), .65)
parts = {}

def cube(name, location, scale, mat, bevel=0):
    x,y,z = location
    a,b,c = (v/2 for v in scale)
    mesh(name, [(x+dx*a,y+dy*b,z+dz*c) for dx,dy,dz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]], [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], mat)

def mesh(name, verts, faces, mat):
    vertices, polygons = parts.setdefault(mat.name, ([], []))
    offset = len(vertices)
    vertices.extend(verts)
    polygons.extend(tuple(i+offset for i in face) for face in faces)

# Long facade x-axis; the photograph-facing elevation is Blender -Y.
# 38 x 11 m footprint, 3.3 m eaves, 6.4 m ridge: inferred, not surveyed.
cube('continuous stone plinth', (0,0,.16), (38.1,11.1,.32), stone)
cube('masonry shell', (0,0,1.74), (38,11,3.16), mortar)
window_centers = [-16.8,-13.6,-10.4,-7.2,-4,2.4,5.6,8.8,12,15.2,18]
for side in [-1,1]:
    for row in range(37):
        z = .35+row*.078
        for col in range(169):
            x = -18.85+col*.225+(row%2)*.1125
            if x > 18.88: continue
            if any(abs(x-w)<.57 and .9<z<2.66 for w in window_centers): continue
            if abs(x+.8)<.73 and z<2.68: continue
            cube('individual recessed-joint brick', (x,side*5.513,z), (.214,.032,.069), random.choice(brick))
    for x in window_centers:
        y = side*5.54
        cube('window recess', (x,y,1.78), (1.06,.09,1.74), door)
        cube('window glass', (x,y+side*.052,1.79), (.85,.024,1.5), glass)
        for dx in [-.49,.49,0]:
            cube('window jamb or mullion', (x+dx,y+side*.08,1.79), (.063,.09,1.67), paint, .008)
        for dz in [-.81,0,.81]:
            cube('window sill or sash', (x,y+side*.085,1.79+dz), (1.04,.105,.062), paint,.008)
        cube('stone sill', (x,y+side*.12,.89), (1.22,.27,.13), stone,.02)
        cube('stone lintel', (x,y+side*.04,2.72), (1.2,.15,.16), stone,.015)
    cube('entrance door', (-.8,side*5.55,1.45), (1.3,.13,2.58), door)
    for x in [-1.53,-.07]: cube('entrance casing', (x,side*5.63,1.48), (.12,.13,2.72), paint)
    cube('entrance lintel', (-.8,side*5.63,2.82), (1.58,.15,.16), stone)
    for x in [-17.6,-11.8,-6,0.3,6.9,13.5]:
        cube('lantern backplate', (x,side*5.61,2.39), (.17,.10,.32), metal,.02)
        cube('lantern glowing panes', (x,side*5.77,2.34), (.14,.19,.25), warm,.012)
        cube('lantern cap', (x,side*5.77,2.5), (.24,.27,.07), metal,.015)
        cube('lantern base', (x,side*5.77,2.18), (.20,.23,.05), metal,.012)
    cube('deep painted fascia', (0,side*5.89,3.31), (39,.15,.22), paint)
    cube('continuous dark rain gutter', (0,side*5.99,3.26), (39,.14,.13), metal)
    for x in [-18.9,18.9]: cube('downpipe', (x,side*5.65,1.61), (.085,.085,3.1), metal)

verts=[(-19.5,-6,3.4),(19.5,-6,3.4),(19.5,6,3.4),(-19.5,6,3.4),(-13.5,0,6.4),(13.5,0,6.4)]
mesh('four real hipped roof planes',verts,[(0,1,5,4),(1,2,5),(2,3,4,5),(3,0,4)],roof[0])
# Fine raised slate courses, fitted to the hip planes rather than a roof texture.
for side in [-1,1]:
    for row in range(26):
        t0=row/26; t1=(row+.9)/26
        y0=side*6*(1-t0); y1=side*6*(1-t1)
        z0=3.41+3*t0; z1=3.41+3*t1
        extent0=19.5-6*t0; extent1=19.5-6*t1
        count=math.ceil(2*extent1/.65)
        for col in range(count):
            x0=-extent1+col*2*extent1/count+.008
            x1=-extent1+(col+1)*2*extent1/count-.008
            face=[(x0,y0,z0),(x1,y0,z0),(x1,y1,z1),(x0,y1,z1)]
            mesh('individual slate roof course',face,[(0,1,2,3)] if side<0 else [(3,2,1,0)],random.choice(roof))
for x in [-8,8]:
    cube('ridge vent base', (x,0,6.45), (.95,.95,.25), metal)
    cube('cupola painted body', (x,0,6.85), (.62,.62,.6), paint)
    for side in [-1,1]:
        for z in [6.64,6.75,6.86,6.97]: cube('cupola vent louvre',(x,side*.33,z),(.56,.10,.055),metal)
    mesh('cupola pyramidal cap',[(x-.49,-.49,7.14),(x+.49,-.49,7.14),(x+.49,.49,7.14),(x-.49,.49,7.14),(x,0,7.48)],[(0,1,4),(1,2,4),(2,3,4),(3,0,4)],metal)

# One mesh per authored material: retain detail without thousands of scene objects.
for name, (vertices, polygons) in parts.items():
    data=bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], polygons)
    data.update()
    obj=bpy.data.objects.new(name,data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(bpy.data.materials[name])
bpy.context.scene.unit_settings.system='METRIC'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'grasslands-clubhouse.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT/'grasslands-clubhouse.glb'), export_format='GLB', export_yup=True)
print('GRASSLANDS_CLUBHOUSE_COMPLETE', OUT)
