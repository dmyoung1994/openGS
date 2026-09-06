#!/usr/bin/env python3
"""Promote one exact Poly Haven Pine Sapling Small variant to runtime GLB.

The source package stores twig opacity as a sidecar image that is not referenced
by the glTF. This script combines the source diffuse RGB and source alpha into a
lossless RGBA PNG, patches only that image URI in a temporary glTF, and asks
Blender to export one complete authored variant. Geometry, indices, normals,
UVs, vertex colours, materials, and PBR maps are otherwise left intact.
"""

from __future__ import annotations

import argparse
from array import array
import json
import pathlib
import subprocess
import sys


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--variant", choices=("a", "b", "c"), default="a")
    parser.add_argument("--target-faces", type=int)
    parser.add_argument("--blender-stage", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)


def outer(args: argparse.Namespace) -> None:
    from PIL import Image

    source = pathlib.Path(args.input).resolve()
    root = source.parent
    patched = root / ".pine_sapling_small_runtime.gltf"
    rgba_path = root / "textures/.pine_sapling_small_twig_diff_alpha_1k.png"
    document = json.loads(source.read_text(encoding="utf-8"))
    diffuse = Image.open(root / "textures/pine_sapling_small_twig_diff_1k.jpg").convert("RGB")
    alpha = Image.open(root / "textures/pine_sapling_small_twig_alpha_1k.png").convert("L")
    if diffuse.size != alpha.size:
        raise ValueError(f"twig diffuse/alpha dimensions differ: {diffuse.size} vs {alpha.size}")
    diffuse.putalpha(alpha)
    diffuse.save(rgba_path, format="PNG", optimize=True)
    twig_image = next(image for image in document["images"] if image.get("name") == "pine_sapling_small_twig_diff")
    twig_image["uri"] = "textures/.pine_sapling_small_twig_diff_alpha_1k.png"
    twig_image["mimeType"] = "image/png"
    patched.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    blender = pathlib.Path("/Applications/Blender.app/Contents/MacOS/Blender")
    try:
        subprocess.run([
            str(blender), "--background", "--python", str(pathlib.Path(__file__).resolve()), "--",
            "--blender-stage", "--input", str(patched), "--output", str(output), "--variant", args.variant,
            *(["--target-faces", str(args.target_faces)] if args.target_faces else []),
        ], check=True)
    finally:
        patched.unlink(missing_ok=True)
        rgba_path.unlink(missing_ok=True)


def blender_stage(args: argparse.Namespace) -> None:
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(pathlib.Path(args.input).resolve()))
    suffix = f"_{args.variant}"
    keep = []
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and (obj.name.endswith(suffix) or obj.data.name.endswith(suffix)):
            keep.append(obj)
    if not keep:
        raise RuntimeError(f"source variant {args.variant} did not import as a mesh")
    if len(keep) != 1:
        raise RuntimeError(f"source variant {args.variant} imported as {len(keep)} meshes")
    if args.target_faces:
        tree = keep[0]
        bpy.context.view_layer.objects.active = tree
        tree.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")
        parts = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.startswith(tree.name)]
        twig = next(obj for obj in parts if "twig" in obj.data.materials[0].name)
        _retain_components(twig, args.target_faces)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in parts:
            obj.select_set(True)
        bark = next(obj for obj in parts if "bark" in obj.data.materials[0].name)
        bpy.context.view_layer.objects.active = bark
        bpy.ops.object.join()
        keep = [bark]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in keep:
        obj.select_set(True)
        obj["sourceAsset"] = "polyhaven-pine-sapling-small"
        obj["sourceVariant"] = args.variant
        obj["productionDerivative"] = True
        obj["pipelineVersion"] = "polyhaven-pine-sapling-small-whole-component-lods@1" if args.target_faces else "polyhaven-pine-sapling-small-exact-variant@1"
    bpy.context.view_layer.objects.active = keep[0]
    bpy.ops.export_scene.gltf(
        filepath=str(pathlib.Path(args.output).resolve()),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_vertex_color="ACTIVE",
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_animations=False,
        export_extras=True,
    )


def _root(parent: array, value: int) -> int:
    while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
    return value


def _retain_components(obj, target: int) -> None:
    import bpy

    mesh = obj.data
    parent = array("I", range(len(mesh.vertices)))
    for edge in mesh.edges:
        left, right = _root(parent, edge.vertices[0]), _root(parent, edge.vertices[1])
        if left != right:
            parent[max(left, right)] = min(left, right)
    counts = {}
    for polygon in mesh.polygons:
        component = _root(parent, polygon.vertices[0])
        counts[component] = counts.get(component, 0) + 1

    def rank(component: int) -> int:
        value = (component ^ 0x51A11E) & 0xFFFFFFFF
        value ^= value >> 16
        value = (value * 0x7FEB352D) & 0xFFFFFFFF
        value ^= value >> 15
        value = (value * 0x846CA68B) & 0xFFFFFFFF
        return value ^ (value >> 16)

    retained, faces = set(), 0
    for component, count in sorted(counts.items(), key=lambda item: rank(item[0])):
        retained.add(component)
        faces += count
        if faces >= target:
            break
    for polygon in mesh.polygons:
        polygon.select = _root(parent, polygon.vertices[0]) not in retained
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="FACE")
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"PINE_SAPLING_COMPONENT_LOD components={len(counts)} retained={len(retained)} faces={len(mesh.polygons)}")


if __name__ == "__main__":
    parsed = arguments()
    blender_stage(parsed) if parsed.blender_stage else outer(parsed)
