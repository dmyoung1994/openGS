#!/usr/bin/env python3
"""Build runtime tree GLBs (LOD0 + LOD1) from a BlenderKit .blend candidate.

Pipeline (matches the existing fir-sapling contract consumed by src/scene/Trees.js):
  1. separate the source mesh by material/object into semantic role objects
     (trunk | branches | foliage — the material names drive the runtime role
     detector in src/scene/Trees.js `_treeRoleForName`);
  2. decimate each role to the per-LOD triangle budget;
  3. rebuild each role material as either a flat baseColorFactor or a single
     sRGB base-colour texture (with alpha cutout for card foliage);
  4. export one GLB per LOD (role objects remain separate glTF nodes).

The GLB is the only runtime input: no vertex colours, no normal/ARM maps, no
displacement, no scene extras. Flat materials export as baseColorFactor so the
lighting-neutral impostor bake (scripts/bake_tree_impostor.py) picks the true
albedo from the Principled Base Color default.

Usage:
  blender -b --python scripts/build_bk_tree.py -- <asset_id>
"""
from __future__ import annotations

import hashlib
import json
import random
import sys
import tempfile
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'public/assets/trees_src/bk_alpine'
DEST = ROOT / 'public/assets/trees'
REPORT = ROOT / 'public/assets/trees_candidates/bk_report.json'

# sRGB base colours (0..1 sRGB floats) for flat role materials. They mirror the
# existing canonical ROLE_COLORS so the new species sit in the same tonal family.
FLAT = {
    'bark': (0.26, 0.14, 0.065),
    'trunk': (0.31, 0.18, 0.085),
    'branches': (0.22, 0.115, 0.045),
}

# Per-asset authority.
#   object : the single source object holding all roles (multi-slot mesh)
#   objects: mapping source object name -> role (whole object is one role)
#   drop   : material names whose polygons are deleted (ground patches etc.)
#   roles  : role -> (source material name, runtime material name, style)
#            style = flat key in FLAT | 'flat:(r,g,b)' sRGB | 'keep:<image>' |
#                    'gold_alpha' (flat gold RGB + source needle alpha)
ASSETS = {
    'bk_grand_fir': {
        'source': SRC / 'grand_fir.blend',
        'object': 'Fir',
        'drop': {'ground'},
        'roles': {
            'trunk': ('trunk', 'trunk', 'bake'),
            'branches': ('branches', 'branches', 'bake'),
            'foliage': ('fir_needles', 'foliage', 'bake'),
            'foliage_2': ('fir_needles2', 'foliage_2', 'bake'),
        },
        'tri_budget': {
            0: {'trunk': 9000, 'branches': 26000, 'foliage': 78000, 'foliage_2': 52000},
            1: {'trunk': 2500, 'branches': 6000, 'foliage': 18000, 'foliage_2': 12000},
        },
    },
    'bk_dense_conifer': {
        'source': SRC / 'a_tree_25m.blend',
        'objects': {'leaves.002': 'foliage', 'tree': 'branches'},
        'drop': set(),
        'roles': {
            # Sampled linear (0.023,0.058,0.009); the flat style takes sRGB.
            'foliage': ('Material.003', 'foliage', 'flat:(0.165,0.267,0.093)'),
            'branches': ('Moss Bark.004', 'branches', 'keep:Moss Bark_BaseColor.jpg'),
        },
        'tri_budget': {
            0: {'foliage': 85000, 'branches': 35000},
            1: {'foliage': 20000, 'branches': 8000},
        },
    },
    'bk_golden_larch': {
        'source': SRC / 'larch_fall.blend',
        'object': 'Larch Tree Fall Season',
        'drop': set(),
        'roles': {
            # The former 'gold_alpha' hack painted flat gold over a dilated copy
            # of the source alpha because the raw base-colour image was not the
            # authored autumn colour. Baking the node graph gets the real thing,
            # and the empty canopy it used to produce was the image-encode bug in
            # _packed_srgb_image, not the colour.
            'foliage': ('Walnut_Bark', 'foliage', 'bake'),
            'branches': ('Walnut_Bark_1', 'branches', 'bake'),
        },
        'tri_budget': {
            0: {'foliage': 90000, 'branches': 50000},
            1: {'foliage': 22000, 'branches': 12000},
        },
    },
    # 29 m Scots pine: an open, high, tufted crown — the silhouette that breaks up
    # a wall of symmetric firs. Its canopy is a geometry-nodes scatter, so the
    # build realizes instances and thins them rather than decimating the cards.
    'bk_scots_pine': {
        'source': SRC / 'scots_pine.blend',
        'object': 'Pine Tree Sylvestris.001',
        'realize': {
            'parent': 'Pine Tree Sylvestris.001',
            # source instance object -> instances kept per LOD. dead_needle is
            # deliberately absent: 8320 instances of brown litter that read as
            # dirt on the crown at every distance the tree is actually seen.
            'instances': {
                'needles_3': {0: 620, 1: 150},
                'Pine_needle_1': {0: 1250, 1: 320},
            },
        },
        # branches.003 is the twiglet inside each needle spray — 161k triangles of
        # dark bark buried in the canopy, where it reads as clutter rather than
        # structure. The tree's real limbs live in trunk.main.001, so dropping it
        # costs no silhouette and removes a third of the mesh.
        'drop': {'ground.002', 'branches.003'},
        'roles': {
            'trunk': ('trunk.main.001', 'trunk', 'bake'),
            'foliage': ('leaf.003', 'foliage', 'bake'),
        },
        'tri_budget': {
            # Canopy density is set by the instance budget above, so the foliage
            # role is exported at its authored topology (0 = no decimation).
            # Only the smooth 0.9M-triangle trunk is reduced.
            0: {'trunk': 26000, 'foliage': 0},
            1: {'trunk': 6000, 'foliage': 0},
        },
    },
    'bk_spruce': {
        'source': SRC / 'spruce.blend',
        'object': 'leaves',
        'drop': set(),
        'roles': {
            'foliage': ('Material.001', 'foliage', 'flat:(0.101,0.343,0.22)'),
        },
        'tri_budget': {
            0: {'foliage': 95000},
            1: {'foliage': 22000},
        },
    },
}


