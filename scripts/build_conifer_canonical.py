#!/usr/bin/env python3
"""Build a compact, volumetric alpine conifer derivative and its impostor atlas.

The source reference is Poly Haven's CC0 ``fir_tree_01``.  The old derivative
kept only a small fraction of the source needle sheets, which made the tree read
as a bare trunk and cost more than half a million vertices after the bad
triangles survived decimation.  This baker emits a deterministic, fully opaque
hero mesh made from tapered structural wood and low-poly needle sprigs.  It is
deliberately authored offline: runtime only loads the indexed GLBs and the
neutral eight-view atlas.

The mesh is intentionally one primitive with COLOR_0 role albedo (brown wood or
green needles), matching TreeBeautyLod's canonical one-draw contract.  LOD 0
keeps 15 branch whorls and dense sprig clusters; LOD 1 keeps 9 whorls and a
quarter of the foliage clusters.  Both retain a solid trunk and broad crown.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

HEIGHT = 18.895
WIDTH = 6.467
DEPTH = 6.387
WOOD = (0.105, 0.052, 0.022, 1.0)
WOOD_LIGHT = (0.16, 0.078, 0.029, 1.0)
NEEDLE = (0.045, 0.17, 0.030, 1.0)
NEEDLE_DARK = (0.022, 0.090, 0.018, 1.0)


def align4(value: int) -> int:
    return (value + 3) & ~3


class Mesh:
    def __init__(self):
        self.positions: list[tuple[float, float, float]] = []
        self.normals: list[list[float]] = []
        self.colors: list[tuple[float, float, float, float]] = []
        self.indices: list[int] = []
        self.triangles: list[tuple[int, int, int, tuple[float, float, float, float]]] = []

    def vertex(self, point, color):
        self.positions.append(tuple(float(x) for x in point))
        self.normals.append([0.0, 0.0, 0.0])
        self.colors.append(color)
        return len(self.positions) - 1

    def triangle(self, a, b, c, color):
        ia, ib, ic = self.vertex(a, color), self.vertex(b, color), self.vertex(c, color)
        self.indices.extend((ia, ib, ic))
        self.triangles.append((ia, ib, ic, color))

    def quad(self, a, b, c, d, color):
        self.triangle(a, b, d, color)
        self.triangle(b, c, d, color)

    def finish_normals(self):
        for ia, ib, ic, _ in self.triangles:
            a, b, c = self.positions[ia], self.positions[ib], self.positions[ic]
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
            for index in (ia, ib, ic):
                self.normals[index][0] += n[0]
                self.normals[index][1] += n[1]
                self.normals[index][2] += n[2]
        normals = []
        for x, y, z in self.normals:
            length = math.sqrt(x * x + y * y + z * z) or 1.0
            normals.append((x / length, y / length, z / length))
        self.normals = normals


def basis(axis):
    ax, ay, az = axis
    length = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
    ax, ay, az = ax / length, ay / length, az / length
    ref = (0.0, 1.0, 0.0) if abs(ay) < 0.9 else (1.0, 0.0, 0.0)
    u = (ay * ref[2] - az * ref[1], az * ref[0] - ax * ref[2], ax * ref[1] - ay * ref[0])
    ul = math.sqrt(sum(v * v for v in u)) or 1.0
    u = tuple(v / ul for v in u)
    v = (ay * u[2] - az * u[1], az * u[0] - ax * u[2], ax * u[1] - ay * u[0])
    return (ax, ay, az), u, v


def add_tapered_cylinder(mesh, start, end, r0, r1, sides, color, phase=0.0):
    axis = (end[0] - start[0], end[1] - start[1], end[2] - start[2])
    _, u, v = basis(axis)
    rings = []
    for centre, radius in ((start, r0), (end, r1)):
        ring = []
        for i in range(sides):
            angle = phase + math.tau * i / sides
            cs, sn = math.cos(angle), math.sin(angle)
            ring.append(tuple(centre[j] + radius * (u[j] * cs + v[j] * sn) for j in range(3)))
        rings.append(ring)
    for i in range(sides):
        mesh.quad(rings[0][i], rings[0][(i + 1) % sides], rings[1][(i + 1) % sides], rings[1][i], color)
    # Caps make the trunk genuinely opaque at the ground and at branch joins.
    mesh.triangle(start, rings[0][1], rings[0][0], color)
    mesh.triangle(end, rings[1][0], rings[1][1], color)


def add_sprig(mesh, centre, axis, length, radius, color, phase):
    """A faceted, three-dimensional needle bundle, not a camera-facing card."""
    direction, u, v = basis(axis)
    points = []
    # A swollen middle and tapered tips gives each cluster a natural droop/
    # needle-mass profile while remaining cheap enough for a large forest.
    stations = ((-0.52, 0.025), (-0.16, radius), (0.20, radius * 0.86), (0.52, 0.018))
    sides = 5
    for longitudinal, r in stations:
        c = tuple(centre[j] + direction[j] * length * longitudinal for j in range(3))
        points.append([tuple(c[j] + r * (u[j] * math.cos(phase + math.tau * i / sides) + v[j] * math.sin(phase + math.tau * i / sides)) for j in range(3)) for i in range(sides)])
    for station in range(len(points) - 1):
        for i in range(sides):
            mesh.quad(points[station][i], points[station][(i + 1) % sides], points[station + 1][(i + 1) % sides], points[station + 1][i], color)
    mesh.triangle(points[0][0], points[0][1], tuple(centre[j] - direction[j] * length * 0.56 for j in range(3)), color)
    mesh.triangle(tuple(centre[j] + direction[j] * length * 0.56 for j in range(3)), points[-1][1], points[-1][0], color)


def create_tree(lod: int) -> Mesh:
    rng = random.Random(0xC01F3E + lod * 0x9E3779B9)
    mesh = Mesh()
    # A gently irregular, tapered leader and a small buttress flare make the
    # opaque wood visible below the lowest foliage from every azimuth.
    trunk_points = []
    trunk_steps = 20
    for i in range(trunk_steps + 1):
        t = i / trunk_steps
        y = HEIGHT * t
        trunk_points.append((0.12 * math.sin(t * 2.4), y, 0.10 * math.sin(t * 1.7 + 0.5)))
    for i in range(trunk_steps):
        t = i / trunk_steps
        r0 = 0.39 * (1 - t) ** 0.72 + 0.034
        r1 = 0.39 * (1 - (i + 1) / trunk_steps) ** 0.72 + 0.034
        add_tapered_cylinder(mesh, trunk_points[i], trunk_points[i + 1], r0, r1, 10, WOOD if i % 3 else WOOD_LIGHT, phase=0.12 * i)

    whorls = 14 if lod == 0 else 9
    per_whorl = 7 if lod == 0 else 5
    # The source-derived version read as a ladder because every foliage strip
    # shared one horizontal axis. A real fir crown is a cloud of short sprays:
    # keep the same deterministic budget, but distribute each spray through a
    # broad vertical cone around its branch direction.
    sprigs_per_branch = 13 if lod == 0 else 6
    # Lower branches are broad and droop; the crown tightens toward the leader.
    for level in range(whorls):
        t = (level + 0.55) / whorls
        y = 1.42 + (HEIGHT - 2.12) * t + (rng.random() - 0.5) * 0.22
        width = math.sin(math.pi * (0.10 + 0.86 * t)) ** 0.63
        length = 0.76 + 2.34 * width * (0.90 + rng.random() * 0.16)
        whorl_phase = rng.random() * math.tau
        for branch_index in range(per_whorl):
            angle = whorl_phase + math.tau * branch_index / per_whorl + (rng.random() - 0.5) * 0.12
            root = (0.12 * math.sin(y * 0.13), y, 0.10 * math.sin(y * 0.08 + 0.5))
            down = 0.04 + 0.30 * (1.0 - t) + rng.random() * 0.12
            lift = (rng.random() - 0.5) * 0.22 + 0.08 * math.sin(level * 1.7 + branch_index)
            elbow = (root[0] + math.cos(angle) * length * 0.46, y + lift * 0.35 - down * 0.35, root[2] + math.sin(angle) * length * 0.46)
            tip = (root[0] + math.cos(angle) * length, y + lift - down, root[2] + math.sin(angle) * length)
            add_tapered_cylinder(mesh, root, elbow, 0.12 * (1 - 0.3 * t), 0.055, 6, WOOD_LIGHT, phase=angle)
            add_tapered_cylinder(mesh, elbow, tip, 0.055, 0.014, 5, WOOD, phase=angle + 0.4)
            # Small upward/downward secondary twigs improve radial volume and
            # break the silhouette's repeated horizontal ladder.
            for twig_index in range(2 if lod == 0 else 1):
                frac = 0.30 + 0.34 * twig_index
                anchor = tuple(root[j] + (tip[j] - root[j]) * frac for j in range(3))
                twig_angle = angle + (1 if twig_index else -1) * (0.65 + 0.22 * rng.random())
                twig_len = length * (0.23 - 0.035 * twig_index)
                twig_tip = (anchor[0] + math.cos(twig_angle) * twig_len, anchor[1] + 0.12 * (1 - t), anchor[2] + math.sin(twig_angle) * twig_len)
                add_tapered_cylinder(mesh, anchor, twig_tip, 0.031, 0.008, 5, WOOD, phase=twig_angle)

            for sprig_index in range(sprigs_per_branch):
                frac = 0.12 + 0.81 * (sprig_index + 0.5) / sprigs_per_branch
                anchor = tuple(root[j] + (tip[j] - root[j]) * frac for j in range(3))
                local_angle = angle + (rng.random() - 0.5) * 0.34
                # Sprigs point along the branch with an alternating lift; this
                # fills the crown from above/below and avoids a flat card-like
                # ring when viewed down the branch axis.
                pitch = (rng.random() - 0.5) * (0.72 - 0.18 * t) + (0.12 if sprig_index % 3 == 0 else -0.03)
                horizontal = math.cos(pitch)
                sprig_axis = (math.cos(local_angle) * horizontal, math.sin(pitch), math.sin(local_angle) * horizontal)
                sprig_len = 0.34 + 0.22 * (1 - t) + rng.random() * 0.15
                sprig_radius = 0.095 + 0.055 * width
                needle_color = NEEDLE if (sprig_index + level) % 4 else NEEDLE_DARK
                add_sprig(mesh, anchor, sprig_axis, sprig_len, sprig_radius, needle_color, rng.random() * math.tau)

    # Top leader receives a compact crown rather than ending in a bare stick.
    top = trunk_points[-1]
    for i in range(6 if lod == 0 else 4):
        angle = math.tau * i / (6 if lod == 0 else 4) + 0.3
        root = (top[0], HEIGHT - 1.25, top[2])
        tip = (root[0] + math.cos(angle) * 0.85, HEIGHT - 0.55, root[2] + math.sin(angle) * 0.85)
        add_tapered_cylinder(mesh, root, tip, 0.045, 0.008, 5, WOOD, phase=angle)
        for j in range(4 if lod == 0 else 2):
            frac = (j + 0.5) / (4 if lod == 0 else 2)
            anchor = tuple(root[k] + (tip[k] - root[k]) * frac for k in range(3))
            add_sprig(mesh, anchor, (math.cos(angle), 0.15, math.sin(angle)), 0.36, 0.075, NEEDLE, j * 0.7)
    mesh.finish_normals()
    return mesh


def glb(mesh: Mesh, output: Path, lod: int):
    binary = bytearray()
    views, accessors = [], []

    def attr(payload, count, typ, minmax=None):
        offset = align4(len(binary)); binary.extend(b'\0' * (offset - len(binary))); binary.extend(payload)
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload), 'target': 34962})
        record = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': count, 'type': typ}
        if minmax: record['min'], record['max'] = minmax
        accessors.append(record); return len(accessors) - 1

    bounds = ([min(p[i] for p in mesh.positions) for i in range(3)], [max(p[i] for p in mesh.positions) for i in range(3)])
    pa = attr(b''.join(__import__('struct').pack('<3f', *p) for p in mesh.positions), len(mesh.positions), 'VEC3', bounds)
    na = attr(b''.join(__import__('struct').pack('<3f', *n) for n in mesh.normals), len(mesh.normals), 'VEC3')
    ca = attr(b''.join(__import__('struct').pack('<4f', *c) for c in mesh.colors), len(mesh.colors), 'VEC4')
    import struct
    component = 'I' if len(mesh.positions) >= 65536 else 'H'; component_type = 5125 if component == 'I' else 5123
    offset = align4(len(binary)); binary.extend(b'\0' * (offset - len(binary))); payload = struct.pack('<' + component * len(mesh.indices), *mesh.indices); binary.extend(payload)
    views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload), 'target': 34963}); accessors.append({'bufferView': len(views) - 1, 'componentType': component_type, 'count': len(mesh.indices), 'type': 'SCALAR'}); ii = len(accessors) - 1
    name = f'conifer_canonical_lod{lod}'
    doc = {'asset': {'version': '2.0', 'generator': 'build_conifer_canonical.py@1'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': name}], 'meshes': [{'name': name, 'primitives': [{'attributes': {'POSITION': pa, 'NORMAL': na, 'COLOR_0': ca}, 'indices': ii, 'material': 0}]}], 'materials': [{'name': 'conifer_role_albedo', 'doubleSided': True, 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.84}}], 'buffers': [{'byteLength': len(binary)}], 'bufferViews': views, 'accessors': accessors, 'extras': {'sourceAsset': 'polyhaven-fir-tree-01', 'sourceLicense': 'CC0-1.0', 'lod': lod, 'geometry': 'offline-volumetric-conifer-v1', 'roles': ['trunk', 'branches', 'foliage']}}
    js = json.dumps(doc, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4); bb = bytes(binary) + b'\0' * ((4 - len(binary) % 4) % 4)
    output.parent.mkdir(parents=True, exist_ok=True); output.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(bb)) + struct.pack('<II', len(js), 0x4e4f534a) + js + struct.pack('<II', len(bb), 0x004e4942) + bb)
    return {'vertices': len(mesh.positions), 'triangles': len(mesh.indices) // 3, 'bounds': bounds}


def atlas(mesh: Mesh, output: Path, size=512):
    columns, rows = 4, 2
    result = Image.new('RGBA', (columns * size, rows * size), (0, 0, 0, 0))
    for frame in range(8):
        angle = math.tau * frame / 8
        ca, sa = math.cos(angle), math.sin(angle)
        # Back-to-front painter sort is sufficient for the opaque low-poly
        # sprigs and gives a stable neutral albedo silhouette without a renderer.
        tris = []
        for ia, ib, ic, color in mesh.triangles:
            points = []
            depth = 0.0
            for index in (ia, ib, ic):
                x, y, z = mesh.positions[index]
                sx, sz = x * ca - z * sa, x * sa + z * ca
                points.append((sx, y)); depth += sz
            tris.append((depth / 3, points, color))
        tris.sort(key=lambda value: value[0])
        tile = Image.new('RGBA', (size, size), (0, 0, 0, 0)); draw = ImageDraw.Draw(tile, 'RGBA')
        # Keep the same 0.34/0.92 crop contract as Trees.js. Content intentionally
        # occupies the measured rectangle with a small transparent safety gutter.
        scale = size * 0.82 / WIDTH
        for _, points, color in tris:
            xy = [(int(size * 0.5 + x * scale), int(size * 0.96 - y * scale)) for x, y in points]
            rgba = tuple(max(0, min(255, int(c * 255))) for c in color[:3]) + (255,)
            draw.polygon(xy, fill=rgba)
        result.alpha_composite(tile, (frame % columns * size, (rows - 1 - frame // columns) * size))
    output.parent.mkdir(parents=True, exist_ok=True); result.save(output, optimize=True)
    output.with_suffix('.json').write_text(json.dumps({'schemaVersion': 2, 'source': 'fir_tree_01_lod0.glb', 'representation': 'lighting-neutral-srgb-albedo-alpha', 'runtimeLightingRequired': True, 'frames': 8, 'columns': 4, 'rows': 2, 'frameSize': size, 'gutterPixels': 8, 'azimuthConvention': 'frame i = i / frames * 2pi, camera clockwise around glTF +Y', 'bakeUpAxis': '+Y', 'boundsMin': [-(WIDTH / 2), 0, -(DEPTH / 2)], 'boundsMax': [WIDTH / 2, HEIGHT, DEPTH / 2]}, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output-dir', required=True); parser.add_argument('--atlas', required=True); parser.add_argument('--prefix', default='fir_tree_01'); args = parser.parse_args()
    root = Path(args.output_dir); stats = {}
    for lod in (0, 1):
        mesh = create_tree(lod); stats[lod] = glb(mesh, root / f'{args.prefix}_lod{lod}.glb', lod)
        if lod == 0: atlas(mesh, Path(args.atlas))
    print(json.dumps(stats, sort_keys=True))


if __name__ == '__main__': main()
