"""Bake a deterministic multi-angle, lighting-neutral tree albedo atlas.

Usage:
  blender --background --python scripts/bake_tree_impostor.py -- \
    --input /path/tree.gltf --output /path/tree_impostor.png --frames 8 --size 512

The bake is an offline authoring step. Runtime never substitutes procedural geometry:
the atlas silhouette, alpha, and base color come from the licensed source asset, while
sun/sky lighting is intentionally applied at runtime. Camera azimuth frames are packed
left-to-right, then top-to-bottom.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

# Must track TREE_ALPHA_CUTOFF in src/scene/Trees.js: the card has to be baked
# from the same coverage the runtime geometry renders.
TREE_ALPHA_CUTOFF = 0.05


def arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--exclude-material", action="append", default=[],
                        help="drop every primitive using this material from the card bake")
    args = parser.parse_args(argv)
    if args.frames < 4 or args.frames > 32:
        parser.error("--frames must be in [4, 32]")
    if args.size < 128 or args.size > 2048:
        parser.error("--size must be in [128, 2048]")
    return args


def scene_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            minimum.x = min(minimum.x, world.x)
            minimum.y = min(minimum.y, world.y)
            minimum.z = min(minimum.z, world.z)
            maximum.x = max(maximum.x, world.x)
            maximum.y = max(maximum.y, world.y)
            maximum.z = max(maximum.z, world.z)
    if not all(math.isfinite(v) for v in (*minimum, *maximum)):
        raise RuntimeError("Imported tree has no finite mesh bounds")
    return minimum, maximum


def point_camera(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def configure_scene(size: int) -> bpy.types.Scene:
    scene = bpy.context.scene
    # Blender 5.2 exposes the Eevee Next renderer under the historical enum.
    # Pin the exact enum instead of probing alternatives: the authoring pipeline
    # must fail closed if the required renderer is unavailable.
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1

    world = bpy.data.worlds.new("Tree impostor neutral world")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0, 0, 0, 1)
    background.inputs["Strength"].default_value = 0
    scene.world = world
    return scene


def drop_excluded_roles(meshes: list[bpy.types.Object], excluded: list[str]) -> list[bpy.types.Object]:
    """Remove whole role primitives from the card bake.

    A role-split conifer carries a full branch skeleton. Up close the needle cards
    overlap and hide it, but at card resolution those continuous twig lines
    out-cover the thin needles, and the baked albedo comes out bark-brown while the
    geometry it replaces is dark green — a colour pop at the LOD handoff. Dropping
    the branch role from the card keeps the far crown a needle mass, which is what
    a conifer actually reads as at that distance.
    """
    if not excluded:
        return meshes
    wanted = set(excluded)
    kept = []
    for obj in meshes:
        names = {material.name for material in obj.data.materials if material is not None}
        if names & wanted:
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        kept.append(obj)
    if not kept:
        raise SystemExit(f"--exclude-material {sorted(wanted)} removed every mesh")
    return kept


def make_materials_lighting_neutral(meshes: list[bpy.types.Object]) -> None:
    """Route source base color/alpha through emission so no bake light remains."""
    processed: set[bpy.types.Material] = set()
    for obj in meshes:
        for material in obj.data.materials:
            if material is None or material in processed:
                continue
            processed.add(material)
            material.use_nodes = True
            nodes = material.node_tree.nodes
            links = material.node_tree.links
            output = next((node for node in nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output), None)
            principled = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
            if output is None or principled is None:
                raise RuntimeError(f"Material {material.name!r} has no active glTF Principled output")

            base = principled.inputs.get("Base Color")
            alpha = principled.inputs.get("Alpha")
            emission = nodes.new("ShaderNodeEmission")
            emission.name = "Runtime-lit impostor neutral albedo"
            emission.inputs["Strength"].default_value = 1.0
            if base.is_linked:
                links.new(base.links[0].from_socket, emission.inputs["Color"])
            else:
                emission.inputs["Color"].default_value = base.default_value

            transparent = nodes.new("ShaderNodeBsdfTransparent")
            mix_shader = nodes.new("ShaderNodeMixShader")
            links.new(transparent.outputs["BSDF"], mix_shader.inputs[1])
            links.new(emission.outputs["Emission"], mix_shader.inputs[2])
            if alpha is not None and alpha.is_linked:
                # The runtime draws foliage as a hard alpha-tested cutout, never
                # blended. Baking a soft alpha instead lets every semi-transparent
                # needle edge composite over the pale bark behind it, so the card
                # comes out washed-out brown while the geometry stays dark green —
                # a visible colour pop at the LOD handoff. Threshold to match.
                cutoff = nodes.new("ShaderNodeMath")
                cutoff.operation = "GREATER_THAN"
                cutoff.inputs[1].default_value = TREE_ALPHA_CUTOFF
                links.new(alpha.links[0].from_socket, cutoff.inputs[0])
                links.new(cutoff.outputs["Value"], mix_shader.inputs[0])
            else:
                mix_shader.inputs[0].default_value = alpha.default_value if alpha is not None else 1.0

            for link in list(output.inputs["Surface"].links):
                links.remove(link)
            links.new(mix_shader.outputs["Shader"], output.inputs["Surface"])


def pack_atlas(paths: list[Path], output: Path, frame_size: int) -> tuple[int, int]:
    columns = math.ceil(math.sqrt(len(paths) * 2))
    rows = math.ceil(len(paths) / columns)
    atlas = bpy.data.images.new(
        "Tree impostor atlas",
        width=columns * frame_size,
        height=rows * frame_size,
        alpha=True,
        float_buffer=False,
    )
    atlas_pixels = [0.0] * (atlas.size[0] * atlas.size[1] * 4)
    for index, path in enumerate(paths):
        image = bpy.data.images.load(str(path), check_existing=False)
        pixels = list(image.pixels)
        # Replicate edge texels into a deliberate interior gutter. Ordinary
        # filtered mips otherwise pull transparent black from the neighboring
        # frame into thin needles, causing dark halos and coverage loss.
        gutter = max(2, frame_size // 64)
        for y in range(frame_size):
            for x in range(gutter):
                left = (y * frame_size + gutter) * 4
                right = (y * frame_size + frame_size - gutter - 1) * 4
                pixels[(y * frame_size + x) * 4 : (y * frame_size + x + 1) * 4] = pixels[left : left + 4]
                pixels[(y * frame_size + frame_size - x - 1) * 4 : (y * frame_size + frame_size - x) * 4] = pixels[right : right + 4]
        for x in range(frame_size):
            for y in range(gutter):
                top = ((gutter * frame_size + x) * 4)
                bottom = (((frame_size - gutter - 1) * frame_size + x) * 4)
                pixels[(y * frame_size + x) * 4 : (y * frame_size + x + 1) * 4] = pixels[top : top + 4]
                yy = frame_size - y - 1
                pixels[(yy * frame_size + x) * 4 : (yy * frame_size + x + 1) * 4] = pixels[bottom : bottom + 4]
        column = index % columns
        # Blender image pixel origin is bottom-left. Store logical row zero at the
        # top of the PNG so WebGPU UV selection is conventional.
        logical_row = index // columns
        row = rows - 1 - logical_row
        for y in range(frame_size):
            source = y * frame_size * 4
            destination = ((row * frame_size + y) * atlas.size[0] + column * frame_size) * 4
            atlas_pixels[destination : destination + frame_size * 4] = pixels[source : source + frame_size * 4]
        bpy.data.images.remove(image)
    atlas.pixels.foreach_set(atlas_pixels)
    atlas.filepath_raw = str(output)
    atlas.file_format = "PNG"
    atlas.save()
    bpy.data.images.remove(atlas)
    return columns, rows


def main() -> None:
    args = arguments()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    output.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = configure_scene(args.size)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    meshes = drop_excluded_roles(meshes, args.exclude_material)
    make_materials_lighting_neutral(meshes)
    minimum, maximum = scene_bounds(meshes)
    centre = (minimum + maximum) * 0.5
    extent = max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z)

    camera_data = bpy.data.cameras.new("Tree impostor camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = extent * 1.12
    camera_data.lens = 50
    camera = bpy.data.objects.new("Tree impostor camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    temporary_paths: list[Path] = []
    radius = extent * 2.4
    for frame in range(args.frames):
        angle = frame / args.frames * math.tau
        # Blender imports glTF's Y-up tree as Z-up. Orbit in Blender's XY plane;
        # orbiting around Y would accidentally bake overhead views.
        camera.location = centre + Vector((math.sin(angle) * radius, math.cos(angle) * radius, extent * 0.06))
        point_camera(camera, centre)
        path = output.parent / f".{output.stem}-frame-{frame:02d}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        temporary_paths.append(path)

    columns, rows = pack_atlas(temporary_paths, output, args.size)
    for path in temporary_paths:
        path.unlink(missing_ok=True)
    metadata = {
        "schemaVersion": 2,
        "source": source.name,
        "representation": "lighting-neutral-srgb-albedo-alpha",
        "runtimeLightingRequired": True,
        "frames": args.frames,
        "columns": columns,
        "rows": rows,
        "frameSize": args.size,
        "gutterPixels": max(2, args.size // 64),
        "azimuthConvention": "frame i = i / frames * 2pi, camera clockwise around glTF +Y",
        "bakeUpAxis": "+Z",
        "boundsMin": list(minimum),
        "boundsMax": list(maximum),
    }
    output.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