def parse_args() -> str:
    argv = sys.argv[sys.argv.index('--') + 1:]
    if not argv or argv[0] not in ASSETS:
        raise SystemExit(f'usage: blender -b --python scripts/build_bk_tree.py -- <{"|".join(ASSETS)}>')
    return argv[0]


def tri_count(mesh) -> int:
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def slot_index_of(obj, mat_name: str) -> int:
    for i, slot in enumerate(obj.material_slots):
        if slot.material is not None and slot.material.name == mat_name:
            return i
    raise SystemExit(f'material {mat_name!r} not found on {obj.name!r}')


def separate_slot(obj, slot: int) -> bpy.types.Object:
    """Split obj into (remainder on obj, new object with the slot's faces).

    Context-free bmesh path: the mesh-edit operators are unreliable in
    background mode (stale context.object after deletions, persisted selection
    state in .blend files), so this copies faces directly with UVs.
    """
    me = obj.data
    bm_src = bmesh.new()
    bm_src.from_mesh(me)
    uv_src = bm_src.loops.layers.uv.verify()
    faces_chunk = [f for f in bm_src.faces if f.material_index == slot]
    faces_rest = [f for f in bm_src.faces if f.material_index != slot]
    if not faces_chunk:
        bm_src.free()
        raise SystemExit(f'no polygons in slot {slot} of {obj.name!r}')

    def copy_faces(bm_dst, faces):
        uv_dst = bm_dst.loops.layers.uv.verify()
        vmap: dict[int, bpy.types.bmeshVert] = {}
        emap: dict[int, bpy.types.bmeshEdge] = {}
        for f in faces:
            for e in f.edges:
                if e.index not in emap:
                    v1 = vmap.setdefault(e.verts[0].index, bm_dst.verts.new(e.verts[0].co))
                    v2 = vmap.setdefault(e.verts[1].index, bm_dst.verts.new(e.verts[1].co))
                    emap[e.index] = bm_dst.edges.new((v1, v2))
            vlist = [vmap.setdefault(v.index, bm_dst.verts.new(v.co)) for v in f.verts]
            nf = bm_dst.faces.new(vlist)
            nf.material_index = f.material_index
            for ls, ld in zip(f.loops, nf.loops):
                if uv_src is not None and uv_dst is not None:
                    ld[uv_dst] = ls[uv_src]

    bm_chunk = bmesh.new()
    bm_rest = bmesh.new()
    copy_faces(bm_chunk, faces_chunk)
    if faces_rest:
        copy_faces(bm_rest, faces_rest)
        bm_rest.to_mesh(me)
    else:
        me.clear_geometry()
    me.update()

    new_me = bpy.data.meshes.new(f'{me.name}_slot{slot}')
    bm_chunk.to_mesh(new_me)
    # Keep the full slot list so material_index values stay valid; the builder
    # replaces each role object's single material before export anyway.
    for slot_mat in me.materials:
        new_me.materials.append(slot_mat)
    new_obj = bpy.data.objects.new(f'{obj.name}_slot{slot}', new_me)
    for coll in obj.users_collection:
        coll.objects.link(new_obj)
    new_obj.matrix_world = obj.matrix_world.copy()

    bm_src.free()
    bm_chunk.free()
    bm_rest.free()
    return new_obj


