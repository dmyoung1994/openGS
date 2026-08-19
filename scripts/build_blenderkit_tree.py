"""Build a production one-part canonical tree GLB pair from a BlenderKit .blend.

The engine's production tree path (src/scene/Trees.js) enforces a one-part
canonical prototype: ONE mesh, ONE material, named so that
_isAuthoredAlphaAtlas() matches (<prefix>_authored_alpha_atlas). Multi-part
multi-material GLBs are rejected by TreeBeautyLod.

BlenderKit assets ship 5–8 node-graph materials over high-poly meshes, so this
build flattens everything into one baked diffuse atlas:

  1. drop excluded faces (ground discs), apply every modifier, join to one mesh,
  2. decimate to LOD0 FIRST (the bake runs at LOD0 detail; the impostor bake
     uses LOD0 anyway),
  3. normalise the source uv layer into 0..1 per axis and wrap every default-uv
     texture input with the inverse mapping, so the shader still samples the
     source coordinates while the bake writes the whole mesh (BlenderKit needle
     textures tile ~50x, so the raw layout spans several uv units and a plain
     bake would only write the 0..1 slice),
  4. bake the DIFFUSE colour of ALL original materials into one RECTANGULAR
     atlas whose aspect matches the normalised layout — a repack via
     smart_uv_project is deliberately avoided: on these scan meshes the op
     zeroes python-written uv layers and Cycles then bakes nothing,
  5. replace every slot with one <prefix>_authored_alpha_atlas material,
  6. decimate LOD0 -> LOD1 (uvs inherited) and export both GLBs — identical
     one-part contract for assertCompatibleTreeLods.

Usage (the .blend must be the main file):
  Blender --background <asset.blend> --python scripts/build_blenderkit_tree.py -- \
    --prefix grand_fir --out-dir public/assets/trees \
    --lod0-tris 130000 --lod1-tris 24000 --atlas 2048 [--exclude-material ground]

Then bake the impostor in a second invocation:
  Blender --background --python scripts/bake_tree_impostor.py -- \
    --input <out-dir>/<prefix>_lod0.glb --output <out-dir>/<prefix>_impostor.png \
    --frames 8 --size 512
"""
from __future__ import annotations

import argparse
import hashlib
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


def arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, help="asset stem, e.g. grand_fir")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--lod0-tris", type=int, default=130000)
    parser.add_argument("--lod1-tris", type=int, default=24000)
    parser.add_argument("--atlas-height", type=int, default=4096,
                        help="atlas height; width follows the uv layout aspect")
    parser.add_argument("--exclude-material", action="append", default=[],
                        help="drop faces using this material (ground discs)")
    parser.add_argument("--samples", type=int, default=8, help="bake samples (colour pass)")
    args = parser.parse_args(argv)
    if args.lod1_tris >= args.lod0_tris:
        parser.error("--lod1-tris must be below --lod0-tris")
    if not (256 <= args.atlas_height <= 8192):
        parser.error("--atlas-height must be in [256, 8192]")
    return args


def prepare_geometry(exclude: list[str]) -> bpy.types.Object:
    """Drop excluded faces, apply every modifier, join into one mesh at Z=0."""
    excluded = set(exclude)
    for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            # Every modifier (weighted normals, subsurf, GN needle instancing,
            # decimate) is evaluated into real geometry: the engine needs plain
            # indexed meshes, and the GLB must not carry a live stack.
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError as e:
                raise SystemExit(f"cannot apply modifier {mod.name} on {obj.name}: {e}")

    for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
        mats = obj.data.materials
        doomed = [p for p in obj.data.polygons
                  if p.material_index < len(mats) and mats[p.material_index] is not None
                  and mats[p.material_index].name in excluded]
        if doomed:
            for p in obj.data.polygons:
                p.select = False
            for p in doomed:
                p.select = True
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.delete(type="FACE")
            bpy.ops.object.mode_set(mode="OBJECT")
        if not obj.data.polygons:
            bpy.data.objects.remove(obj)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh objects left after exclusion")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = "tree"

    # Re-seat the base on Z=0 (the engine plants from the structural base).
    min_z = min((joined.matrix_world @ Vector(c)).z for c in joined.bound_box)
    joined.location.z -= min_z
    joined.location.x = 0.0
    joined.location.y = 0.0
    bpy.context.view_layer.update()
    return joined


