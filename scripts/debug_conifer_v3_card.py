"""Emit a deterministic card/UV diagnostic for the staged v3 atlas."""
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np
import hashlib

ROOT = Path(__file__).resolve().parents[1]
atlas = Image.open(ROOT / 'public/assets/trees/conifer_v3_branchlet_atlas.png').convert('RGBA')
tile = 256
src = atlas.crop((tile, 0, tile * 2, tile)).resize((512, 512), Image.Resampling.NEAREST)
out = Image.new('RGBA', (1024, 860), (26, 31, 25, 255))
out.paste(src, (0, 0))
d = ImageDraw.Draw(out)
d.line((0, 0, 512, 511), fill=(255, 60, 60, 255), width=4)
d.text((16, 16), 'tile 1 source / diagonal split', fill='white')
# Both diagnostic panels use identical tile pixels; only the triangle label
# differs. This makes accidental triangle-half opacity immediately visible.
for box in ((512, 0, 1024, 512), (0, 512, 512, 860)):
    panel = src.resize((box[2] - box[0], box[3] - box[1]), Image.Resampling.NEAREST)
    out.alpha_composite(panel, (box[0], box[1]))
d = ImageDraw.Draw(out)
d.text((530, 20), 'tri A: uv0,uv1,uv3', fill='white')
d.text((20, 530), 'tri B: uv1,uv2,uv3', fill='white')
debug = ROOT / 'shots/conifer-v3-card-uv-debug.png'
out.convert('RGB').save(debug)
q = np.asarray(src)[..., 3]
print({'tile1_nonzero': float((q > 0).mean()), 'tile1_opaque': float((q > 240).mean()), 'sha256': hashlib.sha256(debug.read_bytes()).hexdigest()})