def thin_cards_to(obj, target: int, seed: str) -> int:
    """Reduce a card role to a triangle budget by deleting WHOLE cards.

    Collapse decimation is wrong for alpha-cutout foliage: it welds a needle
    quad's corners together and destroys the silhouette the alpha depends on, so
    LOD1 arrives as shredded lace rather than a thinner canopy. (It also simply
    fails to reach the budget on card meshes — the fir's `foliage_2` role stopped
    at 42776 triangles against a 12000 target.)

    Islands are whole cards here, so dropping seeded islands keeps every surviving
    needle exactly as authored and reduces DENSITY, which is what a distance LOD
    should do.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()

    # Connected-component walk over shared vertices; each component is one card.
    seen: set[int] = set()
    islands: list[list] = []
    for face in bm.faces:
        if face.index in seen:
            continue
        stack, island = [face], []
        seen.add(face.index)
        while stack:
            current = stack.pop()
            island.append(current)
            for edge in current.edges:
                for neighbour in edge.link_faces:
                    if neighbour.index not in seen:
                        seen.add(neighbour.index)
                        stack.append(neighbour)
        islands.append(island)

    total = sum(len(f.verts) - 2 for island in islands for f in island)
    if total <= target or not islands:
        bm.free()
        return total
    rng = random.Random(f'{seed}:{obj.name}:{target}')
    order = list(range(len(islands)))
    rng.shuffle(order)
    kept, running = set(), 0
    for index in order:
        cost = sum(len(f.verts) - 2 for f in islands[index])
        if running + cost > target:
            continue
        kept.add(index)
        running += cost
    if not kept:
        # The budget cannot fit even one island. Deleting everything would silently
        # remove the role from the tree (this is exactly how the fir lost its trunk),
        # so keep the largest island and report the overrun instead.
        largest = max(range(len(islands)), key=lambda i: len(islands[i]))
        kept.add(largest)
        running = sum(len(f.verts) - 2 for f in islands[largest])
        print(f'[thin] {obj.name}: budget {target} smaller than one island; '
              f'keeping the largest ({running} tris)')
    doomed = [f for index, island in enumerate(islands) if index not in kept for f in island]
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    print(f'[thin] {obj.name}: {len(islands)} cards / {total} tris -> '
          f'{len(kept)} cards / {running} tris')
    return running


def decimate_to(obj, target: int) -> int:
    """Add a DECIMATE modifier (the glTF exporter applies it via export_apply)
    and return the evaluated triangle count."""
    if target > 0:
        tris = tri_count(obj.data)
        if tris > target:
            for m in list(obj.modifiers):
                obj.modifiers.remove(m)
            mod = obj.modifiers.new('dec', 'DECIMATE')
            mod.ratio = target / tris
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    ev_me = evaluated.to_mesh()
    try:
        return tri_count(ev_me)
    finally:
        evaluated.to_mesh_clear()


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_flat_material(name: str, srgb: tuple[float, float, float]) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (
        srgb_to_linear(srgb[0]), srgb_to_linear(srgb[1]), srgb_to_linear(srgb[2]), 1.0)
    bsdf.inputs['Roughness'].default_value = 0.9
    mat.blend_method = 'OPAQUE'
    return mat


def make_linear_flat_material(name: str, linear: tuple[float, float, float]) -> bpy.types.Material:
    """Flat material from an already-linear colour (a measured texture mean)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*linear, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.9
    return mat


def make_texture_material(name: str, image: bpy.types.Image, cutout: bool) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.image.colorspace_settings.name = 'sRGB'
    links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.9
    if cutout:
        # The glTF exporter only emits cutout alpha when the BSDF Alpha input is
        # driven (same image's alpha channel); the runtime forces transparent=
        # false + alphaTest >= 0.05, so any exported alpha mode behaves as a
        # hard cutout in-engine.
        links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
        mat.blend_method = 'CLIP'
        mat.alpha_threshold = 0.05
        # Marks geometry whose silhouette lives in the alpha channel, so the LOD
        # step thins whole cards instead of collapsing their corners together.
        mat['is_card_role'] = True
    else:
        mat.blend_method = 'OPAQUE'
    return mat


