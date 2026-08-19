#!/usr/bin/env python3
"""Pack the two licensed Fir Sapling source albedo maps into one UV atlas.

This only repacks source pixels so the one-primitive WebGPU derivative can keep
the real branch/twig albedo response. It does not synthesize canopy geometry or
bake lighting.
"""
from pathlib import Path
from PIL import Image, ImageEnhance

root = Path(__file__).resolve().parents[1] / 'public/assets/trees_src/fir_sapling'
branch = Image.open(root / 'textures/fir_sapling_branches_diff_1k.jpg').convert('RGB')
twig = Image.open(root / 'textures/fir_sapling_twigs_diff_1k.jpg').convert('RGB')
if branch.size != twig.size or branch.width != branch.height:
    raise SystemExit(f'expected equal square source maps, got {branch.size} and {twig.size}')
# The source scan's needle albedo is very dark at 1K. Lift only its authored
# sRGB reflectance before the runtime linear-light PBR conversion; this is an
# albedo grade, not baked lighting, and keeps the black atlas gutter black.
twig = ImageEnhance.Brightness(twig).enhance(1.65)
atlas = Image.new('RGB', (branch.width * 2, branch.height))
atlas.paste(branch, (0, 0)); atlas.paste(twig, (branch.width, 0))
out = root / 'textures/fir_sapling_albedo_atlas_1k.png'
atlas.save(out, optimize=True)
print(f'ATLAS_DONE output={out} size={atlas.size} bytes={out.stat().st_size}')
