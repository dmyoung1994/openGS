#!/usr/bin/env python3
"""Build the isolated, source-registered conifer v5 candidate.

v5 uses the accepted v4 crossed-pair population as its hero tier and keeps the
same 36-layer/8-branch hierarchy in its reduced LOD1.  The normal response that
v4 computed at runtime for local branchlet sprays is baked here into the GLB
NORMAL attribute (bark tile 0 remains geometric/source-normal), so a future
viewer can use the shared source-normal path without a v4-only normal graph.

The eight-view impostor is produced by the existing neutral offline rasterizer:
it samples the source atlas RGB/alpha only and never bakes sun, sky, AO, or
emission.  All outputs are candidate-only and never overwrite v4/production.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import random
from pathlib import Path


HEIGHT = 18.895
SEED = 0xC04F4E
SOURCE_HASH = '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709'
ALPHA_CUTOFF = 16


def load_v3():
    path = Path(__file__).with_name('build_conifer_v3.py')
    spec = importlib.util.spec_from_file_location('conifer_v3_builder_v5', path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def bake_parent_normals(v3, mesh):
    """Blend v4's bounded parent-puffiness into branchlet vertices only."""
    for index, point in enumerate(mesh.p):
        u, v = mesh.uv[index]
        bark = u < 0.25 and v < 0.25
        if bark:
            continue
        outward = v3.norm((point[0], point[1] * 0.12, point[2]))
        source = mesh.n[index]
        mesh.n[index] = v3.norm(tuple(source[k] * 0.64 + outward[k] * 0.36 for k in range(3)))


def build_mesh(v3, lod, atlas_image, tile_bounds, output, seed=SEED):
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
    for index in range(steps):
        v3.cylinder(mesh, centres[index], centres[index + 1],
                    0.42 * (1 - index / steps) ** 0.7 + 0.032,
                    0.42 * (1 - (index + 1) / steps) ** 0.7 + 0.032,
                    6, bark)

    levels, branches, hierarchy_clusters, volume_hierarchy = 36, 8, 12, 620
    retained_clusters = hierarchy_clusters if lod == 0 else 6
    # Keep the reduced tier at exactly 12k tris while preserving every whorl
    # and outer branch spray; only interior volume density is pruned.
    retained_volumes = volume_hierarchy if lod == 0 else 167

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
            v3.cylinder(mesh, root, tip, 0.045 * (1 - 0.35 * t), 0.006, 4, bark)
            for cluster_index in range(hierarchy_clusters):
                f = (cluster_index + 0.35 + rng.random() * 0.25) / hierarchy_clusters
                centre = tuple(root[k] + (tip[k] - root[k]) * f for k in range(3))
                centre = (centre[0], centre[1] + (rng.random() - 0.5) * 0.26, centre[2])
                azimuth = angle + (rng.random() - 0.5) * 0.8
                pitch = (rng.random() - 0.5) * 1.0 - 0.12 * (1 - t)
                axis = (v3.math.cos(azimuth) * v3.math.cos(pitch), v3.math.sin(pitch),
                        v3.math.sin(azimuth) * v3.math.cos(pitch))
                target = mesh if cluster_index < retained_clusters else v3.Mesh()
                v3.branchlet_cluster(
                    target, centre, axis,
                    0.66 + 0.39 * (1 - t) + rng.random() * 0.24,
                    0.28 + 0.14 * rng.random(), 1 + rng.randrange(15), rng,
                    rng.random() * 0.2, 2, tile_bounds,
                )
            # Preserve the lifted side spray at every whorl; this is the small
            # crossed local volume that prevents an interior bare pole.
            f = 0.56
            centre = tuple(root[k] + (tip[k] - root[k]) * f for k in range(3))
            azimuth = angle + (rng.random() - 0.5) * 1.1
            v3.branchlet_cluster(
                mesh, centre, (v3.math.cos(azimuth), 0.45, v3.math.sin(azimuth)),
                0.54, 0.20, 1 + rng.randrange(15), rng, 0.2, 2, tile_bounds,
            )

    for volume_index in range(volume_hierarchy):
        t = 0.06 + rng.random() * 0.94
        y = 0.82 + (HEIGHT - 1.22) * t
        crown = v3.math.sin(v3.math.pi * (0.04 + 0.92 * t)) ** 0.44
        radius = (rng.random() ** 0.78) * (3.72 * crown + 0.18)
        azimuth = rng.random() * v3.math.tau
        centre = (v3.math.cos(azimuth) * radius, y + (rng.random() - 0.5) * 0.56,
                  v3.math.sin(azimuth) * radius)
        pitch = (rng.random() - 0.5) * 1.2
        yaw = rng.random() * v3.math.tau
        axis = (v3.math.cos(yaw) * v3.math.cos(pitch), v3.math.sin(pitch),
                v3.math.sin(yaw) * v3.math.cos(pitch))
        target = mesh if volume_index < retained_volumes else v3.Mesh()
        v3.branchlet_cluster(
            target, centre, axis, 0.56 + rng.random() * 0.46,
            0.25 + rng.random() * 0.13, 1 + rng.randrange(15), rng, 0.2, 2, tile_bounds,
        )

    for _ in range(6):
        azimuth = rng.random() * v3.math.tau
        centre = (v3.math.cos(azimuth) * (0.12 + rng.random() * 0.24),
                  HEIGHT - 0.68 + rng.random() * 0.30,
                  v3.math.sin(azimuth) * (0.12 + rng.random() * 0.24))
        v3.branchlet_cluster(
            mesh, centre, (v3.math.cos(azimuth) * 0.42, 0.84,
                           v3.math.sin(azimuth) * 0.42),
            0.48 + rng.random() * 0.20, 0.24 + rng.random() * 0.08,
            1 + rng.randrange(15), rng, 0.05, 2, tile_bounds,
        )

    min_y = min(point[1] for point in mesh.p)
    max_y = max(point[1] for point in mesh.p)
    y_span = max(max_y - min_y, 1e-6)
    mesh.p = [(point[0], (point[1] - min_y) * HEIGHT / y_span, point[2]) for point in mesh.p]
    mesh.normals()
    bake_parent_normals(v3, mesh)
    v3.write_glb(mesh, output, atlas_image, lod)
    return mesh


