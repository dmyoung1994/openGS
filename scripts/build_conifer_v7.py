#!/usr/bin/env python3
"""Build isolated, view-stable volumetric local-cluster conifer v7."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image


HEIGHT = 18.895
SEED = 0xC04F4E
SOURCE_HASH = '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709'
ALPHA_CUTOFF = 16


def load_v6():
    path = Path(__file__).with_name('build_conifer_v6.py')
    spec = importlib.util.spec_from_file_location('conifer_v6_builder_v7', path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def build_mesh(v3, v6, lod, atlas_image, output, seed=SEED):
    rng = random.Random(seed)
    mesh = v3.Mesh()
    bark = v3.tile_uv(0)
    steps, levels, branches = 26, 36, 8
    centres = []
    trunk_top = HEIGHT - 0.82
    for index in range(steps + 1):
        t = index / steps
        centres.append((0.12 * v3.math.sin(t * 2.2), trunk_top * t,
                        0.10 * v3.math.sin(t * 1.6 + 0.4)))
    trunk_sides = 6 if lod == 0 else 5
    for index in range(steps):
        v3.cylinder(mesh, centres[index], centres[index + 1],
                    0.42 * (1 - index / steps) ** 0.7 + 0.032,
                    0.42 * (1 - (index + 1) / steps) ** 0.7 + 0.032,
                    trunk_sides, bark)

    # Every real primary branch gets three local planes distributed around its
    # own axis. LOD0/LOD1 consume exactly the same random sequence and centers;
    # only structural cylinder sides differ, so handoff masks stay registered.
    for level in range(levels):
        t = (level + 0.35) / levels
        y = 1.02 + (HEIGHT - 1.56) * t + (rng.random() - 0.5) * 0.52
        radius = (v3.math.sin(v3.math.pi * (0.075 + 0.90 * t)) ** 0.48) * (3.72 + 0.60 * rng.random())
        phase = rng.random() * v3.math.tau
        for branch_index in range(branches):
            angle = phase + v3.math.tau * branch_index / branches + (rng.random() - 0.5) * 0.78
            root = (0.12 * v3.math.sin(y * 0.12), y,
                    0.10 * v3.math.sin(y * 0.08 + 0.4))
            droop = 0.32 + 0.72 * (1 - t) + rng.random() * 0.28
            tip = (root[0] + v3.math.cos(angle) * radius, root[1] - droop,
                   root[2] + v3.math.sin(angle) * radius)
            v3.cylinder(mesh, root, tip, 0.045 * (1 - 0.35 * t), 0.006,
                        4 if lod == 0 else 2, bark)
            f = 0.55 + (rng.random() - 0.5) * 0.14
            centre = tuple(root[k] + (tip[k] - root[k]) * f for k in range(3))
            centre = (centre[0], centre[1] + (rng.random() - 0.5) * 0.26, centre[2])
            axis = (v3.math.cos(angle), -0.16 - 0.25 * (1 - t), v3.math.sin(angle))
            length = 1.65 + 1.20 * (1 - t) + rng.random() * 0.35
            width = 1.20 + 0.85 * (1 - t) + rng.random() * 0.24
            cluster_roll = rng.random() * v3.math.tau
            for plane in range(3):
                tile = 1 + rng.randrange(15)
                roll = cluster_roll + v3.math.tau * plane / 3 + (rng.random() - 0.5) * 0.34
                v6.card(mesh, v3, centre, axis, length * (1 - plane * 0.045),
                        width * (1 - plane * 0.06), tile, roll)

    # Low/interior clusters are also volumetric and common to both tiers. Their
    # modest count adds mass behind the whorl planes without a tree-sized card.
    for _ in range(24):
        t = 0.08 + rng.random() * 0.86
        crown = v3.math.sin(v3.math.pi * (0.04 + 0.92 * t)) ** 0.44
        radius = (rng.random() ** 0.82) * (3.35 * crown + 0.15)
        azimuth = rng.random() * v3.math.tau
        centre = (v3.math.cos(azimuth) * radius,
                  0.82 + (HEIGHT - 1.22) * t + (rng.random() - 0.5) * 0.45,
                  v3.math.sin(azimuth) * radius)
        axis = (v3.math.cos(azimuth), (rng.random() - 0.5) * 0.8,
                v3.math.sin(azimuth))
        cluster_roll = rng.random() * v3.math.tau
        for plane in range(3):
            tile = 1 + rng.randrange(15)
            roll = cluster_roll + v3.math.tau * plane / 3 + (rng.random() - 0.5) * 0.34
            v6.card(mesh, v3, centre, axis, 1.18 * (1 - plane * 0.06),
                    0.98 * (1 - plane * 0.05), tile, roll)

    min_y = min(point[1] for point in mesh.p)
    max_y = max(point[1] for point in mesh.p)
    y_span = max(max_y - min_y, 1e-6)
    mesh.p = [(point[0], (point[1] - min_y) * HEIGHT / y_span, point[2]) for point in mesh.p]
    mesh.normals()
    v3.write_glb(mesh, output, atlas_image, lod)
    return mesh


def projected_mask(mesh, atlas_image, angle, size, scale, centre_x):
    tex = np.asarray(atlas_image.convert('RGBA'), dtype=np.uint8)
    tw, th = tex.shape[1], tex.shape[0]
    pos = np.asarray(mesh.p, dtype=np.float32)
    uv = np.asarray(mesh.uv, dtype=np.float32)
    idx = np.asarray(mesh.i, dtype=np.int32).reshape(-1, 3)
    ca, sa = math.cos(angle), math.sin(angle)
    projected_x = pos[:, 0] * ca - pos[:, 2] * sa
    projected_depth = pos[:, 0] * sa + pos[:, 2] * ca
    sx = size * 0.5 + (projected_x - centre_x) * scale
    sy = size * 0.90 - pos[:, 1] * scale
    mask = np.zeros((size, size), dtype=np.uint8)
    zbuf = np.full((size, size), -np.inf, dtype=np.float32)
    for ia, ib, ic in idx:
        x0, y0 = float(sx[ia]), float(sy[ia])
        x1, y1 = float(sx[ib]), float(sy[ib])
        x2, y2 = float(sx[ic]), float(sy[ic])
        minx, maxx = max(0, int(math.floor(min(x0, x1, x2)))), min(size - 1, int(math.ceil(max(x0, x1, x2))))
        miny, maxy = max(0, int(math.floor(min(y0, y1, y2)))), min(size - 1, int(math.ceil(max(y0, y1, y2))))
        if minx > maxx or miny > maxy:
            continue
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-6:
            continue
        xx, yy = np.meshgrid(np.arange(minx, maxx + 1, dtype=np.float32) + 0.5,
                             np.arange(miny, maxy + 1, dtype=np.float32) + 0.5)
        w0 = ((y1 - y2) * (xx - x2) + (x2 - x1) * (yy - y2)) / den
        w1 = ((y2 - y0) * (xx - x2) + (x0 - x2) * (yy - y2)) / den
        inside = (w0 >= 0) & (w1 >= 0) & ((1 - w0 - w1) >= 0)
        if not inside.any():
            continue
        zz = w0 * projected_depth[ia] + w1 * projected_depth[ib] + (1 - w0 - w1) * projected_depth[ic]
        sub_z = zbuf[miny:maxy + 1, minx:maxx + 1]
        better = inside & (zz >= sub_z)
        uu = np.clip((w0 * uv[ia, 0] + w1 * uv[ib, 0] + (1 - w0 - w1) * uv[ic, 0]) * tw, 0, tw - 1.001)
        vv = np.clip((w0 * uv[ia, 1] + w1 * uv[ib, 1] + (1 - w0 - w1) * uv[ic, 1]) * th, 0, th - 1.001)
        sample = tex[np.asarray(vv, dtype=np.int32), np.asarray(uu, dtype=np.int32), 3]
        better &= sample >= ALPHA_CUTOFF
        sub_z[better] = zz[better]
        mask[miny:maxy + 1, minx:maxx + 1][better] = 255
    return mask


def silhouette_metrics(meshes, atlas_image, angles=(0, math.pi / 4, math.pi / 2, 3 * math.pi / 4), size=256):
    projected_spans = []
    for angle in angles:
        ca, sa = math.cos(angle), math.sin(angle)
        projected_spans.append(max(float(np.ptp(np.asarray(mesh.p)[:, 0] * ca - np.asarray(mesh.p)[:, 2] * sa)) for mesh in meshes))
    scale = size * 0.84 / max(max(projected_spans), HEIGHT)
    metrics = {}
    for angle in angles:
        ca, sa = math.cos(angle), math.sin(angle)
        mins = [float(np.min(np.asarray(mesh.p)[:, 0] * ca - np.asarray(mesh.p)[:, 2] * sa)) for mesh in meshes]
        maxs = [float(np.max(np.asarray(mesh.p)[:, 0] * ca - np.asarray(mesh.p)[:, 2] * sa)) for mesh in meshes]
        centre_x = (min(mins) + max(maxs)) * 0.5
        masks = [projected_mask(mesh, atlas_image, angle, size, scale, centre_x) for mesh in meshes]
        item = []
        for mask in masks:
            covered = mask > 0
            left, right = covered[:, :size // 2].sum(), covered[:, size // 2:].sum()
            item.append({'pixels': int(covered.sum()), 'occupancy': float(covered.mean()),
                         'leftRightBalance': float(min(left, right) / max(left, right, 1))})
        item[1]['lodRatio'] = item[1]['pixels'] / max(item[0]['pixels'], 1)
        metrics[str(round(math.degrees(angle)))] = item
    return metrics


def patch_glb(path, lod, atlas_sha, macro_coverage, metrics):
    raw = path.read_bytes()
    json_length = int.from_bytes(raw[12:16], 'little')
    document = json.loads(raw[20:20 + json_length])
    document['asset']['generator'] = 'build_conifer_v7@1-volumetric-macro-clusters'
    document['nodes'][0]['name'] = f'conifer_v7_lod{lod}'
    document['meshes'][0]['name'] = f'conifer_v7_lod{lod}'
    document['materials'][0]['name'] = 'conifer_v7_macro_alpha_atlas'
    primitive = document['meshes'][0]['primitives'][0]
    index_count = document['accessors'][primitive['indices']]['count']
    position = document['accessors'][primitive['attributes']['POSITION']]
    document['extras'] = {
        'candidateOnly': True, 'sourceAsset': 'conifer_v6_real_trunk_and_macro_atlas',
        'sourceHash': SOURCE_HASH, 'geometry': 'volumetric-three-plane-local-clusters-v7',
        'lod': lod, 'selection': 'same 36 crown layers/8 branches, three local planes per cluster',
        'vertices': index_count, 'triangles': index_count // 3,
        'boundsMin': position.get('min'), 'boundsMax': position.get('max'),
        'atlasSha256': atlas_sha, 'macroAtlasCoverageAt16': macro_coverage,
        'silhouetteMetrics': metrics,
        'bakeLighting': 'neutral source RGB/alpha only; no sun/AO/emission',
    }
    js = json.dumps(document, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    binary_offset = 20 + json_length + 8
    binary = raw[binary_offset:]
    total = 12 + 8 + len(js) + 8 + len(binary)
    path.write_bytes(b'glTF' + (2).to_bytes(4, 'little') + total.to_bytes(4, 'little')
                     + len(js).to_bytes(4, 'little') + (0x4E4F534A).to_bytes(4, 'little') + js
                     + len(binary).to_bytes(4, 'little') + (0x004E4942).to_bytes(4, 'little') + binary)
    return document['extras']


def alpha_stats(path):
    alpha = np.asarray(Image.open(path).convert('RGBA').getchannel('A'))
    return {'width': int(alpha.shape[1]), 'height': int(alpha.shape[0]),
            'coverageAt16': float((alpha >= ALPHA_CUTOFF).mean()), 'alphaMax': int(alpha.max())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    v6 = load_v6(); v3 = v6.load_v3()
    source_dir, output_dir = Path(args.source_dir), Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = output_dir / 'conifer_v7_macro_atlas.png'
    atlas_image, coverage = v6.macro_atlas(source_dir, atlas_path)
    atlas_sha = hashlib.sha256(atlas_path.read_bytes()).hexdigest()
    meshes, reports = {}, []
    for lod in (0, 1):
        path = output_dir / f'conifer_v7_lod{lod}.glb'
        meshes[lod] = build_mesh(v3, v6, lod, atlas_image, path)
    metrics = silhouette_metrics([meshes[0], meshes[1]], atlas_image)
    for lod in (0, 1):
        reports.append(patch_glb(output_dir / f'conifer_v7_lod{lod}.glb', lod, atlas_sha, coverage, metrics))
    impostor_path = output_dir / 'conifer_v7_impostor.png'
    v3.impostor(meshes[0], impostor_path, atlas_image, size=512)
    impostor = {'schemaVersion': 1, 'candidateOnly': True, 'sourceAsset': 'conifer_v7_lod0',
                'sourceHash': SOURCE_HASH, 'representation': 'lighting-neutral-srgb-albedo-alpha',
                'runtimeLightingRequired': True, 'frames': 8, 'columns': 4, 'rows': 2,
                'frameSize': 512, 'bakeMethod': 'existing neutral macro-atlas rasterizer; no sun/AO/emission',
                'sha256': hashlib.sha256(impostor_path.read_bytes()).hexdigest(), 'alpha': alpha_stats(impostor_path)}
    (output_dir / 'conifer_v7_impostor.json').write_text(json.dumps(impostor, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'reports': reports, 'atlasSha256': atlas_sha, 'macroCoverage': coverage,
                      'impostor': impostor}, sort_keys=True))


if __name__ == '__main__':
    main()