def decimate(obj: bpy.types.Object, target_tris: int) -> None:
    cur_tris = sum(len(p.loop_indices) for p in obj.data.polygons) // 3
    ratio = min(1.0, target_tris / max(cur_tris, 1))
    if ratio < 1.0:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier="dec")
    obj.data.validate()
    obj.data.validate_material_indices()
    print(f"[decimate] {cur_tris} -> {sum(len(p.loop_indices) for p in obj.data.polygons) // 3} tris")


def set_cycles(samples: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.device = "CPU"


def active_object(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def new_image(name: str, width: int, height: int) -> bpy.types.Image:
    img = bpy.data.images.new(name, width, height, alpha=True)
    img.pixels.foreach_set(np.zeros(width * height * 4, dtype=np.float32))
    return img


def bypass_to_principled(mat: bpy.types.Material) -> bool:
    """Connect the primary Principled BSDF straight to the Output.

    BlenderKit mixes Principled + Transparent/Translucent through MIX_SHADER
    chains; the DIFFUSE colour pass then writes black wherever the mix goes
    transparent. For an albedo capture the mix must be bypassed.
    """
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if out is None or not out.inputs["Surface"].is_linked:
        return False
    node = out.inputs["Surface"].links[0].from_node
    for _ in range(12):
        if node.type == "BSDF_PRINCIPLED":
            nt.links.new(node.outputs["BSDF"], out.inputs["Surface"])
            return True
        if node.type == "MIX_SHADER" and node.inputs[1].is_linked:
            node = node.inputs[1].links[0].from_node
        else:
            return False
    return False


def bake_diffuse_color(obj: bpy.types.Object, target: bpy.types.Image, samples: int,
                       bypass_mixes: bool = False) -> int:
    """Bake the DIFFUSE colour of every material on obj into target.

    Returns the count of lit pixels so callers can fail closed on an empty bake.
    """
    temp_nodes = []
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.use_nodes:
            continue
        if bypass_mixes:
            bypass_to_principled(mat)
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = target
        mat.node_tree.nodes.active = node
        temp_nodes.append((mat, node))
    try:
        active_object(obj)
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=4)
    finally:
        for mat, node in temp_nodes:
            mat.node_tree.nodes.remove(node)
    buf = np.empty(target.size[0] * target.size[1] * 4, dtype=np.float32)
    target.pixels.foreach_get(buf)
    lit = int((buf.reshape(-1, 4)[:, :3].max(axis=1) > 0.01).sum())
    total = target.size[0] * target.size[1]
    print(f"[bake] {target.name}: {lit}/{total} lit ({100.0 * lit / total:.1f}%)")
    return lit


def smart_project(obj: bpy.types.Object) -> None:
    active_object(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.003)
    bpy.ops.object.mode_set(mode="OBJECT")


def normalize_uvs(obj: bpy.types.Object) -> tuple[np.ndarray, np.ndarray]:
    """Affinely map the active uv layer into [0,1]; return (min, range)."""
    me = obj.data
    layer = me.uv_layers.active
    n = len(layer.data)
    buf = np.empty(n * 2, dtype=np.float32)
    layer.data.foreach_get("uv", buf)
    buf = buf.reshape(-1, 2)
    mn = buf.min(axis=0)
    rng = np.maximum(buf.max(axis=0) - mn, 1e-6)
    layer.data.foreach_set("uv", ((buf - mn) / rng).ravel())
    return mn.astype(np.float32), rng.astype(np.float32)


def wrap_texture_coords(obj: bpy.types.Object, mn: np.ndarray, rng: np.ndarray) -> None:
    """Insert an inverse-mapping (uv01 -> raw source uv) before every default-uv
    texture input, so the normalised uv layer samples the source coordinates."""
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
            mapping.inputs["Scale"].default_value = (float(rng[0]), float(rng[1]), 1.0)
            coord = nt.nodes.new("ShaderNodeTexCoord")
            coord.location = (node.location.x - 600, node.location.y)
            nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
            nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])


