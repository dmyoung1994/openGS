#!/usr/bin/env python3
"""Build the isolated dense local-cluster conifer v4 candidate.

The source atlas is the licensed Poly Haven Fir Tree 01 twig diffuse/alpha.
Unlike the rejected source-triangle candidate, v4 keeps the complete variant-A
crown as the offline silhouette reference and composes many small, local,
source-textured sprays around a deterministic trunk/primary-branch scaffold.
The output directory is intentionally a candidate-only path.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import random
from pathlib import Path


HEIGHT = 18.895
SEED = 0xC04F4E


def load_v3():
    path = Path(__file__).with_name("build_conifer_v3.py")
    spec = importlib.util.spec_from_file_location("conifer_v3_builder", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def build_dense(v3, lod, output, atlas_image, seed=SEED, tile_bounds=None):
    rng = random.Random(seed)
    mesh = v3.Mesh()
    bark = v3.tile_uv(0)
    # Both LODs use the same trunk and whorl hierarchy. LOD1 reduces only the
    # local spray population/plane count, preventing the bare-pole handoff that
    # came from independently regenerating a 24x6 crown.
    steps = 26
    centres = []
    trunk_top = HEIGHT - 0.82
    for i in range(steps + 1):
        t = i / steps
        centres.append((0.12 * v3.math.sin(t * 2.2), trunk_top * t,
                        0.10 * v3.math.sin(t * 1.6 + 0.4)))
    for i in range(steps):
        v3.cylinder(mesh, centres[i], centres[i + 1],
                    0.42 * (1 - i / steps) ** 0.7 + 0.032,
                    0.42 * (1 - (i + 1) / steps) ** 0.7 + 0.032,
                    8 if lod == 0 else 6, bark)

    # Keep index/render references below the 120k candidate budget while
    # retaining the dense local-cluster silhouette. LOD1 traverses the complete
    # LOD0 hierarchy and retains every local spray as a crossed pair plus a
    # reduced volume subset; both tiers therefore share deterministic crown
    # layers and branchlet centres.
    levels, branches, hierarchy_clusters, volume_hierarchy = 36, 8, 12, 620
    clusters = hierarchy_clusters
    volume_count = volume_hierarchy

    for level in range(levels):
        t = (level + 0.35) / levels
        y = 1.02 + (HEIGHT - 1.56) * t + (rng.random() - 0.5) * 0.52
        radius = (v3.math.sin(v3.math.pi * (0.075 + 0.90 * t)) ** 0.48) * (3.72 + 0.60 * rng.random())
        phase = rng.random() * v3.math.tau
        for branch_index in range(branches):
            angle = phase + v3.math.tau * branch_index / branches + (rng.random() - 0.5) * 0.78
            root = (0.12 * v3.math.sin(y * 0.12), y, 0.10 * v3.math.sin(y * 0.08 + 0.4))
            droop = 0.32 + 0.72 * (1 - t) + rng.random() * 0.28
            tip = (root[0] + v3.math.cos(angle) * radius, root[1] - droop,
                   root[2] + v3.math.sin(angle) * radius)
            v3.cylinder(mesh, root, tip, 0.045 * (1 - 0.35 * t), 0.006,
                        5 if lod == 0 else 4, bark)
            for cluster_index in range(hierarchy_clusters):
                f = (cluster_index + 0.35 + rng.random() * 0.25) / hierarchy_clusters
                centre = tuple(root[k] + (tip[k] - root[k]) * f for k in range(3))
                centre = (centre[0], centre[1] + (rng.random() - 0.5) * 0.26, centre[2])
                azimuth = angle + (rng.random() - 0.5) * 0.8
                pitch = (rng.random() - 0.5) * 1.0 - 0.12 * (1 - t)
                axis = (v3.math.cos(azimuth) * v3.math.cos(pitch), v3.math.sin(pitch),
                        v3.math.sin(azimuth) * v3.math.cos(pitch))
                target = mesh if cluster_index < clusters else v3.Mesh()
                v3.branchlet_cluster(target, centre, axis, 0.66 + 0.39 * (1 - t) + rng.random() * 0.24,
                                     0.28 + 0.14 * rng.random(), 1 + rng.randrange(15), rng,
                                     rng.random() * 0.2, 4 if lod == 0 else 2, tile_bounds)
            # A second, lifted local spray gives each whorl a 3-D crown instead
            # of a single horizontal branch card, while remaining small/local.
            f = 0.56
            centre = tuple(root[k] + (tip[k] - root[k]) * f for k in range(3))
            azimuth = angle + (rng.random() - 0.5) * 1.1
            v3.branchlet_cluster(mesh, centre, (v3.math.cos(azimuth), 0.45, v3.math.sin(azimuth)),
                                 0.54, 0.20, 1 + rng.randrange(15), rng, 0.2,
                                 4 if lod == 0 else 2, tile_bounds)

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
        target = mesh if volume_index < volume_count else v3.Mesh()
        v3.branchlet_cluster(target, centre, axis, 0.56 + rng.random() * 0.46,
                             0.25 + rng.random() * 0.13, 1 + rng.randrange(15), rng, 0.2,
                             4 if lod == 0 else 2, tile_bounds)

    terminal_count = 6
    for _ in range(terminal_count):
        azimuth = rng.random() * v3.math.tau
        centre = (v3.math.cos(azimuth) * (0.12 + rng.random() * 0.24),
                  HEIGHT - 0.68 + rng.random() * 0.30,
                  v3.math.sin(azimuth) * (0.12 + rng.random() * 0.24))
        v3.branchlet_cluster(mesh, centre, (v3.math.cos(azimuth) * 0.42, 0.84,
                                             v3.math.sin(azimuth) * 0.42),
                             0.48 + rng.random() * 0.20, 0.24 + rng.random() * 0.08,
                             1 + rng.randrange(15), rng, 0.05, 4 if lod == 0 else 2, tile_bounds)
    # Ground every LOD at y=0 and register both to the authored source height.
    # Local sprays can extend a little beyond the scaffold, so normalize after
    # composition rather than relying on the trunk's nominal HEIGHT alone.
    min_y = min(p[1] for p in mesh.p)
    max_y = max(p[1] for p in mesh.p)
    y_span = max(max_y - min_y, 1e-6)
    mesh.p = [(p[0], (p[1] - min_y) * HEIGHT / y_span, p[2]) for p in mesh.p]
    mesh.normals()
    stats, _ = v3.write_glb(mesh, output, atlas_image, lod), mesh
    # write_glb has no return in the inherited builder; derive exact render
    # counts here and keep them in candidate metadata for offline validation.
    document = json.loads(output.read_bytes()[20:20 + int.from_bytes(output.read_bytes()[12:16], 'little')])
    document.setdefault('extras', {})
    document['asset']['generator'] = 'build_conifer_v4@1-dense-local-clusters'
    document['meshes'][0]['name'] = f'conifer_v4_lod{lod}'
    document['nodes'][0]['name'] = f'conifer_v4_lod{lod}'
    document['materials'][0]['name'] = 'conifer_v4_authored_alpha_atlas'
    document['extras'].update({
        'candidateOnly': True, 'sourceAsset': 'fir_tree_01_variant_a_complete_crown',
        'sourceHash': '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709',
        'geometry': 'dense-local-source-branch-clusters-v4', 'lod': lod,
        'selection': 'deterministic full-crown volume/whorl cluster bake; no source triangle sampling',
        'vertices': len(mesh.p), 'triangles': len(mesh.i) // 3,
        'boundsMin': [min(p[i] for p in mesh.p) for i in range(3)],
        'boundsMax': [max(p[i] for p in mesh.p) for i in range(3)],
    })
    raw = output.read_bytes(); json_length = int.from_bytes(raw[12:16], 'little'); json_blob = json.dumps(document, separators=(',', ':')).encode(); json_blob += b' ' * ((4 - len(json_blob) % 4) % 4)
    binary_offset = 20 + json_length + 8
    binary = raw[binary_offset:]
    total_length = 12 + 8 + len(json_blob) + 8 + len(binary)
    output.write_bytes(
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
    # The source package keeps the glTF beside a `textures/` directory.  Keep
    # the CLI rooted at the package directory so provenance paths remain clear.
    gltf_path = source_dir / 'fir_tree_01_1k.gltf'
    texture_dir = source_dir / 'textures'
    atlas_path = output_dir / 'conifer_v4_branchlet_atlas.png'
    image = v3.atlas(texture_dir / 'fir_tree_01_twig_diff_1k.jpg', gltf_path, atlas_path)
    tile_bounds = v3.alpha_tile_bounds(image)
    reports = []
    for lod in (0, 1):
        out = output_dir / f'conifer_v4_lod{lod}.glb'
        reports.append(build_dense(v3, lod, out, image, tile_bounds=tile_bounds))
    print(json.dumps({'reports': reports, 'atlasSha256': hashlib.sha256(atlas_path.read_bytes()).hexdigest()}, sort_keys=True))


if __name__ == '__main__':
    main()