_TILE_CACHE_DIR = tempfile.mkdtemp(prefix='bk_tree_tiles_')

# A tile bake writes only where the role's uv islands land, and a legitimate
# island can be small: every needle card on the Scots pine samples the same 1.5%
# of its sprite sheet, and those texels are the only ones the runtime ever reads.
# So this threshold detects a bake that wrote essentially NOTHING — degenerate or
# zeroed coordinates — not merely a compact layout.
MIN_TILE_LIT_FRACTION = 0.002


class LinearFlat(tuple):
    """A measured flat linear RGB colour standing in for an unbakeable tile."""
    __slots__ = ()


def _packed_srgb_image(name: str, width: int, height: int, rgba: 'np.ndarray') -> bpy.types.Image:
    """Materialise an in-memory RGBA buffer as a packed sRGB image.

    `pack()` on a freshly generated image does NOT encode the buffer that was just
    written through `pixels`: the glTF exporter then embeds an empty (black,
    fully opaque) PNG. That is the bug behind the golden larch's missing canopy.
    Writing the image out once forces a real encode, and packing from that file
    is what ends up inside the GLB.
    """
    image = bpy.data.images.new(name, width, height, alpha=True, float_buffer=False)
    # Colour space and alpha mode FIRST: changing either reloads a generated
    # image's buffer, which silently discards pixels written before the change.
    image.colorspace_settings.name = 'sRGB'
    image.alpha_mode = 'STRAIGHT'
    image.pixels.foreach_set(np.clip(rgba, 0.0, 1.0).ravel().astype(np.float32))
    image.update()
    image.file_format = 'PNG'
    # The encoded file must outlive pack(): the exporter reads the packed data
    # lazily, so deleting it here yields an empty texture in the GLB.
    image.filepath_raw = str(Path(_TILE_CACHE_DIR) / f'{name}.png')
    image.save()
    image.pack()
    return image


def _is_colour_image(image: bpy.types.Image | None) -> bool:
    """Reject the non-colour maps that sit beside every PBR base colour.

    A displacement or roughness map is an image node like any other, and picking
    one up as "the base colour" silently turns a role grey — `pine_bark_disp`
    has a mean of 0.646 in all three channels.
    """
    return image is not None and image.colorspace_settings.name == 'sRGB'


def _base_color_image(mat: bpy.types.Material) -> bpy.types.Image | None:
    """The colour image feeding a Principled Base Color, through any node chain."""
    if not mat.use_nodes:
        return None
    for node in mat.node_tree.nodes:
        if node.type != 'BSDF_PRINCIPLED':
            continue
        socket = node.inputs.get('Base Color')
        if socket is None or not socket.is_linked:
            continue
        # Breadth-first upstream: BlenderKit routes base colour through mix,
        # ramp and hue nodes, so the image is rarely one hop away.
        queue = [socket.links[0].from_node]
        seen = set()
        while queue:
            upstream = queue.pop(0)
            if upstream in seen:
                continue
            seen.add(upstream)
            if upstream.type == 'TEX_IMAGE' and _is_colour_image(upstream.image):
                return upstream.image
            for candidate in upstream.inputs:
                if candidate.is_linked:
                    queue.append(candidate.links[0].from_node)
    for node in mat.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and _is_colour_image(node.image):
            return node.image
    return None


def _wrap_uvs_for_tile_bake(obj: bpy.types.Object) -> str:
    """Add a fract()-wrapped copy of the active uv layer and make it authoritative.

    Baking writes into the ACTIVE uv layout, and the material samples the
    ACTIVE RENDER layer. Wrapping both into 0..1 makes one bake produce the
    material's single tile while every surface sample still lands on the texel it
    would have sampled through the source (REPEAT) coordinates.
    """
    me = obj.data
    src = me.uv_layers.active
    if src is None:
        raise SystemExit(f'{obj.name!r} has no uv layer to bake against')
    buf = np.empty(len(src.data) * 2, dtype=np.float32)
    src.data.foreach_get('uv', buf)
    wrapped = me.uv_layers.new(name='tile_bake')
    # fract() with a nudge off the exact seam: a value of exactly 1.0 wraps to 0.0
    # and would fold the tile's last texel column onto its first.
    wrapped.data.foreach_set('uv', np.clip(buf - np.floor(buf), 0.0, 0.999999).ravel())
    me.uv_layers.active = wrapped
    wrapped.active_render = True
    return src.name