def patch_glb(path, lod, atlas_sha, normal_bake):
    raw = path.read_bytes()
    json_length = int.from_bytes(raw[12:16], 'little')
    document = json.loads(raw[20:20 + json_length])
    document['asset']['generator'] = 'build_conifer_v5@1-registered-cross-pair'
    document['nodes'][0]['name'] = f'conifer_v5_lod{lod}'
    document['meshes'][0]['name'] = f'conifer_v5_lod{lod}'
    document['materials'][0]['name'] = 'conifer_v5_authored_alpha_atlas'
    primitive = document['meshes'][0]['primitives'][0]
    index_count = document['accessors'][primitive['indices']]['count']
    position = document['accessors'][primitive['attributes']['POSITION']]
    document['extras'] = {
        'candidateOnly': True,
        'sourceAsset': 'conifer_v4_exact_hierarchy_and_atlas',
        'sourceHash': SOURCE_HASH,
        'geometry': 'registered-cross-pair-local-branchlet-v5',
        'lod': lod,
        'selection': 'same 36-layer/8-branch hierarchy; deterministic outer sprays and crown volumes',
        'vertices': index_count,
        'triangles': index_count // 3,
        'boundsMin': position.get('min'),
        'boundsMax': position.get('max'),
        'atlasSha256': atlas_sha,
        'normalBake': normal_bake,
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


def alpha_stats(path):
    from PIL import Image
    alpha = Image.open(path).convert('RGBA').getchannel('A')
    values = list(alpha.get_flattened_data()) if hasattr(alpha, 'get_flattened_data') else list(alpha.getdata())
    covered = sum(value >= ALPHA_CUTOFF for value in values)
    return {'width': alpha.width, 'height': alpha.height,
            'coverageAt16': covered / len(values), 'alphaMax': max(values)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    v3 = load_v3()
    source_dir = Path(args.source_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    source_gltf = source_dir / 'fir_tree_01_1k.gltf'
    texture_dir = source_dir / 'textures'
    atlas_path = output_dir / 'conifer_v5_branchlet_atlas.png'
    atlas_image = v3.atlas(texture_dir / 'fir_tree_01_twig_diff_1k.jpg', source_gltf, atlas_path)
    tile_bounds = v3.alpha_tile_bounds(atlas_image)
    atlas_sha = hashlib.sha256(atlas_path.read_bytes()).hexdigest()
    normal_bake = {
        'method': 'source-normal blended with parent outward normal for branchlet tiles',
        'sourceWeight': 0.64, 'parentWeight': 0.36, 'parentYWeight': 0.12,
        'barkTileUnchanged': True, 'alphaCutoff': ALPHA_CUTOFF,
    }
    reports = []
    meshes = {}
    for lod in (0, 1):
        path = output_dir / f'conifer_v5_lod{lod}.glb'
        meshes[lod] = build_mesh(v3, lod, atlas_image, tile_bounds, path)
        reports.append(patch_glb(path, lod, atlas_sha, normal_bake))

    impostor_path = output_dir / 'conifer_v5_impostor.png'
    v3.impostor(meshes[0], impostor_path, atlas_image, size=512)
    impostor_meta = {
        'schemaVersion': 1, 'candidateOnly': True,
        'sourceAsset': 'conifer_v5_lod0', 'sourceHash': SOURCE_HASH,
        'representation': 'lighting-neutral-srgb-albedo-alpha',
        'runtimeLightingRequired': True, 'frames': 8, 'columns': 4, 'rows': 2,
        'frameSize': 512, 'azimuthConvention': 'frame i = i / 8 * 2pi',
        'bakeMethod': 'existing offline source-atlas rasterizer; no sun/AO/emission',
        'sha256': hashlib.sha256(impostor_path.read_bytes()).hexdigest(),
        'alpha': alpha_stats(impostor_path),
    }
    (output_dir / 'conifer_v5_impostor.json').write_text(
        json.dumps(impostor_meta, indent=2) + '\n', encoding='utf-8',
    )
    print(json.dumps({
        'reports': reports, 'atlasSha256': atlas_sha,
        'impostor': impostor_meta,
    }, sort_keys=True))


if __name__ == '__main__':
    main()
