# Headless extract: pull the ball mesh + its DIMPLE NORMAL MAP out of the
# BlenderKit "Golf Ball" asset and write web-ready files into public/assets/ball/.
#
#   Blender --background <golfball.blend> --python extract_golfball.py -- <repo_root> [subsurf]
#
# WHAT THE SOURCE ASSET ACTUALLY IS
# The .blend holds a 54-poly rounded cube wearing three modifiers — SUBSURF(4),
# CAST(SPHERE, factor 1), NORMAL_EDIT(RADIAL) — so the cage is smoothed, snapped
# onto a true 42.7 mm sphere, and given perfectly radial shading normals. All the
# dimples live in a 2048x2048 EXR normal map laid out over the cube's six UV
# islands. That layout is the whole reason we export the mesh rather than reusing
# three's SphereGeometry: a cube-projected UV has uniform texel density and no
# pole pinch or wrap seam, which an equirect sphere UV cannot give us. The mesh is
# just the carrier for those UVs (and its own normals are exactly normalize(pos)).
#
# WHAT WE DELIBERATELY DROP
# The asset's base-colour map (GolfBallLogos.jpg) is a Titleist / Pro V1 brand
# sheet. We do not ship it. The ball is shaded with a plain near-white urethane
# albedo in src/scene/Range.js, so there are no brand marks anywhere.
#
# SUBDIVISION
# We re-cage SUBSURF from 4 (13 824 quads) down to 3 (3 456 quads). Because the
# CAST modifier makes the surface a mathematically exact sphere and the normals
# are radial, extra tessellation only buys silhouette precision we cannot see: at r =
# 21.3 mm with ~59 quads around the equator the chordal error is under 15 microns.
#
# COLOUR MANAGEMENT
# The EXR is a *linear pass-through* buffer whose floats already ARE the encoded
# normal (0.5 = flat). So the PNG bytes are literally float * 255 — no sRGB OETF,
# no view transform. Writing the PNG by hand with zlib (rather than via Blender's
# render pipeline) is what guarantees no transform can sneak in. Three must then
# read it with colorSpace = NoColorSpace, which is the texture default.
#
# WHERE THE SOURCE .blend COMES FROM (no account, no login — a public signed URL
# handed out by BlenderKit's public API; asset_base_id 43c3c8df-...-e37c0e1e9037):
#
#   ID=38023   # 2K variant, 33.7 MB. 38024 = 1K, 20345 = full 351 MiB original.
#   URL=$(curl -s "https://www.blenderkit.com/api/v1/downloads/$ID/?scene_uuid=$(uuidgen)" \
#         | python3 -c "import sys,json;print(json.load(sys.stdin)['filePath'])")
#   curl -L "$URL" -o /tmp/golfball_2k.blend
#
# Writes public/assets/ball/golfball.glb        (geometry only: pos + normal + uv)
#    and public/assets/ball/golfball_nor.png    (tangent-space dimple normals, GL +Y)
import bpy, sys, os, zlib, struct
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
repo = argv[0]
subsurf = int(argv[1]) if len(argv) > 1 else 3
outdir = os.path.join(repo, "public", "assets", "ball")
os.makedirs(outdir, exist_ok=True)


def write_png(path, w, h, rgb_u8):
    """Minimal RGB8 PNG writer (same approach as scripts/gen_turf_detail.mjs)."""
    stride = w * 3
    raw = bytearray()
    for y in range(h):
        raw.append(0)                                    # filter type 0 (None)
        raw += rgb_u8[y * stride:(y + 1) * stride].tobytes()

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


# --- 1. the dimple normal map -------------------------------------------------
img = bpy.data.images["GolfBallNormal"]
w, h = img.size
buf = np.empty(w * h * 4, dtype=np.float32)
img.pixels.foreach_get(buf)
rgb = buf.reshape(h, w, 4)[::-1, :, :3]                  # Blender stores bottom-up

# The empty gutter between the six UV islands is flat (0.5, 0.5, 1.0). Push the
# island pixels one step outward so bilinear taps right on an island border can't
# pull flat purple in and flatten the outermost ring of dimples.
flat = (np.abs(rgb[:, :, 0] - 0.5) < 1e-4) & (np.abs(rgb[:, :, 1] - 0.5) < 1e-4)
for _ in range(4):
    for ax, sh in ((0, 1), (0, -1), (1, 1), (1, -1)):
        src = np.roll(rgb, sh, axis=ax)
        srcflat = np.roll(flat, sh, axis=ax)
        take = flat & ~srcflat
        rgb[take] = src[take]
        flat = flat & ~take

u8 = (np.clip(rgb, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8).reshape(-1)
nor_path = os.path.join(outdir, "golfball_nor.png")
write_png(nor_path, w, h, u8)
print(f"[ball] normal map {w}x{h} -> {nor_path} ({os.path.getsize(nor_path)/1e6:.2f} MB)")

# --- 2. the mesh --------------------------------------------------------------
ball = bpy.data.objects["Ball"]
for m in ball.modifiers:
    if m.type == 'SUBSURF':
        m.levels = m.render_levels = subsurf

# Materials are dropped entirely (export_materials='NONE') — Range.js builds the
# PBR in TSL — which also keeps the brand-marked colour map out of the GLB.
for o in bpy.data.objects:
    o.select_set(False)
ball.select_set(True)
bpy.context.view_layer.objects.active = ball

glb_path = os.path.join(outdir, "golfball.glb")
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format='GLB',
    use_selection=True,
    export_apply=True,          # evaluate SUBSURF + CAST + NORMAL_EDIT
    export_materials='NONE',
    export_normals=True,
    export_texcoords=True,
    export_tangents=False,      # three computes these (computeTangents) at load
    export_yup=True,
)
print(f"[ball] mesh subsurf={subsurf} -> {glb_path} ({os.path.getsize(glb_path)/1e6:.2f} MB)")
