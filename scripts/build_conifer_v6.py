#!/usr/bin/env python3
"""Build an isolated macro-cluster-card conifer candidate.

Unlike the v3-v5 local twig populations, v6 places one or two broad, tightly
fitted local branch/whorl sprites around real primary branches. The sprites are
offline composites of source-authored twig RGB/alpha, never whole-tree cards or
painted lighting. Geometry remains the authority for trunk, branches, grounding,
silhouette bounds, and runtime normals.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops


HEIGHT = 18.895
SEED = 0xC04F4E
SOURCE_HASH = '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709'
ALPHA_CUTOFF = 16


def load_v3():
    path = Path(__file__).with_name('build_conifer_v3.py')
    spec = importlib.util.spec_from_file_location('conifer_v3_builder_v6', path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def macro_atlas(source_dir: Path, output: Path, size=256):
    """Composite source twig islands into 15 local-cluster sprites plus bark."""
    texture_dir = source_dir / 'textures'
    twig = Image.open(texture_dir / 'fir_tree_01_twig_diff_1k.jpg').convert('RGB')
    alpha = Image.open(texture_dir / 'fir_tree_01_twig_alpha_1k.png').convert('L')
    bark = Image.open(texture_dir / 'fir_tree_01_bark_diff_1k.jpg').convert('RGB')
    boxes = [
        (185, 30, 440, 335), (495, 80, 725, 440), (650, 30, 1015, 420),
        (395, 275, 510, 430), (500, 250, 680, 450), (300, 390, 680, 800),
        (640, 440, 1015, 900), (205, 790, 335, 1024), (315, 775, 640, 1024),
        (630, 775, 1024, 1024), (245, 45, 430, 330), (680, 45, 965, 390),
        (365, 420, 610, 760), (690, 480, 980, 850), (425, 285, 590, 500),
    ]
    atlas = Image.new('RGBA', (size * 4, size * 4), (0, 0, 0, 0))
    bark_tile = bark.crop((0, 0, bark.width, min(bark.height, 512))).resize((size, size), Image.Resampling.LANCZOS)
    bark_tile.putalpha(255)
    atlas.paste(bark_tile, (0, 0))
    rng = random.Random(SEED ^ 0xA71A5)
    coverages = []
    for tile in range(1, 16):
        sprite = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        # Each tile is a local branch/whorl cluster: five to eight source twig
        # islands, overlapping around a broad center while retaining openings.
        count = 7 + (tile * 3) % 5
        for item in range(count):
            box = boxes[(tile * 5 + item * 3) % len(boxes)]
            crop = twig.crop(box).resize((size, size), Image.Resampling.LANCZOS)
            mask = alpha.crop(box).resize((size, size), Image.Resampling.LANCZOS)
            crop.putalpha(mask)
            scale = 0.42 + rng.random() * 0.42
            crop = crop.resize((max(1, int(size * scale)), max(1, int(size * scale))), Image.Resampling.LANCZOS)
            angle = (rng.random() - 0.5) * 42
            crop = crop.rotate(angle, Image.Resampling.BICUBIC, expand=True)
            x = int(size * (0.50 + (rng.random() - 0.5) * 0.45) - crop.width * 0.5)
            y = int(size * (0.52 + (rng.random() - 0.5) * 0.40) - crop.height * 0.5)
            sprite.alpha_composite(crop, (x, y))
        # Clear a one-pixel tile gutter so atlas filtering cannot leak alpha.
        pixels = np.asarray(sprite).copy()
        pixels[:1, :, 3] = pixels[-1:, :, 3] = 0
        pixels[:, :1, 3] = pixels[:, -1:, 3] = 0
        sprite = Image.fromarray(pixels, 'RGBA')
        coverage = float((np.asarray(sprite.getchannel('A')) >= ALPHA_CUTOFF).mean())
        coverages.append(coverage)
        atlas.paste(sprite, ((tile % 4) * size, (tile // 4) * size), sprite)
    output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output, optimize=True)
    return atlas, {'min': min(coverages), 'max': max(coverages), 'mean': sum(coverages) / len(coverages)}


def card(mesh, v3, centre, axis, length, width, tile, roll=0.0):
    axis, u, v = v3.basis(axis)
    side = v3.norm(tuple(u[k] * v3.math.cos(roll) + v[k] * v3.math.sin(roll) for k in range(3)))
    half_l = length * 0.5
    half_w = width * 0.5
    origin = tuple(centre[k] - axis[k] * half_l for k in range(3))
    tip = tuple(centre[k] + axis[k] * half_l for k in range(3))
    a = tuple(origin[k] - side[k] * half_w for k in range(3))
    b = tuple(origin[k] + side[k] * half_w for k in range(3))
    c = tuple(tip[k] + side[k] * half_w * 0.26 for k in range(3))
    d = tuple(tip[k] - side[k] * half_w * 0.26 for k in range(3))
    mesh.quad(a, b, c, d, v3.tile_uv(tile))


def build_mesh(v3, lod, atlas_image, output, seed=SEED):
    rng = random.Random(seed)
    mesh = v3.Mesh()
    bark = v3.tile_uv(0)
    steps = 26
    trunk_top = HEIGHT - 0.82
    centres = []
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

    levels, branches = 36, 8
    # LOD0: two angled cards per real primary branch. LOD1: one card but the
    # same layers/branches, preserving the whorl rhythm without a pole.
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
            # LOD1 keeps the full eight-branch primary scaffold but uses a
            # deliberately small two-sided structural section and six card
            # consumers per whorl, keeping the candidate under 2.5k tris.
            branch_sides = 4 if lod == 0 else 2
            v3.cylinder(mesh, root, tip, 0.045 * (1 - 0.35 * t), 0.006, branch_sides, bark)
            f = 0.55 + (rng.random() - 0.5) * 0.14
            centre = tuple(root[k] + (tip[k] - root[k]) * f for k in range(3))
            centre = (centre[0], centre[1] + (rng.random() - 0.5) * 0.26, centre[2])
            axis = (v3.math.cos(angle), -0.16 - 0.25 * (1 - t), v3.math.sin(angle))
            length = 1.65 + 1.20 * (1 - t) + rng.random() * 0.35
            width = 1.20 + 0.85 * (1 - t) + rng.random() * 0.24
            tile = 1 + rng.randrange(15)
            if lod == 0 or branch_index < 6:
                card(mesh, v3, centre, axis, length, width, tile, rng.random() * 0.42)
            if lod == 0:
                card(mesh, v3, centre, axis, length * 0.92, width * 0.94,
                     1 + rng.randrange(15), v3.math.pi * 0.5 + rng.random() * 0.42)

    # A few deterministic crown-volume cards fill interior negative space while
    # remaining local and sparse. LOD1 prunes these entirely; whorl layers stay.
    if lod == 0:
        for _ in range(32):
            t = 0.10 + rng.random() * 0.82
            crown = v3.math.sin(v3.math.pi * (0.04 + 0.92 * t)) ** 0.44
            radius = (rng.random() ** 0.82) * (3.35 * crown + 0.15)
            azimuth = rng.random() * v3.math.tau
            centre = (v3.math.cos(azimuth) * radius,
                      0.82 + (HEIGHT - 1.22) * t + (rng.random() - 0.5) * 0.45,
                      v3.math.sin(azimuth) * radius)
            axis = (v3.math.cos(azimuth), (rng.random() - 0.5) * 0.8,
                    v3.math.sin(azimuth))
            card(mesh, v3, centre, axis, 1.20 + rng.random() * 0.55,
                 1.00 + rng.random() * 0.32, 1 + rng.randrange(15), rng.random() * math.tau)

    min_y = min(point[1] for point in mesh.p)
    max_y = max(point[1] for point in mesh.p)
    y_span = max(max_y - min_y, 1e-6)
    mesh.p = [(point[0], (point[1] - min_y) * HEIGHT / y_span, point[2]) for point in mesh.p]
    mesh.normals()
    v3.write_glb(mesh, output, atlas_image, lod)
    return mesh


def alpha_stats(path):
    alpha = Image.open(path).convert('RGBA').getchannel('A')
    values = np.asarray(alpha)
    return {'width': alpha.width, 'height': alpha.height,
            'coverageAt16': float((values >= ALPHA_CUTOFF).mean()),
            'alphaMax': int(values.max())}


def patch_glb(path, lod, atlas_sha, macro_coverage):
    raw = path.read_bytes()
    json_length = int.from_bytes(raw[12:16], 'little')
    document = json.loads(raw[20:20 + json_length])
    document['asset']['generator'] = 'build_conifer_v6@1-macro-cluster-cards'
    document['nodes'][0]['name'] = f'conifer_v6_lod{lod}'
    document['meshes'][0]['name'] = f'conifer_v6_lod{lod}'
    document['materials'][0]['name'] = 'conifer_v6_macro_alpha_atlas'
    primitive = document['meshes'][0]['primitives'][0]
    index_count = document['accessors'][primitive['indices']]['count']
    position = document['accessors'][primitive['attributes']['POSITION']]
    document['extras'] = {
        'candidateOnly': True,
        'sourceAsset': 'conifer_v4_exact_hierarchy_and_atlas',
        'sourceHash': SOURCE_HASH,
        'geometry': 'real-trunk-primary-branches-plus-local-macro-cluster-cards-v6',
        'lod': lod,
        'selection': '36 crown layers and 8 branches; one local macro sprite per primary branch',
        'vertices': index_count,
        'triangles': index_count // 3,
        'boundsMin': position.get('min'),
        'boundsMax': position.get('max'),
        'atlasSha256': atlas_sha,
        'macroAtlasCoverageAt16': macro_coverage,
        'bakeLighting': 'neutral source RGB/alpha only; no sun/AO/emission',
    }
    json_blob = json.dumps(document, separators=(',', ':')).encode()
    json_blob += b' ' * ((4 - len(json_blob) % 4) % 4)
    binary_offset = 20 + json_length + 8
    binary = raw[binary_offset:]
    total_length = 12 + 8 + len(json_blob) + 8 + len(binary)
    path.write_bytes(
        b'glTF' + (2).to_bytes(4, 'little') + total_length.to_bytes(4, 'little')
        + len(json_blob).to_bytes(4, 'little') + (0x4E4F534A).to_bytes(4, 'little') + json_blob
        + len(binary).to_bytes(4, 'little') + (0x004E4942).to_bytes(4, 'little') + binary,
    )
    return document['extras']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    v3 = load_v3()
    source_dir = Path(args.source_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = output_dir / 'conifer_v6_macro_atlas.png'
    atlas_image, coverage = macro_atlas(source_dir, atlas_path)
    atlas_sha = hashlib.sha256(atlas_path.read_bytes()).hexdigest()
    reports = []
    meshes = {}
    for lod in (0, 1):
        path = output_dir / f'conifer_v6_lod{lod}.glb'
        meshes[lod] = build_mesh(v3, lod, atlas_image, path)
        reports.append(patch_glb(path, lod, atlas_sha, coverage))

    impostor_path = output_dir / 'conifer_v6_impostor.png'
    v3.impostor(meshes[0], impostor_path, atlas_image, size=512)
    impostor = {
        'schemaVersion': 1, 'candidateOnly': True, 'sourceAsset': 'conifer_v6_lod0',
        'sourceHash': SOURCE_HASH, 'representation': 'lighting-neutral-srgb-albedo-alpha',
        'runtimeLightingRequired': True, 'frames': 8, 'columns': 4, 'rows': 2,
        'frameSize': 512, 'bakeMethod': 'existing offline macro-atlas rasterizer; no sun/AO/emission',
        'sha256': hashlib.sha256(impostor_path.read_bytes()).hexdigest(),
        'alpha': alpha_stats(impostor_path),
    }
    (output_dir / 'conifer_v6_impostor.json').write_text(json.dumps(impostor, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'reports': reports, 'atlasSha256': atlas_sha,
                      'macroCoverage': coverage, 'impostor': impostor}, sort_keys=True))


if __name__ == '__main__':
    main()
