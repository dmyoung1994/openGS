#!/usr/bin/env python3
"""Build source-faithful Fir Sapling Medium runtime LODs.

The Poly Haven glTF stores twig RGB in JPEG and its authored opacity in a
sidecar PNG. This tool combines only those source channels, retains complete
connected twig-card components, and exports one authored source variant. It
does not decimate, reshape, billboard, atlas, or procedurally replace foliage.
"""

from __future__ import annotations

import argparse
from array import array
import json
import pathlib
import subprocess
import sys


PIPELINE_VERSION = "polyhaven-fir-sapling-medium-whole-component-lods@2"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--variant", choices=("a", "b", "c"), default="a")
    parser.add_argument("--target-faces", type=int, required=True)
    parser.add_argument("--blender-stage", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)


def outer(args: argparse.Namespace) -> None:
    from PIL import Image

    source = pathlib.Path(args.input).resolve()
    root = source.parent
    patched = root / ".fir_sapling_medium_runtime.gltf"
    rgba_path = root / "textures/.fir_sapling_medium_twigs_diff_alpha_1k.png"
    document = json.loads(source.read_text(encoding="utf-8"))
    diffuse = Image.open(root / "textures/fir_sapling_medium_twigs_diff_1k.jpg").convert("RGB")
    alpha = Image.open(root / "textures/fir_sapling_medium_twigs_alpha_1k.png").convert("L")
    if diffuse.size != alpha.size:
        raise ValueError(f"twig diffuse/alpha dimensions differ: {diffuse.size} vs {alpha.size}")
    diffuse.putalpha(alpha)
    diffuse.save(rgba_path, format="PNG", optimize=True)
    twig_image = next(image for image in document["images"]
                      if image.get("name", "").startswith("fir_sapling_medium_twigs_diff"))
    twig_image["uri"] = "textures/.fir_sapling_medium_twigs_diff_alpha_1k.png"
    twig_image["mimeType"] = "image/png"
    patched.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    blender = pathlib.Path("/Applications/Blender.app/Contents/MacOS/Blender")
    try:
        subprocess.run([
            str(blender), "--background", "--python", str(pathlib.Path(__file__).resolve()), "--",
            "--blender-stage", "--input", str(patched), "--output", str(output),
            "--variant", args.variant, "--target-faces", str(args.target_faces),
        ], check=True)
    finally:
        patched.unlink(missing_ok=True)
        rgba_path.unlink(missing_ok=True)


def blender_stage(args: argparse.Namespace) -> None:
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(pathlib.Path(args.input).resolve()))
    marker = f"_{args.variant}_LOD0"
    keep = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and marker in obj.name]
    if len(keep) != 1:
        raise RuntimeError(f"source variant {args.variant} imported as {len(keep)} meshes")
    tree = keep[0]
    # Variants B/C are arranged side-by-side in the source review scene. The
    # chosen tree is a playable prototype rooted at the origin.
    tree.location = (0, 0, 0)
    bpy.context.view_layer.objects.active = tree
    tree.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for obj in list(bpy.context.scene.objects):
        if obj != tree:
            bpy.data.objects.remove(obj, do_unlink=True)

    bpy.context.view_layer.objects.active = tree
    tree.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    parts = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    twig = next(obj for obj in parts if "twigs" in obj.data.materials[0].name.lower())
    _retain_components(twig, args.target_faces)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    structural = next(obj for obj in parts if "branches" in obj.data.materials[0].name.lower()
                      and "dead" not in obj.data.materials[0].name.lower())
    bpy.context.view_layer.objects.active = structural
    bpy.ops.object.join()
    structural.name = f"fir_sapling_medium_{args.variant}_runtime"
    structural["sourceAsset"] = "polyhaven-fir-sapling-medium"
    structural["sourceVariant"] = args.variant
    structural["productionDerivative"] = True
    structural["pipelineVersion"] = PIPELINE_VERSION
    structural["targetTwigFaces"] = args.target_faces
    bpy.ops.object.select_all(action="DESELECT")
    structural.select_set(True)
    bpy.context.view_layer.objects.active = structural
    bpy.ops.export_scene.gltf(
        filepath=str(pathlib.Path(args.output).resolve()), export_format="GLB",
        use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_vertex_color="ACTIVE", export_materials="EXPORT",
        export_image_format="AUTO", export_animations=False, export_extras=True,
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
    centres = {}
    for polygon in mesh.polygons:
        component = _root(parent, polygon.vertices[0])
        counts[component] = counts.get(component, 0) + 1
        centres.setdefault(component, [0.0, 0])
        centres[component][0] += polygon.center.z
        centres[component][1] += 1

    # Rank within vertical bands so every crown tier survives. Whole authored
    # cards are the atomic unit; the output never contains partial card triangles.
    bands = 48
    lo = min(value[0] / value[1] for value in centres.values())
    hi = max(value[0] / value[1] for value in centres.values())
    buckets = [[] for _ in range(bands)]
    for component, count in counts.items():
        y = centres[component][0] / centres[component][1]
        band = min(bands - 1, max(0, int((y - lo) / max(hi - lo, 1e-6) * bands)))
        value = (component ^ 0xF15A91E) & 0xFFFFFFFF
        value ^= value >> 16
        value = (value * 0x7FEB352D) & 0xFFFFFFFF
        value ^= value >> 15
        value = (value * 0x846CA68B) & 0xFFFFFFFF
        buckets[band].append((value ^ (value >> 16), component, count))
    total = sum(counts.values())
    fraction = min(1.0, target / max(total, 1))
    retained = set()
    for bucket in buckets:
        bucket.sort()
        quota = max(1, round(len(bucket) * fraction)) if bucket else 0
        retained.update(component for _rank, component, _count in bucket[:quota])
    for polygon in mesh.polygons:
        polygon.select = _root(parent, polygon.vertices[0]) not in retained
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="FACE")
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode="OBJECT")
    print(
        f"FIR_SAPLING_COMPONENT_LOD components={len(counts)} retained={len(retained)} "
        f"faces={total}->{len(mesh.polygons)} target={target}"
    )


if __name__ == "__main__":
    parsed = arguments()
    blender_stage(parsed) if parsed.blender_stage else outer(parsed)
