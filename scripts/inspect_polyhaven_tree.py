"""Report material topology for one Poly Haven tree glTF.

Run with Blender so source-asset LOD work can distinguish isolated authored
sprays/cards from one connected crown before choosing a reduction strategy.
"""

from __future__ import annotations

import argparse
from collections import Counter, deque
import sys

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--node")
    return parser.parse_args(argv)


def connected_component_sizes(mesh: bpy.types.Mesh) -> list[int]:
    adjacency: list[list[int]] = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        left, right = edge.vertices
        adjacency[left].append(right)
        adjacency[right].append(left)
    unseen = set(range(len(mesh.vertices)))
    sizes: list[int] = []
    while unseen:
        seed = unseen.pop()
        queue = deque([seed])
        size = 0
        while queue:
            vertex = queue.popleft()
            size += 1
            for neighbour in adjacency[vertex]:
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    queue.append(neighbour)
        sizes.append(size)
    return sizes


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.input)
    source = next((obj for obj in bpy.context.scene.objects
      if obj.type == "MESH" and (args.node is None or obj.name == args.node)), None)
    if source is None:
        raise RuntimeError(f"missing mesh node {args.node}")
    for material_index, material in enumerate(source.data.materials):
        bpy.ops.object.select_all(action="DESELECT")
        source.select_set(True)
        bpy.context.view_layer.objects.active = source
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.object.mode_set(mode="OBJECT")
        for polygon in source.data.polygons:
            polygon.select = polygon.material_index == material_index
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="SELECTED")
        bpy.ops.object.mode_set(mode="OBJECT")
        selected = [obj for obj in bpy.context.selected_objects if obj is not source]
        if not selected:
            continue
        piece = selected[0]
        sizes = connected_component_sizes(piece.data)
        histogram = Counter(min(size, 64) for size in sizes)
        print(
            "TREE_TOPOLOGY",
            f"material={material.name}",
            f"vertices={len(piece.data.vertices)}",
            f"polygons={len(piece.data.polygons)}",
            f"components={len(sizes)}",
            f"largest={max(sizes, default=0)}",
            f"small_histogram={dict(sorted(histogram.items())[:16])}",
        )


if __name__ == "__main__":
    main()