def duplicate_uv_layer(obj: bpy.types.Object, src_name: str, new_name: str) -> None:
    me = obj.data
    src = me.uv_layers[src_name]
    new = me.uv_layers.new(name=new_name)
    n = len(src.data)
    buf = np.empty(n * 2, dtype=np.float32)
    src.data.foreach_get("uv", buf)
    new.data.foreach_set("uv", buf)
    # The new layer is active by default; the repack must happen on the SOURCE
    # layout, so hand activity back before smart_project runs.
    me.uv_layers.active = me.uv_layers[src_name]


def main() -> None:
    args = arguments()
    outdir = Path(args.out_dir)
    outdir.mkdir(parents=True, exist_ok=True)

    joined = prepare_geometry(args.exclude_material)
    lo0, hi0 = world_bounds(joined)
    print(f"[bounds] {tuple(round(v, 3) for v in lo0)} .. {tuple(round(v, 3) for v in hi0)}")

    # Decimate before unwrapping: smart_uv_project degenerates half of the faces
    # on the 1M-poly sources, and the repack bake runs at LOD0 detail anyway.
    decimate(joined, args.lod0_tris)

    set_cycles(args.samples)

    # Capture every source material's albedo in one bake. BlenderKit source uv
    # layouts routinely span several uv units (needle textures tiled ~50x), and
    # a bake only writes texels inside 0..1 — so normalise the uv layer into
    # 0..1 per axis and wrap each material's default-uv textures with the
    # inverse map. The shader then samples exactly the source coordinates while
    # the bake writes the whole mesh. The atlas is rectangular, matching the
    # layout's aspect, so no texels are wasted on empty square corners.
    mn, rng = normalize_uvs(joined)
    wrap_texture_coords(joined, mn, rng)
    aspect = float(rng[0]) / float(rng[1])
    atlas_w = max(128, min(2048, int(round(args.atlas_height * aspect))))
    atlas = new_image(f"{args.prefix}_atlas", atlas_w, args.atlas_height)
    lit = bake_diffuse_color(joined, atlas, args.samples, bypass_mixes=True)
    # Source layouts can be legitimately sparse (islands scattered over a wide
    # uv space); only abort on a genuinely empty bake.
    if lit < atlas_w * args.atlas_height * 0.02:
        raise SystemExit(f"[atlas] empty bake ({lit} lit pixels) — aborting")
    atlas.pack()
    print(f"[atlas] {atlas_w}x{args.atlas_height} (aspect {aspect:.2f} of source uv layout)")

    # Final one-part material: the engine's _isAuthoredAlphaAtlas() role.
    name = f"{args.prefix}_authored_alpha_atlas"
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Alpha"].default_value = 1.0
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = atlas
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    active_object(joined)
    # Every face must land on the one atlas slot, or the exporter splits the
    # mesh into one primitive per remaining material and the engine's
    # one-part canonical check rejects the GLB.
    joined.data.polygons.foreach_set(
        "material_index", np.zeros(len(joined.data.polygons), dtype=np.int32)
    )
    while len(joined.material_slots) > 1:
        joined.active_material_index = len(joined.material_slots) - 1
        bpy.ops.object.material_slot_remove()
    joined.material_slots[0].material = mat

    for tag, tris in (("lod0", None), ("lod1", args.lod1_tris)):
        if tris is not None:
            decimate(joined, tris)
        path = outdir / f"{args.prefix}_{tag}.glb"
        export_glb(joined, path)
        lo, hi = world_bounds(joined)
        tris_out = sum(len(p.vertices) - 2 for p in joined.data.polygons)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"[{tag}] {path} tris={tris_out} "
              f"height={round(hi.z - lo.z, 3)}m sha256={digest} bytes={path.stat().st_size}")

    print(f"[done] {args.prefix}: one-part canonical LOD0 + LOD1")
    print("[next] bake impostor: Blender --background --python scripts/bake_tree_impostor.py -- "
          f"--input {outdir / (args.prefix + '_lod0.glb')} "
          f"--output {outdir / (args.prefix + '_impostor.png')} --frames 8 --size 512")


def world_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    corners = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    active_object(obj)
    obj.data.update()
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
    )


if __name__ == "__main__":
    main()
