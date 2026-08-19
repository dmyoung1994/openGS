#!/usr/bin/env python3
"""Build a cluster-card conifer from a BlenderKit branch scan.

Photoreal scans (thousands of cm-sized needle sprays) decimate into confetti
and don't survive the engine's one-part alpha-atlas contract. Instead this
keeps the scan's branch skeleton for the silhouette and grows the canopy from
broad, soft-edged foliage cards placed in volumetric clusters along the
branches — the classic game-forest look (dense, layered, real 3D depth, light
geometry).

Pipeline (run with --background against the source .blend):
  1. decimate the branch object to a skeleton,
  2. normalise its uvs into the left half of the atlas and inverse-wrap its
     texture coordinates, then Cycles-bake the bark DIFFUSE colour there,
  3. generate N clusters of M cards along the crown's branch faces,
  4. composite 4 generated card textures into the right half of the atlas,
  5. join skeleton + cards, one <prefix>_authored_alpha_atlas material,
     export the one-part canonical LOD0 + decimated LOD1.

Usage:
  Blender --background src.blend --python scripts/build_cluster_tree.py -- \
    --prefix bk_conifer --branches tree --crown-min 1.0 --crown-max 5.5 \
    --trunk-tris 9000 --clusters 100 --cards-per-cluster 30 \
    --atlas-width 2048 --atlas-height 1024 --lod1-tris 12000 \
    --out-dir public/assets/trees
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_blenderkit_tree import (  # noqa: E402
    active_object,
    bake_diffuse_color,
    decimate,
    export_glb,
    new_image,
    set_cycles,
    world_bounds,
)


# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------

def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--branches", required=True, help="branch skeleton object name")
    parser.add_argument("--crown-min", type=float, default=1.0, help="world z of crown base")
    parser.add_argument("--crown-max", type=float, default=5.5, help="world z of crown top")
    parser.add_argument("--crown-radius", type=float, default=2.2,
                        help="hard radial reject for cards")
    parser.add_argument("--cone-base-radius", type=float, default=1.9,
                        help="cone radius at crown-min (silhouette taper)")
    parser.add_argument("--cone-top-radius", type=float, default=0.22,
                        help="cone radius at crown-max (silhouette taper)")
    parser.add_argument("--trunk-tris", type=int, default=9000)
    parser.add_argument("--clusters", type=int, default=100)
    parser.add_argument("--cards-per-cluster", type=float, default=30)
    parser.add_argument("--card-min", type=float, default=0.16, help="min card width (m)")
    parser.add_argument("--card-max", type=float, default=0.42, help="max card width (m)")
    parser.add_argument("--atlas-width", type=int, default=2048)
    parser.add_argument("--atlas-height", type=int, default=1024)
    parser.add_argument("--lod1-tris", type=int, default=12000)
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--seed", type=int, default=0x5EED)
    parser.add_argument("--out-dir", required=True)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    return args


# ---------------------------------------------------------------------------
# bark albedo into the left half of the atlas
# ---------------------------------------------------------------------------

def normalize_uvs_half(obj: bpy.types.Object) -> None:
    """Map the active uv layer into u in [0, 0.5), v in [0, 1) and insert
    inverse-mapping nodes before every default-uv texture so the shader still
    samples the source coordinates."""
    me = obj.data
    layer = me.uv_layers.active
    n = len(layer.data)
    buf = np.empty(n * 2, dtype=np.float32)
    layer.data.foreach_get("uv", buf)
    buf = buf.reshape(-1, 2)
    mn = buf.min(axis=0).astype(np.float32)
    rng = np.maximum(buf.max(axis=0) - mn, 1e-6).astype(np.float32)
    out = (buf - mn) / rng
    out[:, 0] *= 0.5
    layer.data.foreach_set("uv", out.ravel())
    # raw = (uv - 0) * (2*rng_x, rng_y) + mn  (Mapping: in*scale + location)
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.use_nodes:
            continue
        nt = mat.node_tree
        for node in list(nt.nodes):
            if node.type != "TEX_IMAGE" or node.inputs["Vector"].is_linked:
                continue
            mapping = nt.nodes.new("ShaderNodeMapping")
            mapping.location = (node.location.x - 300, node.location.y)
            mapping.inputs["Location"].default_value = (float(mn[0]), float(mn[1]), 0.0)
            mapping.inputs["Scale"].default_value = (float(2.0 * rng[0]), float(rng[1]), 1.0)
            coord = nt.nodes.new("ShaderNodeTexCoord")
            coord.location = (node.location.x - 600, node.location.y)
            nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
            nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])


def bake_bark(obj: bpy.types.Object, atlas: bpy.types.Image, samples: int) -> int:
    set_cycles(samples)
    return bake_diffuse_color(obj, atlas, samples, bypass_mixes=True)


# ---------------------------------------------------------------------------
# generated card textures (numpy; no PIL in Blender's python)
# ---------------------------------------------------------------------------

def value_noise(w: int, h: int, cells: int, seed: int) -> np.ndarray:
    """Smooth 2-octave value noise in [0,1], shape (h, w)."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((h, w), dtype=np.float32)
    weight = 0.0
    for octave in range(2):
        cw = max(2, cells * (2 ** octave))
        ch = max(2, int(cells * (h / w)) * (2 ** octave)) if h != w else max(2, cells * (2 ** octave))
        grid = rng.random((ch, cw), dtype=np.float32)
        posx = np.linspace(0.0, cw - 1.0, w)
        x0 = posx.astype(np.int64)
        x1 = np.minimum(x0 + 1, cw - 1)
        fx = (posx - x0).astype(np.float32)[None, :]
        posy = np.linspace(0.0, ch - 1.0, h)
        y0 = posy.astype(np.int64)
        y1 = np.minimum(y0 + 1, ch - 1)
        fy = (posy - y0).astype(np.float32)[:, None]
        g00 = grid[np.ix_(y0, x0)]
        g01 = grid[np.ix_(y0, x1)]
        g10 = grid[np.ix_(y1, x0)]
        g11 = grid[np.ix_(y1, x1)]

        acc += (weight + 0.5) * (
            g00 * (1 - fx) * (1 - fy) + g01 * fx * (1 - fy)
            + g10 * (1 - fx) * fy + g11 * fx * fy
        )
        weight += 0.5
    acc /= weight
    lo, hi = float(acc.min()), float(acc.max())
    if hi - lo < 1e-6:
        return np.full((h, w), 0.5, dtype=np.float32)
    return ((acc - lo) / (hi - lo)).astype(np.float32)


