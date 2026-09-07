"""Bake the Poly Haven Pine Tree 01 into material-preserving runtime LOD GLBs.

The source is a dense conifer built from authored twig/spray meshes and a
separate authored twig coverage map (not a runtime billboard or impostor). The
source has three authored variants and six materials. This baker chooses one
variant, preserves every material primitive independently, and assigns each one
a semantic role for runtime wind. Foliage reduction retains complete disconnected
source sprays; structural reduction never becomes more aggressive in LOD1.

Usage:
  node scripts/fetch_polyhaven_pine_tree_01.mjs --output-dir /tmp/pine_tree_01_source
  blender --background --python scripts/process_pine_tree.py -- \
    --input /tmp/pine_tree_01_source/pine_tree_01_1k.gltf \
    --output public/assets/trees/pine_tree_01_source_lod0.glb \
    --variant b --lod 0
"""

from __future__ import annotations

import argparse
from array import array
import bpy
import hashlib
from pathlib import Path


ROLE_ORDER = ("trunk", "branches", "foliage")
PIPELINE_VERSION = "process-pine-tree-blender-5.2-material-preserving-spray-lods@7"
SOURCE_GLTF_SHA256 = "c81e8eebbda722313f07bed37b8b9156ce520f7fa95488d83a694d02fffdb469"


def parse_args() -> argparse.Namespace:
    argv = __import__("sys").argv[__import__("sys").argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--variant", default="b", choices=("a", "b", "c"))
    parser.add_argument("--lod", type=int, choices=(0, 1), required=True)
    parser.add_argument("--tex-size", type=int, default=1024)
    return parser.parse_args(argv)


def role_for_material(name: str) -> str:
    lowered = name.lower()
    if "twig" in lowered or "needle" in lowered or "foliage" in lowered:
        return "foliage"
    if "dead" in lowered or "branch" in lowered:
        return "branches"
    return "trunk"


def target_faces(role: str, lod: int) -> int:
    # Pine Tree 01's source twig/spray geometry is deliberately dense (4M+ tris
    # per variant). The near source derivative keeps enough of that authored crown
    # to read as evergreen foliage from the fairway; the former 96k reduction
    # passed topology checks but visibly collapsed into sparse branch points.
    # LOD1 remains volumetric and never becomes a card. Foliage is reduced by
    # retaining complete disconnected source sprays below, so these budgets no
    # longer collapse neighboring needles into the long skeletal triangles that
    # failed the course address views.
    if lod == 0:
        # The 700k and 560k review tiers retained more overlapping interior
        # sprays than the close golfer silhouette needed. Keep a 460k whole-spray
        # crown: still materially richer than the 300k middle tier, with no
        # collapsed triangles or altered source needles, while buying back near
        # view vertex work for Three.js/WebGPU shadow and alpha passes.
        return {"trunk": 9000, "branches": 10000, "foliage": 460000}[role]
    # Pine Tree 01's structural source is already inexpensive relative to its
    # 4.1M-triangle authored twig/spray crown. Reducing trunk/deadwood below the near
    # budgets turns long source limbs into the opaque brown triangular shards
    # visible at 40-80 m. LOD1 therefore reduces only complete foliage sprays;
    # every retained triangle keeps its authored vertices, normals, UVs and
    # vertex colours, while bark/trunk/deadwood keep the same bounded topology.
    # 300k complete sprays is the measured middle ground: it retains the broad
    # source crown tiers and crisp authored alpha while bringing the 272-tree
    # battery view inside the 30 FPS geometry budget with the matte Lambert
    # foliage shader. The old 96k/240k experiments remain explicitly rejected.
    return {"trunk": 9000, "branches": 10000, "foliage": 300000}[role]


def make_role_material(source: bpy.types.Material, role: str) -> bpy.types.Material:
    material = source.copy()
    # Keep the source material identity: bark, trunk-b, twig, and dead branches
    # own different authored PBR maps even when two share the same runtime role.
    material.name = source.name
    if role == "foliage":
        # Poly Haven's glTF omits the package's separate twig-alpha PNG, so the
        # derivative remains opaque here. The verified catalog record attaches
        # that authored coverage by this exact material identity at runtime.
        material.surface_render_method = "DITHERED"
    return material


def _root(parent: array, value: int) -> int:
    while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
    return value


def retain_complete_foliage_sprays(obj: bpy.types.Object, target: int, lod: int) -> None:
    """Delete whole source islands, never collapse their authored needle shape."""
    mesh = obj.data
    parent = array("I", range(len(mesh.vertices)))
    for edge in mesh.edges:
        left = _root(parent, edge.vertices[0])
        right = _root(parent, edge.vertices[1])
        if left != right:
            if left < right:
                parent[right] = left
            else:
                parent[left] = right
    face_counts: dict[int, int] = {}
    for polygon in mesh.polygons:
        root = _root(parent, polygon.vertices[0])
        face_counts[root] = face_counts.get(root, 0) + 1
    # Integer avalanche of the immutable source-island root gives a deterministic,
    # spatially uncorrelated rank without introducing or reshaping geometry.
    def rank(root: int) -> int:
        value = (root ^ (0x9E3779B9 * (lod + 1))) & 0xFFFFFFFF
        value ^= value >> 16
        value = (value * 0x7FEB352D) & 0xFFFFFFFF
        value ^= value >> 15
        value = (value * 0x846CA68B) & 0xFFFFFFFF
        return value ^ (value >> 16)
    retained: set[int] = set()
    retained_faces = 0
    for root, count in sorted(face_counts.items(), key=lambda item: rank(item[0])):
        retained.add(root)
        retained_faces += count
        if retained_faces >= target:
            break
    for polygon in mesh.polygons:
        polygon.select = _root(parent, polygon.vertices[0]) not in retained
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="FACE")
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode="OBJECT")
    print(
        f"SPRAYS lod={lod} components={len(face_counts)} retained={len(retained)} "
        f"faces={sum(face_counts.values())}->{len(mesh.polygons)} target={target}"
    )


