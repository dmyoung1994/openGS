#!/usr/bin/env python3
"""Build an isolated v8 candidate with alpha-footprint-trimmed local cards.

v8 keeps v7's deterministic 36x8 whorl/plane authority, but replaces each
full-tile tapered quad with a conservative low-vertex polygon around the
alpha-tested macro footprint. This removes transparent rectangle rasterization
without introducing a texture, pass, or runtime dependency.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


HEIGHT = 18.895
ALPHA_CUTOFF = 16
SOURCE_HASH = '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709'
HULL_EPSILON = 0.11
HULL_GUARD_PIXELS = 4.0
HULLS = {}
CARD_AREA = {'baseline': 0.0, 'trimmed': 0.0, 'cards': 0}


def load_v7():
    path = Path(__file__).with_name('build_conifer_v7.py')
    spec = importlib.util.spec_from_file_location('conifer_v7_builder_v8', path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def alpha_hulls(atlas_image, tile_size=256):
    """Return guarded, <=6 vertex polygons enclosing each tile's alpha hull."""
    alpha = np.asarray(atlas_image.convert('RGBA'))[..., 3]
    result = {0: ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))}
    for tile in range(1, 16):
        tx, ty = tile % 4, tile // 4
        tile_alpha = (alpha[ty * tile_size:(ty + 1) * tile_size,
                            tx * tile_size:(tx + 1) * tile_size] >= ALPHA_CUTOFF).astype(np.uint8)
        contours, _ = cv2.findContours(tile_alpha, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            result[tile] = result[0]
            continue
        points = np.vstack(contours)
        hull = cv2.convexHull(points)
        # The guard expands the simplified support polygon so anti-aliased
        # alpha edge pixels are not clipped by polygon reduction.
        polygon = cv2.approxPolyDP(hull, HULL_EPSILON * tile_size, True)[:, 0, :].astype(np.float64)
        centre = polygon.mean(axis=0)
        polygon = centre + (polygon - centre) * (1.0 + HULL_GUARD_PIXELS / (tile_size * 0.5))
        polygon[:, 0] = np.clip(polygon[:, 0] / tile_size, 0.0, 1.0)
        polygon[:, 1] = np.clip(polygon[:, 1] / tile_size, 0.0, 1.0)
        if len(polygon) < 3:
            result[tile] = result[0]
        else:
            result[tile] = tuple((float(x), float(y)) for x, y in polygon)
    return result


def polygon_area(points):
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1]
                   - points[i][1] * points[(i + 1) % len(points)][0]
                   for i in range(len(points))) * 0.5)


def trimmed_card(mesh, v3, centre, axis, length, width, tile, roll=0.0):
    """Emit a tapered local polygon mapped to the source alpha hull."""
    axis, u, v = v3.basis(axis)
    side = v3.norm(tuple(u[k] * v3.math.cos(roll) + v[k] * v3.math.sin(roll) for k in range(3)))
    hull = list(HULLS.get(tile, HULLS[0]))
    # v3 Mesh's image/UV convention has v increasing from the card origin to
    # its tip. Match the old quad's positive signed local area for normals.
    local = [((px - 0.5) * (1.0 - 0.74 * py), py - 0.5) for px, py in hull]
    if sum(local[i][0] * local[(i + 1) % len(local)][1]
           - local[i][1] * local[(i + 1) % len(local)][0]
           for i in range(len(local))) < 0:
        hull.reverse()
        local = [((px - 0.5) * (1.0 - 0.74 * py), py - 0.5) for px, py in hull]
    points = [tuple(centre[k] + axis[k] * py * length + side[k] * px * width
                    for k in range(3)) for px, py in local]
    tile_uv = v3.tile_uv(tile)
    uv = [tuple(tile_uv[0][k] + (tile_uv[2][k] - tile_uv[0][k]) * hull[i][k]
                for k in range(2)) for i in range(len(hull))]
    first = mesh.v(points[0], uv[0])
    for index in range(1, len(points) - 1):
        b = mesh.v(points[index], uv[index])
        c = mesh.v(points[index + 1], uv[index + 1])
        mesh.i.extend((first, b, c))
        mesh.tris.append((first, b, c))
        mesh.tri_material.extend((1,))
    trimmed = polygon_area(local) * length * width
    CARD_AREA['baseline'] += length * width * 0.63
    CARD_AREA['trimmed'] += trimmed
    CARD_AREA['cards'] += 1