def _restore_uvs(obj: bpy.types.Object, original: str) -> None:
    me = obj.data
    me.uv_layers.active = me.uv_layers[original]
    me.uv_layers[original].active_render = True
    me.uv_layers.remove(me.uv_layers['tile_bake'])


def bake_material_tile(obj: bpy.types.Object, mat: bpy.types.Material, samples: int = 8) -> bpy.types.Image:
    """Bake a role's evaluated node graph into one 0..1 UV tile.

    BlenderKit foliage materials do NOT put their final colour in the base-colour
    image. The grand fir's needles are a tan `fir_needles.png` (opaque mean RGB
    0.368/0.352/0.231) whose green comes from a Hue/Saturation node feeding a
    Translucent BSDF added to the Principled lobe. Wiring the raw image into Base
    Color therefore ships a pink-grey tree; baking the evaluated graph does not.

    The bake runs on the REAL role mesh, not a proxy plane: these graphs mix
    shaders using Generated/Object coordinates, which only exist on the authored
    geometry — a plane silently bakes the wrong branch of the mix.

    The result is the material's TILE, so the runtime keeps the mesh's own (often
    heavily tiled) UVs and samples it with REPEAT wrapping. That preserves the
    authored texel density which a whole-tree atlas bake destroys.

    Alpha comes from the base-colour image's own channel — the authored card
    cutout — because a colour bake writes light response, not card shape.
    """
    source = _base_color_image(mat)
    size = max(64, min(2048, int(source.size[0]) if source is not None else 512))

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
    scene.cycles.device = 'CPU'

    target = bpy.data.images.new(f'{mat.name}_tile', size, size, alpha=True)
    target.pixels.foreach_set(np.zeros(size * size * 4, dtype=np.float32))
    nodes = []
    for slot in obj.material_slots:
        if slot.material is None or not slot.material.use_nodes:
            continue
        node = slot.material.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = target
        slot.material.node_tree.nodes.active = node
        nodes.append((slot.material, node))
    original_uv = _wrap_uvs_for_tile_bake(obj)
    try:
        for other in bpy.context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=2)
    finally:
        for material, node in nodes:
            material.node_tree.nodes.remove(node)
        _restore_uvs(obj, original_uv)

    buf = np.empty(size * size * 4, dtype=np.float32)
    target.pixels.foreach_get(buf)
    rgba = buf.reshape(size, size, 4)
    if source is not None:
        sw, sh = source.size
        src = np.empty(sw * sh * 4, dtype=np.float32)
        source.pixels.foreach_get(src)
        alpha = src.reshape(sh, sw, 4)[:, :, 3]
        if (sh, sw) != (size, size):
            ys = (np.arange(size) * sh // size).clip(0, sh - 1)
            xs = (np.arange(size) * sw // size).clip(0, sw - 1)
            alpha = alpha[ys][:, xs]
        rgba[:, :, 3] = alpha
    else:
        rgba[:, :, 3] = 1.0

    # A cutout card legitimately bakes black outside its authored coverage, so the
    # health check looks only at the texels the runtime will actually keep.
    kept = rgba[:, :, 3] > 0.5
    lit = rgba[:, :, :3].max(axis=2) > 0.004
    # Judge colour only where the bake actually wrote AND the cutout keeps the
    # texel. Averaging over the whole authored coverage would read a compact uv
    # island as "black", because most of its tile is never written or sampled.
    health = lit & kept
    if not health.any():
        health = lit if lit.any() else kept
    visible = rgba[:, :, :3][health] if health.any() else rgba[:, :, :3].reshape(-1, 3)
    mean = [round(float(v), 4) for v in visible.mean(axis=0)]
    print(f'[tile] {mat.name}: {size}x{size} opaque={float(kept.mean()) * 100:.1f}% '
          f'lit={float(lit.mean()) * 100:.1f}% visible_mean_rgb={mean}')

    if float(lit.mean()) < MIN_TILE_LIT_FRACTION:
        # Some roles are sub-pixel woody detail (the twig inside a needle spray)
        # whose uv island is a sliver of its shared bark texture. Baking that
        # island produces a mostly-unwritten tile, and shipping it would make
        # those twigs render black. Fall back to the source texture's own mean —
        # an honest flat colour for geometry that is never seen at texel scale.
        fallback = [0.5, 0.4, 0.3]
        if source is not None:
            sw, sh = source.size
            src = np.empty(sw * sh * 4, dtype=np.float32)
            source.pixels.foreach_get(src)
            texels = src.reshape(-1, 4)
            opaque = texels[texels[:, 3] > 0.5]
            fallback = list((opaque if len(opaque) else texels)[:, :3].mean(axis=0))
        cutout = float(kept.mean()) < 0.99
        print(f'[tile] {mat.name}: bake wrote nothing '
              f'({float(lit.mean()) * 100:.2f}% lit) — flat '
              f'{"cutout " if cutout else ""}fallback '
              f'{[round(float(v), 4) for v in fallback]}')
        if not cutout:
            return LinearFlat(tuple(float(v) for v in fallback))
        # A card role must keep its authored cutout even when the colour bake
        # fails: an opaque flat material would turn the canopy into solid quads.
        flat = np.empty_like(rgba)
        flat[:, :, 0], flat[:, :, 1], flat[:, :, 2] = fallback
        flat[:, :, 3] = rgba[:, :, 3]
        flat_tile = _packed_srgb_image(f'{mat.name}_flat_cutout', size, size, flat)
        flat_tile['has_cutout'] = True
        return flat_tile

    if max(mean) < 0.02:
        raise SystemExit(f'[tile] {mat.name}: bake is black inside the authored coverage ({mean})')

    baked = _packed_srgb_image(f'{mat.name}_baked', size, size, rgba)
    # Whether this role's silhouette lives in its alpha channel. A bark tile is
    # fully opaque and must never be treated as a card: thinning it by islands
    # deletes the trunk outright.
    baked['has_cutout'] = bool(float(kept.mean()) < 0.99)
    return baked


def _dilate_alpha(a: 'np.ndarray', iterations: int) -> 'np.ndarray':
    """Cross max-pool dilation, `iterations` times (edge-clamped)."""
    for _ in range(iterations):
        a_up = np.vstack([a[0:1], a[0:-1]])
        a_dn = np.vstack([a[1:], a[-1:]])
        a_lf = np.hstack([a[:, 0:1], a[:, 0:-1]])
        a_rt = np.hstack([a[:, 1:], a[:, -1:]])
        a = np.maximum.reduce([a_up, a_dn, a_lf, a_rt, a])
    return a


def make_gold_alpha_image() -> bpy.types.Image:
    """Flat golden RGB + the source needle alpha (larch foliage).

    The source mask is ~21% coverage with a soft BLEND material. The engine's
    tree path is hard-cutout only (no transparency), so dilate the needle
    strokes until the canopy reads as a dense golden mass from distance.
    """
    src = next(i for i in bpy.data.images if i.name == 'color map.002')
    w, h = src.size
    px = np.empty(w * h * 4, dtype=np.float32)
    src.pixels.foreach_get(px)
    px4 = px.reshape(h, w, 4)
    a = _dilate_alpha(px4[:, :, 3].copy(), 3)
    gold = (0.787, 0.659, 0.223)
    out = np.empty_like(px4)
    out[:, :, 0] = gold[0]
    out[:, :, 1] = gold[1]
    out[:, :, 2] = gold[2]
    out[:, :, 3] = a
    return _packed_srgb_image('golden_larch_alpha', w, h, out)


def build_role_material(run_name: str, style: str, source_material: str = '',
                        obj: bpy.types.Object | None = None) -> bpy.types.Material:
    if style.startswith('flat:'):
        srgb = tuple(float(v) for v in style[6:-1].split(','))
        return make_flat_material(run_name, srgb)
    if style == 'bake':
        # Preferred style for any textured role: the authored node graph decides
        # the colour, not whichever image happens to be wired to Base Color.
        source = bpy.data.materials.get(source_material)
        if source is None or obj is None:
            raise SystemExit(f'bake style needs source material {source_material!r} and its role object')
        tile = bake_material_tile(obj, source)
        if isinstance(tile, LinearFlat):
            return make_linear_flat_material(run_name, tile)
        return make_texture_material(run_name, tile, cutout=bool(tile.get('has_cutout', True)))
    if style.startswith('keep:'):
        image = next(i for i in bpy.data.images if i.name == style[5:])
        image.pack()
        return make_texture_material(run_name, image, cutout=True)
    if style == 'gold_alpha':
        return make_texture_material(run_name, make_gold_alpha_image(), cutout=True)
    if style in FLAT:
        return make_flat_material(run_name, FLAT[style])
    raise SystemExit(f'unknown style {style!r}')


UV_LAYER = 'UVMap'


def _unify_uv_layer_name(obj: bpy.types.Object) -> None:
    """Rename the active uv layer so a later join merges layouts, not layers.

    Blender merges uv layers BY NAME. The realized needle sprays and the trunk
    arrive with differently named layers, so joining them leaves the needle faces
    holding all-zero coordinates in the trunk's layer — every needle then samples
    one texel, the tile bake writes nothing, and the role silently degrades to a
    flat colour with no cutout.
    """
    layers = obj.data.uv_layers
    if not layers:
        return
    active = layers.active
    if active.name != UV_LAYER:
        # Rename a colliding layer aside rather than removing it. bpy hands out a
        # fresh wrapper per access, so an `is not active` identity test matches the
        # active layer itself and deletes the very layout being unified — which is
        # how the Scots pine trunk arrived at the join with zeroed coordinates.
        collision = layers.get(UV_LAYER)
        if collision is not None:
            collision.name = f'{UV_LAYER}_unused'
        active.name = UV_LAYER
    layers.active = layers[UV_LAYER]
    layers[UV_LAYER].active_render = True


def realize_instances(cfg: dict, lod: int) -> None:
    """Turn a geometry-nodes needle scatter into real geometry, thinned to budget.

    The BlenderKit pines carry their entire canopy as GN instances: the mesh is a
    bare 0.9M-triangle trunk and the needles exist only in the depsgraph. Neither
    `modifier_apply` nor `convert(target='MESH')` realizes them, so a naive build
    silently exports a dead-looking stem. `duplicates_make_real` does realize
    them — into 14k objects and 3.2M triangles for the Scots pine.

    Card geometry cannot be decimated: collapsing a needle quad destroys the very
    shape its alpha depends on. Canopy density is therefore reduced by dropping
    WHOLE instances, seeded so a rebuild reproduces the same tree, while each
    surviving spray keeps its authored topology.
    """
    spec = cfg['realize']
    parent = bpy.data.objects[spec['parent']]
    before = set(bpy.data.objects)
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    parent.select_set(True)
    bpy.context.view_layer.objects.active = parent
    bpy.ops.object.duplicates_make_real(use_base_parent=False, use_hierarchy=False)

    realized: dict[str, list[bpy.types.Object]] = {}
    for obj in bpy.data.objects:
        if obj in before or obj.type != 'MESH':
            continue
        realized.setdefault(obj.name.rsplit('.', 1)[0], []).append(obj)

    for source, objects in sorted(realized.items()):
        budget = spec['instances'].get(source, {}).get(lod, 0)
        objects.sort(key=lambda o: o.name)
        keep: list[bpy.types.Object] = []
        if budget > 0:
            rng = random.Random(f'{spec["parent"]}:{source}:{lod}')
            keep = objects if budget >= len(objects) else rng.sample(objects, budget)
        drop = [obj for obj in objects if obj not in set(keep)]
        print(f'[realize] {source}: {len(objects)} instances -> keeping {len(keep)}')
        for obj in drop:
            bpy.data.objects.remove(obj, do_unlink=True)
        if not keep:
            continue
        for obj in bpy.context.selected_objects:
            obj.select_set(False)
        for obj in keep:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = keep[0]
        if len(keep) > 1:
            bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        joined.name = f'realized_{source}'
        _unify_uv_layer_name(joined)
        # No transform_apply here: realized instances share mesh datablocks, and
        # the later join onto the woody source already resolves each object's
        # matrix into the target's space.


def merge_into_source(cfg: dict) -> None:
    """Join every realized canopy object onto the woody source object.

    `split_roles` separates one multi-slot mesh by material, so the realized
    sprays have to become slots of that same mesh before the role split runs.
    """
    target = bpy.data.objects[cfg['object']]
    extra = [obj for obj in bpy.data.objects
             if obj.type == 'MESH' and obj.name.startswith('realized_')]
    if not extra:
        raise SystemExit('instance realization produced no canopy geometry')
    _unify_uv_layer_name(target)
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    for obj in [*extra, target]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()

    # Joining reshuffles uv layers and leaves an arbitrary one active. The role
    # split copies only the ACTIVE layer, so leaving the source's spare
    # `UVMapIslands` (coordinates up to 8117) in front of the real layout hands
    # every role garbage or zeroed coordinates. Keep exactly the merged layout.
    me = target.data
    # Only re-point active/active_render — do NOT remove the spare layers. The
    # role split reads whichever layer is active, so pointing at the merged
    # layout is enough, and removing uv layers from a million-polygon mesh
    # silently zeroes the survivor's coordinates.
    if UV_LAYER not in me.uv_layers:
        raise SystemExit(f'merged mesh lost its {UV_LAYER} layout')
    me.uv_layers.active = me.uv_layers[UV_LAYER]
    me.uv_layers[UV_LAYER].active_render = True


def split_roles(cfg: dict) -> dict[str, bpy.types.Object]:
    """Return role name -> object, each holding only that role's geometry."""
    role_objs: dict[str, bpy.types.Object] = {}

    if 'objects' in cfg:
        for obj_name, role in cfg['objects'].items():
            obj = bpy.data.objects[obj_name]
            for o in bpy.context.selected_objects:
                o.select_set(False)
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            obj.name = role
            role_objs[role] = obj
        return role_objs

    obj = bpy.data.objects[cfg['object']]
    # Delete dropped-material polygons first (ground patches etc.).
    for drop in cfg['drop']:
        try:
            di = slot_index_of(obj, drop)
        except SystemExit:
            continue
        chunk = separate_slot(obj, di)
        bpy.data.objects.remove(chunk, do_unlink=True)

    # Separate each role out of the remaining mesh.
    for role, (src_mat, run_name, _style) in cfg['roles'].items():
        si = slot_index_of(obj, src_mat)
        chunk = separate_slot(obj, si)
        chunk.name = role
        role_objs[role] = chunk

    # The leftover original holds nothing of ours; drop it.
    bpy.data.objects.remove(obj, do_unlink=True)
    return role_objs


def build_lod(asset_id: str, lod: int) -> dict:
    cfg = ASSETS[asset_id]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.open_mainfile(filepath=str(cfg['source']))

    if 'realize' in cfg:
        realize_instances(cfg, lod)
        merge_into_source(cfg)
    role_objs = split_roles(cfg)

    budget = cfg['tri_budget'][lod]
    tris_report: dict[str, int] = {}
    for role, obj in role_objs.items():
        src_mat, run_name, style = cfg['roles'][role]
        mat = build_role_material(run_name, style, src_mat, obj)
        card_role = mat.get('is_card_role', False)
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        # Card roles thin by dropping whole cards; solid roles (trunk, limbs) are
        # ordinary surfaces where collapse decimation is exactly right.
        tris_report[role] = (thin_cards_to(obj, budget[role], f'{asset_id}:{role}')
                             if card_role and budget[role] > 0
                             else decimate_to(obj, budget[role]))
        obj.name = run_name

    # Bounds over all role objects.
    minv = Vector((1e18, 1e18, 1e18))
    maxv = Vector((-1e18, -1e18, -1e18))
    for obj in role_objs.values():
        obj.update_tag()
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            minv.x = min(minv.x, w.x)
            minv.y = min(minv.y, w.y)
            minv.z = min(minv.z, w.z)
            maxv.x = max(maxv.x, w.x)
            maxv.y = max(maxv.y, w.y)
            maxv.z = max(maxv.z, w.z)

    for o in bpy.context.selected_objects:
        o.select_set(False)
    for obj in role_objs.values():
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(role_objs.values()))

    out = DEST / f'{asset_id}_lod{lod}.glb'
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        use_selection=True,
        export_format='GLB',
        export_apply=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
        export_extras=False,
        export_yup=True,
    )
    return {
        'lod': lod,
        'file': str(out.relative_to(ROOT)),
        'sha256': hashlib.sha256(out.read_bytes()).hexdigest(),
        'bytes': out.stat().st_size,
        'tris': tris_report,
        'width': round(maxv.x - minv.x, 3),
        'height': round(maxv.z - minv.z, 3),
        'depth': round(maxv.y - minv.y, 3),
        'baseY': round(minv.z, 3),
        'topY': round(maxv.z, 3),
    }


def main() -> None:
    asset_id = parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    lods = [build_lod(asset_id, 0), build_lod(asset_id, 1)]
    report = {asset_id: lods}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    existing = json.loads(REPORT.read_text()) if REPORT.exists() else {}
    existing.update(report)
    REPORT.write_text(json.dumps(existing, indent=1) + '\n')
    print(f'===BUILD=== {asset_id}')
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