def apply_role_decimate(obj: bpy.types.Object, role: str, lod: int) -> None:
    before = len(obj.data.polygons)
    target = target_faces(role, lod)
    if role == "foliage" and before > target:
        retain_complete_foliage_sprays(obj, target, lod)
        return
    if before > target:
        modifier = obj.modifiers.new(f"pine_{role}_lod{lod}_decimate", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = target / before
        modifier.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    print(f"ROLE role={role} lod={lod} faces={before}->{len(obj.data.polygons)} target={target}")


def main() -> None:
    args = parse_args()
    if bpy.app.version[:2] != (5, 2):
        raise RuntimeError(f"{PIPELINE_VERSION} requires Blender 5.2.x, got {bpy.app.version_string}")
    source_path = Path(args.input).resolve()
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if source_hash != SOURCE_GLTF_SHA256:
        raise RuntimeError(f"source glTF SHA-256 mismatch: {source_hash}")
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source_path))

    wanted = f"pine_tree_01_{args.variant}_LOD0"
    source = next((o for o in bpy.context.scene.objects if o.type == "MESH" and o.name == wanted), None)
    if source is None:
        raise RuntimeError(f"missing source variant {wanted}")
    # The source glTF places variants side-by-side for review. Remove that
    # presentation translation before exporting the playable prototype.
    source.location = (0, 0, 0)
    bpy.context.view_layer.objects.active = source
    source.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for obj in list(bpy.context.scene.objects):
        if obj != source:
            bpy.data.objects.remove(obj, do_unlink=True)

    # Split the source into one object per authored material and keep those
    # primitives separate. Pine Tree 01 uses distinct bark and trunk-b PBR maps;
    # joining them and assigning the first material silently re-UVs neither mesh
    # but does bind the wrong texture set to one of them. Runtime role tags come
    # from the stable material names, so preserving four source primitives still
    # gives wind/LOD code an explicit trunk / branches / foliage contract.
    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    role_objects: list[bpy.types.Object] = []
    for piece in sorted(pieces, key=lambda item: item.data.materials[0].name):
        if not piece.data.materials:
            raise RuntimeError(f"source piece {piece.name} has no material")
        source_material = piece.data.materials[0]
        role = role_for_material(source_material.name)
        role_material = make_role_material(source_material, role)
        source_name = source_material.name.lower().replace("pine_tree_01_", "")
        piece.data.materials.clear()
        piece.data.materials.append(role_material)
        for polygon in piece.data.polygons:
            polygon.material_index = 0
        piece.name = f"pine_tree_01_{role}_{source_name}_lod{args.lod}"
        apply_role_decimate(piece, role, args.lod)
        role_objects.append(piece)

    present_roles = {role_for_material(obj.data.materials[0].name) for obj in role_objects}
    missing_roles = set(ROLE_ORDER) - present_roles
    if missing_roles:
        raise RuntimeError(f"source has no geometry for roles: {sorted(missing_roles)}")

    # Normalize the ground contact after decimation. Keep the source's authored
    # vertical scale; only remove tiny negative noise so placement burial remains
    # deterministic and consistent across both LODs.
    minimum = min(vertex.co.z for obj in role_objects for vertex in obj.data.vertices)
    for obj in role_objects:
        for vertex in obj.data.vertices:
            vertex.co.z -= minimum
        obj.location = (0, 0, 0)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in role_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = role_objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_selection=True,
        export_apply=False, export_texcoords=True, export_normals=True,
        export_materials="EXPORT", export_image_format="AUTO", export_texture_dir=str(output.parent),
        # Embed the decoded source images in the GLB. Keeping originals makes
        # Blender emit 1x1 white placeholders for external glTF images, which
        # destroys the pine's green/bark albedo at runtime.
        export_keep_originals=False, export_yup=True,
    )
    derivative_hash = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"PINE_TREE_DONE pipeline={PIPELINE_VERSION} source={source_hash} output={output} lod={args.lod} bytes={output.stat().st_size} sha256={derivative_hash}")


if __name__ == "__main__":
    main()