def patch_glb(path, lod, atlas_sha, coverage, metrics, baseline_metrics, area):
    raw = path.read_bytes()
    json_length = int.from_bytes(raw[12:16], 'little')
    document = json.loads(raw[20:20 + json_length])
    document['asset']['generator'] = 'build_conifer_v8@1-alpha-footprint-hulls'
    document['nodes'][0]['name'] = f'conifer_v8_lod{lod}'
    document['meshes'][0]['name'] = f'conifer_v8_lod{lod}'
    document['materials'][0]['name'] = 'conifer_v8_macro_alpha_atlas'
    primitive = document['meshes'][0]['primitives'][0]
    index_count = document['accessors'][primitive['indices']]['count']
    position = document['accessors'][primitive['attributes']['POSITION']]
    retained = {}
    for angle in ('0', '45', '90', '135'):
        retained[angle] = [metrics[angle][1]['pixels'] / max(baseline_metrics[angle][1]['pixels'], 1),
                           metrics[angle][0]['pixels'] / max(baseline_metrics[angle][0]['pixels'], 1)]
    document['extras'] = {
        'candidateOnly': True,
        'sourceAsset': 'conifer_v7_exact_whorl_plane_authority',
        'sourceHash': SOURCE_HASH,
        'geometry': 'real-trunk-primary-branches-alpha-footprint-hulls-v8',
        'lod': lod,
        'selection': 'same v7 36 crown layers/8 branches/three local planes per cluster',
        'vertices': index_count,
        'triangles': index_count // 3,
        'boundsMin': position.get('min'),
        'boundsMax': position.get('max'),
        'atlasSha256': atlas_sha,
        'macroAtlasCoverageAt16': coverage,
        'alphaHull': {'epsilon': HULL_EPSILON, 'guardPixels': HULL_GUARD_PIXELS, 'maxVertices': 6},
        'cardArea': area,
        'silhouetteMetrics': metrics,
        'baselineV7Metrics': baseline_metrics,
        'retainedVsV7': retained,
        'bakeLighting': 'neutral source RGB/alpha only; no sun/AO/emission',
    }
    js = json.dumps(document, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    binary_offset = 20 + json_length + 8
    binary = raw[binary_offset:]
    total = 12 + 8 + len(js) + 8 + len(binary)
    path.write_bytes(b'glTF' + (2).to_bytes(4, 'little') + total.to_bytes(4, 'little')
                     + len(js).to_bytes(4, 'little') + (0x4E4F534A).to_bytes(4, 'little') + js
                     + len(binary).to_bytes(4, 'little') + (0x004E4942).to_bytes(4, 'little') + binary)
    return document['extras']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    v7 = load_v7()
    v6 = v7.load_v6()
    v3 = v6.load_v3()
    source_dir, output_dir = Path(args.source_dir), Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = output_dir / 'conifer_v8_macro_atlas.png'
    atlas_image, coverage = v6.macro_atlas(source_dir, atlas_path)
    atlas_sha = hashlib.sha256(atlas_path.read_bytes()).hexdigest()
    global HULLS, CARD_AREA
    HULLS = alpha_hulls(atlas_image)
    baseline_meshes = {}
    with tempfile.TemporaryDirectory(prefix='conifer-v8-baseline-') as tmp:
        for lod in (0, 1):
            baseline_meshes[lod] = v7.build_mesh(v3, v6, lod, atlas_image,
                                                  Path(tmp) / f'v7_lod{lod}.glb')
        baseline_metrics = v7.silhouette_metrics([baseline_meshes[0], baseline_meshes[1]], atlas_image)
    v6.card = trimmed_card
    CARD_AREA = {'baseline': 0.0, 'trimmed': 0.0, 'cards': 0}
    meshes, reports = {}, []
    for lod in (0, 1):
        path = output_dir / f'conifer_v8_lod{lod}.glb'
        meshes[lod] = v7.build_mesh(v3, v6, lod, atlas_image, path)
    metrics = v7.silhouette_metrics([meshes[0], meshes[1]], atlas_image)
    area = {**CARD_AREA, 'reduction': 1.0 - CARD_AREA['trimmed'] / max(CARD_AREA['baseline'], 1e-9)}
    for lod in (0, 1):
        reports.append(patch_glb(output_dir / f'conifer_v8_lod{lod}.glb', lod, atlas_sha,
                                 coverage, metrics, baseline_metrics, area))
    impostor_path = output_dir / 'conifer_v8_impostor.png'
    v3.impostor(meshes[0], impostor_path, atlas_image, size=512)
    alpha = np.asarray(Image.open(impostor_path).convert('RGBA').getchannel('A'))
    impostor = {
        'schemaVersion': 1, 'candidateOnly': True, 'sourceAsset': 'conifer_v8_lod0',
        'sourceHash': SOURCE_HASH, 'representation': 'lighting-neutral-srgb-albedo-alpha',
        'runtimeLightingRequired': True, 'frames': 8, 'columns': 4, 'rows': 2,
        'frameSize': 512, 'bakeMethod': 'neutral alpha-footprint-hull rasterizer; no sun/AO/emission',
        'sha256': hashlib.sha256(impostor_path.read_bytes()).hexdigest(),
        'alpha': {'width': int(alpha.shape[1]), 'height': int(alpha.shape[0]),
                  'coverageAt16': float((alpha >= ALPHA_CUTOFF).mean()), 'alphaMax': int(alpha.max())},
    }
    (output_dir / 'conifer_v8_impostor.json').write_text(json.dumps(impostor, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'reports': reports, 'atlasSha256': atlas_sha, 'cardArea': area,
                      'impostor': impostor}, sort_keys=True))


if __name__ == '__main__':
    main()
