"""Per-material triangle/bounds/texture-color report for a candidate .blend.

Usage: blender -b <in.blend> --python scripts/inspect_roles.py -- <in.blend>
Emits one JSON object on stdout after the blend reads.
"""
import json
import sys

import bpy
from mathutils import Vector


def main(path: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.open_mainfile(filepath=path)

    # Map each mesh material slot -> tri count, bounds, and sampled base color.
    report = {"file": path, "slots": [], "textures": {}}
    slot_index = {}

    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        for slot_pos, slot in enumerate(obj.material_slots):
            mat = slot.material
            name = mat.name if mat else '(none)'
            key = f'{obj.name}/{slot_pos}:{name}'
            entry = slot_index.setdefault(key, {
                'object': obj.name, 'material': name, 'tris': 0,
                'min': [1e18, 1e18, 1e18], 'max': [-1e18, -1e18, -1e18],
            })
            for poly in mesh.polygons:
                if poly.material_index != slot_pos:
                    continue
                entry['tris'] += len(poly.vertices) - 2
                for vi in poly.vertices:
                    w = obj.matrix_world @ mesh.vertices[vi].co
                    for axis in range(3):
                        entry['min'][axis] = min(entry['min'][axis], w[axis])
                        entry['max'][axis] = max(entry['max'][axis], w[axis])

    for entry in slot_index.values():
        entry['size'] = [round(entry['max'][a] - entry['min'][a], 2) for a in range(3)]
        entry['centre'] = [round((entry['max'][a] + entry['min'][a]) / 2, 2) for a in range(3)]
        del entry['min'], entry['max']
        report['slots'].append(entry)

    # Sample the dominant RGB of every color (non-normal/rough) image, to know
    # whether foliage is green or golden.
    seen = set()
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type != 'TEX_IMAGE' or node.image is None:
                continue
            img = node.image
            if img.name in seen:
                continue
            seen.add(img.name)
            w, h = img.size
            if w < 8 or h < 8 or w * h > 4 * 1024 * 1024:
                continue
            px = list(img.pixels)
            # Sample every 7th texel, skip near-transparent.
            step = 7 * 4
            rs = gs = bs = n = 0
            for i in range(0, len(px) - 3, step):
                r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
                if a < 0.5:
                    continue
                rs += r
                gs += g
                bs += b
                n += 1
            if n > 0:
                report['textures'][img.name] = {
                    'size': [w, h],
                    'mean_rgb': [round(rs / n, 3), round(gs / n, 3), round(bs / n, 3)],
                    'alpha_samples': n,
                }

    print('===JSON===')
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
