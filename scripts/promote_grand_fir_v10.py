#!/usr/bin/env python3
"""Promote the reviewed area-preserving Grand Fir derivative.

The source/licence identity does not change. Only source-derived runtime GLBs,
the neutral impostor, its metadata, and the catalog integrity hashes change.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/assets/trees_candidates/bk_grand_fir_v10"
DEST = ROOT / "public/assets/trees"
CATALOG = ROOT / "public/assets/environment/catalog.json"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    copies = {
        "bk_grand_fir_v10_lod0.glb": "bk_grand_fir_lod0.glb",
        "bk_grand_fir_v10_lod1.glb": "bk_grand_fir_lod1.glb",
        "bk_grand_fir_v10_impostor.png": "bk_grand_fir_impostor.png",
    }
    for source_name, destination_name in copies.items():
        shutil.copyfile(SOURCE / source_name, DEST / destination_name)

    metadata = json.loads((SOURCE / "bk_grand_fir_v10_impostor.json").read_text())
    metadata.update({
        "source": "bk_grand_fir_lod0.glb",
        "candidateOnly": False,
        "generator": "build_bk_tree@3-spatial-cards-preserve-area+neutral-impostor@2",
        "promotion": "reviewed-grand-fir-v10",
    })
    (DEST / "bk_grand_fir_impostor.json").write_text(json.dumps(metadata, indent=2) + "\n")

    catalog = json.loads(CATALOG.read_text())
    asset = next(item for item in catalog["assets"] if item["id"] == "blenderkit-grand-fir")
    asset["derivativeLineage"]["pipelineVersion"] = (
        "build_bk_tree@3-role-split-spatial-card-selection+preserve-area+neutral-impostor@2"
    )
    asset["dimensions"] = {"width": 5.782, "height": 8.115, "depth": 5.501}
    asset["bounds"] = {"radius": 2.891, "baseY": 0.034, "topY": 8.149}
    for level, name in enumerate(("bk_grand_fir_lod0.glb", "bk_grand_fir_lod1.glb")):
        asset["lods"][level]["sha256"] = digest(DEST / name)
    asset["impostor"]["sha256"] = digest(DEST / "bk_grand_fir_impostor.png")
    asset["impostor"]["generator"] = (
        "build_bk_tree@3-spatial-cards-preserve-area+scripts/bake_tree_impostor.py@2-hard-cutout"
    )
    CATALOG.write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    main()