# Healthy, slightly varied greens (TGL-vibrant, not scan-dark).
CARD_BASES = [
    (0.300, 0.640, 0.170),  # deep green
    (0.400, 0.760, 0.220),  # medium green
    (0.500, 0.850, 0.280),  # bright green
    (0.360, 0.720, 0.340),  # yellow-green
]


def make_card(variant: int, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (rgb [h,w,3], alpha [h,w]) for one card variant.

    Image row 0 is the card TOP (uv v=1), matching the card's local +y.
    """
    seed = 100 + variant * 17
    n1 = 0.6 * value_noise(w, h, 10, seed) + 0.4 * value_noise(w, h, 22, seed + 7)
    n2 = value_noise(w, h, 5, seed + 13)
    rows = (np.arange(h, dtype=np.float32) / h)  # 0 = top
    cols = np.arange(w, dtype=np.float32) / w
    cx, cy = cols[None, :] - 0.5, rows[:, None] - 0.5
    r = np.sqrt((cx / 0.46) ** 2 + (cy / 0.55) ** 2)
    # soft eroded edge
    edge = 1.0 - r
    alpha = np.clip((edge * 1.9 - 0.42 + 0.38 * (n1 - 0.5)) * 1.6, 0.0, 1.0)
    alpha = (alpha ** 1.4).astype(np.float32)
    # colour: top-lit gradient + vertical spray streaks
    v = 1.0 - rows[:, None]  # 1 at top
    grad = 0.72 + 0.55 * v
    streaks = 0.88 + 0.28 * (n2 - 0.5) * 2.0
    base = np.array(CARD_BASES[variant], dtype=np.float32)
    col = base[None, None, :] * grad[:, :, None] * streaks[:, :, None]
    col *= (0.94 + 0.10 * (n1 - 0.5) * 2.0)[:, :, None]
    # a few dark gaps between sprays
    gap = value_noise(w, h, 14, seed + 29)
    col *= (0.75 + 0.25 * gap)[:, :, None]
    col = np.clip(col, 0.0, 1.0).astype(np.float32)
    return col, alpha


def composite_cards(atlas: bpy.types.Image, width: int, height: int) -> None:
    """Write the 4 card variants into the right half of the atlas.

    Each variant owns a 0.25 (uv-u) x 0.5 (uv-v) block: u0 in {0.5, 0.75},
    v0 in {0, 0.5}. Image row 0 is v=1, so the block's rows are
    [(1-(v0+0.5))*H, (1-v0)*H).
    """
    buf = np.empty(width * height * 4, dtype=np.float32)
    atlas.pixels.foreach_get(buf)
    buf = buf.reshape(height, width, 4)
    half = width // 2
    for variant in range(4):
        u0 = 0.5 + 0.25 * (variant % 2)          # 0.5 | 0.75
        v0 = 0.5 * (variant // 2)                # 0   | 0.5
        row0 = int((1.0 - (v0 + 0.5)) * height)
        row1 = int((1.0 - v0) * height)
        col0 = int(u0 * width)
        col1 = int((u0 + 0.25) * width)
        rw, rh = col1 - col0, row1 - row0
        assert rw > 0 and rh > 0
        col, alpha = make_card(variant, rw, rh)
        region = buf[row0:row1, col0:col1]
        region[:, :, 0] = col[:, :, 0]
        region[:, :, 1] = col[:, :, 1]
        region[:, :, 2] = col[:, :, 2]
        region[:, :, 3] = alpha
    # left half is bark: fully opaque
    buf[:, :half, 3] = 1.0
    atlas.pixels.foreach_set(buf.ravel())
    atlas.pack()


# ---------------------------------------------------------------------------
# cluster cards
# ---------------------------------------------------------------------------

ELLIPSE = [(math.cos(2 * math.pi * i / 6), math.sin(2 * math.pi * i / 6)) for i in range(6)]


def card_matrix(center: Vector, nrm: Vector, azimuth: float, sx: float, sy: float) -> Matrix:
    n = nrm.normalized()
    up = Vector((0.0, 0.0, 1.0)) if abs(n.z) < 0.9 else Vector((0.0, 1.0, 0.0))
    x = n.cross(up).normalized()
    rot = Matrix.Rotation(azimuth, 4, n)
    x2 = (rot.to_3x3() @ x)
    y2 = (rot.to_3x3() @ (n.cross(x)))
    return Matrix.Translation(center) @ Matrix((
        (x2.x * sx, y2.x * sy, n.x, 0.0),
        (x2.y * sx, y2.y * sy, n.y, 0.0),
        (x2.z * sx, y2.z * sy, n.z, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    ))


def build_cards(args: argparse.Namespace, branch: bpy.types.Object) -> bpy.types.Object:
    random.seed(args.seed)
    me = branch.data
    n_faces = len(me.polygons)
    # area-weighted candidate faces inside the crown band
    cand = []
    for i in range(n_faces):
        p = me.polygons[i]
        c = p.center
        if args.crown_min <= c.z <= args.crown_max:
            cand.append((i, p.area, c, p.normal))
    if not cand:
        raise SystemExit("no branch faces in the crown band — check --crown-min/--crown-max")
    total = sum(a for _, a, _, _ in cand)
    cum = []
    acc = 0.0
    for _, a, _, _ in cand:
        acc += a
        cum.append(acc)

    def pick_cluster():
        r = random.uniform(0.0, total)
        lo, hi = 0, len(cum) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if cum[mid] < r:
                lo = mid + 1
            else:
                hi = mid
        idx, _, center, normal = cand[lo]
        # push outward along the branch normal so the card envelope sits PAST
        # the decimated twig spikes (the twigs are the spikes we must hide)
        offset = normal * random.uniform(0.06, 0.17) + Vector((
            random.gauss(0, 0.10), random.gauss(0, 0.10), random.gauss(0, 0.09)
        ))
        return center + offset, normal

    verts: list[tuple[float, float, float]] = []
    vert_uvs: list[tuple[float, float]] = []
    faces: list[tuple[int, int, int]] = []
    variant_weights = [30, 35, 25, 10]
    placed = 0
    for _ in range(args.clusters):
        ccenter, cnrm = pick_cluster()
        count = int(args.cards_per_cluster * random.uniform(0.7, 1.3))
        for _ in range(count):
            pos = ccenter + Vector((
                random.gauss(0, 0.10), random.gauss(0, 0.10), random.gauss(0, 0.12)
            ))
            # conical silhouette: allowed radius tapers with height
            t = (pos.z - args.crown_min) / max(1e-5, args.crown_max - args.crown_min)
            t = min(max(t, 0.0), 1.0)
            cone_r = args.cone_base_radius + (args.cone_top_radius - args.cone_base_radius) * t
            if pos.z < 0.05:
                continue
            if math.hypot(pos.x, pos.y) > max(cone_r + 0.12, 0.3):
                continue
            nrm = (cnrm + Vector((random.gauss(0, 0.5), random.gauss(0, 0.5), random.gauss(0, 0.5)))).normalized()
            sx = random.uniform(args.card_min, args.card_max)
            sy = sx * random.uniform(0.55, 0.95)
            azim = random.uniform(0.0, 2.0 * math.pi)
            variant = random.choices([0, 1, 2, 3], weights=variant_weights)[0]
            u0 = 0.5 + 0.25 * (variant % 2)
            v0 = 0.5 * (variant // 2)
            mat4 = card_matrix(pos, nrm, azim, sx, sy)
            v0i = len(verts)
            for ex, ey in ELLIPSE:
                p = mat4 @ Vector((ex, ey, 0.0))
                verts.append((p.x, p.y, p.z))
                vert_uvs.append((u0 + (ex + 1) * 0.125, v0 + (ey + 1) * 0.25))
            for i in range(5):
                faces.append((v0i, v0i + 1 + i, v0i + (2 + i) % 6))
            placed += 1
    # guarantee a tip cluster at the crown top so the leader doesn't stick out
    top = max((p.center.z for p in me.polygons), default=args.crown_max)
    tip = Vector((0.0, 0.0, min(top, args.crown_max)))
    for _ in range(int(args.cards_per_cluster * 1.4)):
        pos = tip + Vector((
            random.gauss(0, 0.12), random.gauss(0, 0.12), random.gauss(0, 0.14)
        ))
        if math.hypot(pos.x, pos.y) > args.cone_top_radius + 0.25:
            continue
        nrm = Vector((random.gauss(0, 0.6), random.gauss(0, 0.6), random.gauss(0, 0.4))).normalized()
        sx = random.uniform(args.card_min, args.card_max * 0.8)
        sy = sx * random.uniform(0.55, 0.95)
        azim = random.uniform(0.0, 2.0 * math.pi)
        variant = random.choices([0, 1, 2, 3], weights=variant_weights)[0]
        u0 = 0.5 + 0.25 * (variant % 2)
        v0 = 0.5 * (variant // 2)
        mat4 = card_matrix(pos, nrm, azim, sx, sy)
        v0i = len(verts)
        for ex, ey in ELLIPSE:
            p = mat4 @ Vector((ex, ey, 0.0))
            verts.append((p.x, p.y, p.z))
            vert_uvs.append((u0 + (ex + 1) * 0.125, v0 + (ey + 1) * 0.25))
        for i in range(5):
            faces.append((v0i, v0i + 1 + i, v0i + (2 + i) % 6))
        placed += 1
    print(f"[cards] placed={placed} (clusters={args.clusters})")
    if placed < args.clusters // 4:
        raise SystemExit("card placement rejected almost everything — check crown params")
    card_me = bpy.data.meshes.new(f"{args.prefix}_cards")
    card_me.from_pydata(verts, [], faces)
    card_me.validate()
    # uvs are per-loop: resolve each loop through its vertex uv
    vuv = np.array(vert_uvs, dtype=np.float32)
    n_loops = len(card_me.loops)
    loop_uv = np.empty(n_loops * 2, dtype=np.float32)
    for i in range(len(card_me.polygons)):
        poly = card_me.polygons[i]
        for li in poly.loop_indices:
            vi = card_me.loops[li].vertex_index
            loop_uv[li * 2:li * 2 + 2] = vuv[vi]
    layer = card_me.uv_layers.new(name="UVMap")
    layer.data.foreach_set("uv", loop_uv)
    card_obj = bpy.data.objects.new(f"{args.prefix}_cards", card_me)
    # background mode has no context.collection; link into the branch's own
    # collection so the object is selectable and joinable
    for coll in branch.users_collection:
        coll.objects.link(card_obj)
        break
    card_me.update()
    bpy.context.view_layer.update()
    return card_obj


# ---------------------------------------------------------------------------
# merge two meshes (with uv layers) — background-safe, no join operator
# ---------------------------------------------------------------------------

def merge_mesh_into(target_me: bpy.types.Mesh, source_me: bpy.types.Mesh) -> None:
    """Append source geometry (verts/edges/faces + active uv layer) into target.

    Both meshes must be in the same (world/local) space — the card generator
    and the branch skeleton are both identity-transformed at the origin.
    """
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(target_me)
    tgt_uv = bm.loops.layers.uv.verify()

    src_bm = bmesh.new()
    src_bm.from_mesh(source_me)
    src_uv = src_bm.loops.layers.uv.verify()

    new_verts = {sv.index: bm.verts.new(sv.co) for sv in src_bm.verts}
    for se in src_bm.edges:
        a, b = se.verts[0].index, se.verts[1].index
        bm.edges.new((new_verts[a], new_verts[b]))
    for sf in src_bm.faces:
        verts = [new_verts[v.index] for v in sf.verts]
        nf = bm.faces.new(verts)
        for i, sl in enumerate(sf.loops):
            nf.loops[i][tgt_uv] = sl[src_uv]

    src_bm.free()
    bm.to_mesh(target_me)
    bm.free()
    target_me.update()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    args = arguments()
    outdir = Path(args.out_dir)
    outdir.mkdir(parents=True, exist_ok=True)

    branch = bpy.data.objects.get(args.branches)
    if branch is None or branch.type != "MESH":
        raise SystemExit(f"branch object {args.branches!r} not found")
    active_object(branch)
    for mod in list(branch.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    decimate(branch, args.trunk_tris)
    lo, hi = world_bounds(branch)
    print(f"[bounds] {tuple(round(v,3) for v in lo)} .. {tuple(round(v,3) for v in hi)}")

    atlas = new_image(f"{args.prefix}_atlas", args.atlas_width, args.atlas_height)
    normalize_uvs_half(branch)
    lit = bake_bark(branch, atlas, args.samples)
    if lit < 20000:
        raise SystemExit(f"[bark] empty bake ({lit} lit pixels) — aborting")

    # Cards are generated after the bark bake so the bake stays single-material.
    cards = build_cards(args, branch)

    # Final one-part material.
    name = f"{args.prefix}_authored_alpha_atlas"
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.85
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = atlas
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    composite_cards(atlas, args.atlas_width, args.atlas_height)

    # Merge cards into the skeleton: one object, one material, one uv layer.
    merge_mesh_into(branch.data, cards.data)
    bpy.data.objects.remove(cards, do_unlink=True)
    branch.name = args.prefix
    joined = branch
    joined.data.polygons.foreach_set(
        "material_index", np.zeros(len(joined.data.polygons), dtype=np.int32)
    )
    while len(joined.material_slots) > 1:
        joined.active_material_index = len(joined.material_slots) - 1
        bpy.ops.object.material_slot_remove()
    joined.material_slots[0].material = mat
    joined.data.update()

    for tag, tris in (("lod0", None), ("lod1", args.lod1_tris)):
        if tris is not None:
            decimate(joined, tris)
        path = outdir / f"{args.prefix}_{tag}.glb"
        export_glb(joined, path)
        lo2, hi2 = world_bounds(joined)
        import hashlib
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        tris_now = sum(len(p.loop_indices) for p in joined.data.polygons) // 3
        print(f"[{tag}] {path} tris={tris_now} "
              f"height={hi2.z - lo2.z:.3f}m sha256={digest} bytes={path.stat().st_size}")
    print(f"[done] {args.prefix}: cluster-card one-part canonical LOD0 + LOD1")
    print(f"[next] bake impostor: Blender --background --python "
          f"scripts/bake_tree_impostor.py -- --input {outdir / (args.prefix + '_lod0.glb')} "
          f"--output {outdir / (args.prefix + '_impostor.png')} --frames 8 --size 512")


if __name__ == "__main__":
    main()
