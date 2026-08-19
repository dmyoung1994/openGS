#!/usr/bin/env python3
"""Build an extracted-source branchlet-card conifer for the WebGPU tree path.

The foliage tiles are cropped from Poly Haven's CC0 Fir Tree 01 twig albedo,
then alpha-segmented against its atlas background.  Runtime geometry is a
project-authored scaffold: a tapered trunk/primary branches plus many small,
cross-oriented branchlet clusters.  Cards are local branchlets, never a
tree-sized crossed billboard, and each cluster receives deterministic scale,
droop, azimuth, and density variation.
"""
from __future__ import annotations
import argparse, hashlib, io, json, math, random, struct
from pathlib import Path
from PIL import Image, ImageFilter, ImageChops
import numpy as np
import cv2

HEIGHT = 18.895
SOURCE_HASH = '72e49eefb4ed4db6a8ca5e17fb10980f8463dd300d94589ac774cde95ade7709'
WOOD = (0.16, 0.072, 0.025, 1)

def align4(v): return (v + 3) & ~3
def norm(v):
    l = math.sqrt(sum(x*x for x in v)) or 1
    return tuple(x/l for x in v)
def cross(a,b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def basis(axis):
    axis=norm(axis); ref=(0,1,0) if abs(axis[1])<.9 else (1,0,0); u=norm(cross(axis,ref)); return axis,u,norm(cross(axis,u))

class Mesh:
    def __init__(self): self.p=[]; self.n=[]; self.uv=[]; self.i=[]; self.tris=[]; self.tri_material=[]
    def v(self,p,uv): self.p.append(tuple(p)); self.n.append([0.,0.,0.]); self.uv.append(tuple(uv)); return len(self.p)-1
    def tri(self,a,b,c,uva,uvb,uvc):
        ia,ib,ic=self.v(a,uva),self.v(b,uvb),self.v(c,uvc); self.i += [ia,ib,ic]; self.tris.append((ia,ib,ic))
        # Tile 0 is the opaque structural bark tile; all other atlas tiles are
        # source-alpha twig sprays. Keeping this semantic split in the GLB is
        # important: Trees.js can then apply authored alpha only to foliage.
        self.tri_material.append(0 if (uva[0] * 4) < 1 else 1)
    def quad(self,a,b,c,d,uv): self.tri(a,b,d,uv[0],uv[1],uv[3]); self.tri(b,c,d,uv[1],uv[2],uv[3])
    def normals(self):
        for ia,ib,ic in self.tris:
            a,b,c=self.p[ia],self.p[ib],self.p[ic]; n=cross((b[0]-a[0],b[1]-a[1],b[2]-a[2]),(c[0]-a[0],c[1]-a[1],c[2]-a[2]))
            for j in (ia,ib,ic): self.n[j]=[self.n[j][k]+n[k] for k in range(3)]
        self.n=[norm(n) for n in self.n]

def tile_uv(tile, columns=4, rows=4, bounds=None):
    x,y=tile%columns,tile//columns; pad=.018
    # LOD1 cards use the measured source-alpha rectangle for each authored tile.
    # LOD0 keeps the historical full-tile UV contract so the close tier and its
    # licensed silhouette remain byte-for-byte stable.
    if bounds is None:
        bounds=(0.0, 0.0, 1.0, 1.0)
    bx0, by0, bx1, by1 = bounds
    x0=(x+bx0+pad*(bx1-bx0))/columns; x1=(x+bx1-pad*(bx1-bx0))/columns
    # glTFLoader uploads glTF images with flipY=false. UV v=0 addresses the
    # first (top) row of the PNG in this path, so preserve the atlas' image
    # origin instead of mirroring each source spray into the neighboring row.
    y0=(y+by0+pad*(by1-by0))/rows; y1=(y+by1-pad*(by1-by0))/rows
    return ((x0,y0),(x1,y0),(x1,y1),(x0,y1))

def cylinder(m,a,b,r0,r1,sides,uv):
    axis,u,v=basis((b[0]-a[0],b[1]-a[1],b[2]-a[2])); rings=[]
    for c,r in ((a,r0),(b,r1)):
        rings.append([tuple(c[k]+r*(u[k]*math.cos(math.tau*j/sides)+v[k]*math.sin(math.tau*j/sides)) for k in range(3)) for j in range(sides)])
    for j in range(sides): m.quad(rings[0][j],rings[0][(j+1)%sides],rings[1][(j+1)%sides],rings[1][j],uv)
    m.tri(a,rings[0][1],rings[0][0],uv[0],uv[1],uv[2]); m.tri(b,rings[1][0],rings[1][1],uv[0],uv[1],uv[2])

def branchlet_cluster(m, centre, axis, length, width, tile, rng, droop, planes=4, tile_bounds=None):
    axis,u,v=basis(axis); bounds=(tile_bounds or {}).get(tile, (0.0, 0.0, 1.0, 1.0)) if planes == 2 else (0.0, 0.0, 1.0, 1.0); uv=tile_uv(tile, bounds=bounds)
    # The runtime alpha cutoff is .06 (16/255). Tightening the LOD1 card to the
    # measured opaque rectangle preserves its world-space source silhouette while
    # removing transparent gutter fragments. The center stays authored; crossed
    # pair orientation/count and every whorl/volume placement remain unchanged.
    tight = planes == 2
    card_length = length * (bounds[3] - bounds[1] if tight else 1.0)
    card_width = width * (bounds[2] - bounds[0] if tight else 1.0)
    # Four small planes form one local spray. Their normals and roll vary around
    # the branchlet axis, so no camera sees a single flat crown sheet. Four is
    # the minimum cross that keeps a local spray volumetric while avoiding the
    # six-plane overdraw/topology multiplier used by the original staging bake.
    for j in range(4):
        roll=(j/4)*math.tau + (rng.random()-.5)*.42
        side=norm((u[0]*math.cos(roll)+v[0]*math.sin(roll),u[1]*math.cos(roll)+v[1]*math.sin(roll),u[2]*math.cos(roll)+v[2]*math.sin(roll)))
        up=norm(cross(axis,side)); lean=(rng.random()-.5)*.18
        d=norm((axis[0]+up[0]*lean,axis[1]+up[1]*lean,axis[2]+up[2]*lean))
        origin=tuple(centre[k]-d[k]*card_length*.48 for k in range(3)); tip=tuple(centre[k]+d[k]*card_length*.52 for k in range(3)); half=card_width*(.80+.35*rng.random())
        # a tapered frond, with the outer pair slightly drooped
        a=tuple(origin[k]-side[k]*half for k in range(3)); b=tuple(origin[k]+side[k]*half for k in range(3)); c=tuple(tip[k]+side[k]*half*.22 for k in range(3)); dd=tuple(tip[k]-side[k]*half*.22 for k in range(3))
        # LOD1 retains every source-derived cluster centre but emits one crossed
        # pair instead of the close tier's four-plane local spray. Still consume
        # the complete deterministic random sequence so its whorls, branch axes,
        # atlas tiles, and crown envelope remain registered with LOD0.
        if planes == 4 or j < 2: m.quad(a,b,c,dd,uv)

def source_uv_alpha(gltf_path, size=1024):
    """Rasterize the original twig primitive UV islands into an exact coverage mask."""
    doc=json.loads(Path(gltf_path).read_text()); blob=(Path(gltf_path).parent/doc['buffers'][0]['uri']).read_bytes()
    def setup(index):
        a=doc['accessors'][index]; v=doc['bufferViews'][a['bufferView']]; fmt={5121:'B',5123:'H',5125:'I',5126:'f'}[a['componentType']]; n={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']]; return a,v.get('byteOffset',0)+a.get('byteOffset',0),v.get('byteStride',struct.calcsize('<'+fmt*n)),fmt,n
    def get(s,i): a,o,stride,fmt,n=s; return struct.unpack_from('<'+fmt*n,blob,o+i*stride)
    mask=np.zeros((size,size),dtype=np.uint8); polygons=[]
    for mesh in doc['meshes']:
        for p in mesh['primitives']:
            if p.get('material') != 2: continue
            uv=setup(p['attributes']['TEXCOORD_0']); ind=setup(p['indices']); count=ind[0]['count']
            # The source repeats branchlet UV islands, but a sparse stride can
            # miss whole sprays because index order follows geometry batches.
            # Keep every fourth triangle; rasterization remains offline-only and
            # preserves coherent island coverage rather than color heuristics.
            for t in range(0,count,3*4):
                points=[]
                for j in range(3):
                    u,v=get(uv,get(ind,t+j)[0]);
                    # Poly Haven's twig material uses the left 26.3% of the
                    # JPEG atlas; the remaining image is packed bark/other
                    # source material. Keep source UV transform exactly.
                    u=(u-.0095)/(.2633-.0095); v=max(0,min(1,v)); points.append((int(max(0,min(size-1,u*size))),int(max(0,min(size-1,(1-v)*size)))))
                polygons.append(np.asarray(points,dtype=np.int32))
                if len(polygons)>=20000: cv2.fillPoly(mask,polygons,255); polygons=[]
    if polygons: cv2.fillPoly(mask,polygons,255)
    return Image.fromarray(mask,'L')

def alpha_tile_bounds(atlas_image, tile_size=256, threshold=16):
    """Return normalized per-tile bounds for source pixels that survive alpha test."""
    alpha=np.asarray(atlas_image.convert('RGBA'))[...,3]
    bounds={0:(0.0,0.0,1.0,1.0)}
    guard=1.0/tile_size
    for tile in range(1, 16):
        x,y=tile%4,tile//4; q=alpha[y*tile_size:(y+1)*tile_size,x*tile_size:(x+1)*tile_size]
        ys,xs=np.where(q>=threshold)
        if not len(xs): bounds[tile]=(0.0,0.0,1.0,1.0); continue
        x0=max(0.0, xs.min()/tile_size-guard); y0=max(0.0, ys.min()/tile_size-guard)
        x1=min(1.0, (xs.max()+1)/tile_size+guard); y1=min(1.0, (ys.max()+1)/tile_size+guard)
        bounds[tile]=(x0,y0,x1,y1)
    return bounds

def atlas(source, gltf_path, output, size=256):
    """Pack the official Poly Haven twig diffuse + alpha maps.

    The old v3 bake tried to infer coverage from glTF UV occupancy.  That is
    wrong for a card atlas: UV occupancy is the rectangle, while the actual
    needle silhouette is supplied by Poly Haven's paired twig alpha map.  The
    alpha PNG is an explicit CC0 source map and is deliberately used directly
    here; no color-difference or geometry-coverage heuristic remains.
    """
    twig=Image.open(source).convert('RGB'); bark=Image.open(source.parent/'fir_tree_01_bark_diff_1k.jpg').convert('RGB')
    alpha_path=source.parent/'fir_tree_01_twig_alpha_1k.png'
    if not alpha_path.exists():
        raise FileNotFoundError(f'official paired alpha map missing: {alpha_path}')
    alpha=Image.open(alpha_path).convert('L')
    # Coherent source sprays, selected from the alpha silhouette.  Each crop
    # is padded a little for anti-aliased gutters and then fitted into a square
    # tile, so cards never carry a full source-atlas rectangle.
    boxes=[(185,30,440,335),(495,80,725,440),(650,30,1015,420),
           (395,275,510,430),(500,250,680,450),(300,390,680,800),
           (640,440,1015,900),(205,790,335,1024),(315,775,640,1024),
           (630,775,1024,1024),(245,45,430,330),(680,45,965,390),
           (365,420,610,760),(690,480,980,850),(425,285,590,500)]
    out=Image.new('RGBA',(size*4,size*4),(0,0,0,0))
    tile0=bark.crop((0,0,bark.width,min(bark.height,512))).resize((size,size)); tile0.putalpha(255); out.paste(tile0,(0,0))
    for tile,box in enumerate(boxes,1):
        crop=twig.crop(box).resize((size,size),Image.Resampling.LANCZOS); a=alpha.crop(box).resize((size,size),Image.Resampling.LANCZOS)
        # Keep source alpha, but clear the outer 1px gutter so alpha mips do
        # not bleed opaque pixels into neighboring cards.
        aa=np.array(a); aa[:1,:]=aa[-1:,:]=aa[:,:1]=aa[:,-1:]=0
        crop.putalpha(Image.fromarray(aa,'L')); out.paste(crop,((tile%4)*size,(tile//4)*size),crop)
    output.parent.mkdir(parents=True,exist_ok=True); out.save(output,optimize=True); return out

def build(lod, output, atlas_image, seed=0xC01F3E, tile_bounds=None):
    # Both LODs share one deterministic macro tree. LOD1 simplifies only each
    # local branchlet cross-section and structural cylinder sides; generating a
    # second random tree here caused a conspicuous silhouette replacement.
    rng=random.Random(seed); m=Mesh(); bark=tile_uv(0)
    # LOD0 keeps the continuous trunk silhouette; LOD1 uses fewer rings because
    # the mid-tier transition is silhouette-bound rather than a close-up bark
    # inspection. Both remain a single combined authored-alpha primitive.
    steps=22 if lod == 0 else 14; centres=[]
    # Let the foliage own the crown tip.  A full-height bark leader reads as a
    # black artificial spike once the cutout sprays are alpha-tested; stopping
    # it just below the upper foliage gives the silhouette a natural soft cap.
    trunk_top = HEIGHT - .92
    for i in range(steps+1):
        t=i/steps; centres.append((.12*math.sin(t*2.2),trunk_top*t,.1*math.sin(t*1.6+.4)))
    for i in range(steps): cylinder(m,centres[i],centres[i+1],.42*(1-i/steps)**.7+.032,.42*(1-(i+1)/steps)**.7+.032,8,bark)
    # The original bake spent most triangles on overlapping branchlet cards.
    # Every tier preserves the broad whorl rhythm and cluster centres. LOD1 saves
    # topology inside each small spray instead of deleting whole crown layers.
    levels=18; branches=6; clusters=5
    for level in range(levels):
        t=(level+.35)/levels; y=1.10+(HEIGHT-1.72)*t+(rng.random()-.5)*.62
        # Keep a continuous lower crown instead of pinching it into a pole.
        # Broad, overlapping whorls produce a fuller source-like crown while
        # retaining irregular spacing and a tapered upper third.
        radius=(math.sin(math.pi*(.075+.90*t))**.48)*(3.75+.58*rng.random()); phase=rng.random()*math.tau
        for bi in range(branches):
            angle=phase+math.tau*bi/branches+(rng.random()-.5)*.78; root=(.12*math.sin(y*.12),y,.1*math.sin(y*.08+.4)); droop=.34+.72*(1-t)+rng.random()*.30
            tip=(root[0]+math.cos(angle)*radius,root[1]-droop,root[2]+math.sin(angle)*radius); cylinder(m,root,tip,.045*(1-.35*t),.006,5 if lod == 0 else 4,bark)
            for ci in range(clusters):
                f=(ci+.35+rng.random()*.25)/clusters; c=tuple(root[k]+(tip[k]-root[k])*f for k in range(3)); c=(c[0],c[1]+(rng.random()-.5)*.28,c[2]); az=angle+(rng.random()-.5)*.8; pitch=(rng.random()-.5)*1.0-.12*(1-t); axis=(math.cos(az)*math.cos(pitch),math.sin(pitch),math.sin(az)*math.cos(pitch)); branchlet_cluster(m,c,axis,.68+.37*(1-t)+rng.random()*.26,.29+.12*rng.random(),1+rng.randrange(15),rng,rng.random()*.2,4 if lod == 0 else 2,tile_bounds)
            # One lifted side spray breaks the repeated branch-plane read. Keep
            # its centre in both tiers; LOD1 simplifies only the local plane pair.
            f=.58; c=tuple(root[k]+(tip[k]-root[k])*f for k in range(3)); az=angle+(rng.random()-.5)*1.1; branchlet_cluster(m,c,(math.cos(az),.45,math.sin(az)),.56,.20,1+rng.randrange(15),rng,.2,4 if lod == 0 else 2,tile_bounds)
    # Fill the crown as an irregular 3-D population between primary whorls.
    # These are still local branchlet sprays, but their centers are sampled in
    # the crown volume rather than constrained to a horizontal branch line.
    volume_count = 120
    for _ in range(volume_count):
        t = .06 + rng.random() * .94; y = .86 + (HEIGHT - 1.28) * t
        crown = math.sin(math.pi * (.04 + .92*t)) ** .44; r = (rng.random() ** .78) * (3.75 * crown + .18)
        az = rng.random() * math.tau; c = (math.cos(az) * r, y + (rng.random()-.5)*.58, math.sin(az) * r)
        pitch = (rng.random()-.5) * 1.2; yaw = rng.random() * math.tau
        axis = (math.cos(yaw)*math.cos(pitch), math.sin(pitch), math.sin(yaw)*math.cos(pitch))
        branchlet_cluster(m, c, axis, .57 + rng.random()*.44, .26 + rng.random()*.12, 1+rng.randrange(15), rng, .2, 4 if lod == 0 else 2,tile_bounds)
    # A compact, upward-facing terminal cluster conceals the leader end and
    # gives the tree a soft, irregular apex instead of a pointed dark cone.
    terminal_count = 4
    for _ in range(terminal_count):
            az = rng.random() * math.tau
            c = (math.cos(az) * (.12 + rng.random()*.24), HEIGHT - .72 + rng.random()*.30,
                 math.sin(az) * (.12 + rng.random()*.24))
            axis = (math.cos(az)*.42, .82 + rng.random()*.18, math.sin(az)*.42)
            branchlet_cluster(m, c, axis, .48 + rng.random()*.20, .24 + rng.random()*.08, 1+rng.randrange(15), rng, .05, 4 if lod == 0 else 2,tile_bounds)
    m.normals(); write_glb(m,output,atlas_image,lod); return {'vertices':len(m.p),'triangles':len(m.i)//3,'bounds':([min(p[i] for p in m.p) for i in range(3)],[max(p[i] for p in m.p) for i in range(3)])}, m

def write_glb(m,out,atlas_image,lod):
    binary=bytearray(); views=[]; acc=[]
    def attr(payload,count,typ,minmax=None):
        st=align4(len(binary)); binary.extend(b'\0'*(st-len(binary))); binary.extend(payload); views.append({'buffer':0,'byteOffset':st,'byteLength':len(payload),'target':34962}); q={'bufferView':len(views)-1,'componentType':5126,'count':count,'type':typ};
        if minmax:q['min'],q['max']=minmax
        acc.append(q); return len(acc)-1
    pa=attr(b''.join(struct.pack('<3f',*x) for x in m.p),len(m.p),'VEC3',([min(x[i] for x in m.p) for i in range(3)],[max(x[i] for x in m.p) for i in range(3)])); na=attr(b''.join(struct.pack('<3f',*x) for x in m.n),len(m.n),'VEC3'); ua=attr(b''.join(struct.pack('<2f',*x) for x in m.uv),len(m.uv),'VEC2'); fmt='I' if len(m.p)>=65536 else 'H'; typ=5125 if fmt=='I' else 5123
    st=align4(len(binary)); binary.extend(b'\0'*(st-len(binary))); payload=struct.pack('<'+fmt*len(m.i),*m.i); binary.extend(payload); views.append({'buffer':0,'byteOffset':st,'byteLength':len(payload),'target':34963}); acc.append({'bufferView':len(views)-1,'componentType':typ,'count':len(m.i),'type':'SCALAR'}); ii=len(acc)-1
    png=io.BytesIO(); atlas_image.save(png,format='PNG',optimize=True); raw=png.getvalue(); st=align4(len(binary)); binary.extend(b'\0'*(st-len(binary))); binary.extend(raw); views.append({'buffer':0,'byteOffset':st,'byteLength':len(raw)}); image_view=len(views)-1; name=f'conifer_v3_lod{lod}'; doc={'asset':{'version':'2.0','generator':'build_conifer_v3@2-lod-optimized'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':name}],'meshes':[{'name':name,'primitives':[{'attributes':{'POSITION':pa,'NORMAL':na,'TEXCOORD_0':ua},'indices':ii,'material':0}]}],'materials':[{'name':'conifer_v3_authored_alpha_atlas','doubleSided':True,'alphaMode':'MASK','alphaCutoff':.06,'pbrMetallicRoughness':{'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':.86}}],'images':[{'mimeType':'image/png','bufferView':image_view}],'textures':[{'source':0,'sampler':0}],'samplers':[{'magFilter':9729,'minFilter':9729,'wrapS':33071,'wrapT':33071}],'buffers':[{'byteLength':len(binary)}],'bufferViews':views,'accessors':acc,'extras':{'sourceAsset':'polyhaven-fir-tree-01','sourceHash':SOURCE_HASH,'sourceTexture':'fir_tree_01_twig_diff_1k.jpg','sourceTextureSha256':hashlib.sha256((Path('public/assets/trees_src/fir_tree_01/textures/fir_tree_01_twig_diff_1k.jpg')).read_bytes()).hexdigest(),'sourceAlpha':'fir_tree_01_twig_alpha_1k.png','sourceAlphaMd5':'02ab808c8b2ff77ad9fdb2f92892db80','geometry':'project-authored-irregular-branchlet-clusters-v3-lod-optimized','lod':lod}}
    js=json.dumps(doc,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4); bb=bytes(binary)+b'\0'*((4-len(binary)%4)%4); out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(struct.pack('<4sII',b'glTF',2,12+8+len(js)+8+len(bb))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(bb),0x004e4942)+bb)

def impostor(m, out, atlas_image, size=512):
    """Bake an actual source-textured, alpha-tested eight-view impostor.

    The prior implementation painted every projected triangle a solid color,
    which made the far representation visibly card-shaped.  This small
    offline rasterizer interpolates each card's atlas UVs and depth-tests the
    real diffuse/alpha pixels.  Runtime still receives one cheap PNG.
    """
    tex=np.asarray(atlas_image.convert('RGBA'),dtype=np.uint8); th,tw=tex.shape[:2]
    image=Image.new('RGBA',(size*4,size*2),(0,0,0,0))
    pos=np.asarray(m.p,dtype=np.float32); uv=np.asarray(m.uv,dtype=np.float32); idx=np.asarray(m.i,dtype=np.int32).reshape(-1,3)
    # Fit the complete source tree in every square.  The old bake used a
    # horizontal-only extent (6.1m) even though this asset is 18.9m tall;
    # projected crowns were consequently clipped and the atlas looked like a
    # field of disconnected cards.  Use the largest projected width and the
    # actual vertical extent so all eight views share a stable, grounded frame.
    projected_width = max(
        np.ptp(pos[:, 0] * math.cos(math.tau * frame / 8) - pos[:, 2] * math.sin(math.tau * frame / 8))
        for frame in range(8)
    )
    vertical_extent = float(np.ptp(pos[:, 1]))
    scale = size * .84 / max(projected_width, vertical_extent)
    for frame in range(8):
        angle=math.tau*frame/8; ca,sa=math.cos(angle),math.sin(angle)
        px=pos[:,0]*ca-pos[:,2]*sa; depth=pos[:,0]*sa+pos[:,2]*ca
        # Center each view's horizontal bounds while keeping the lowest source
        # vertex on the same 8% bottom gutter. This preserves a real ground
        # contact in the baked card instead of a floating/offset trunk.
        sx=size*.5+(px-(px.min()+px.max())*.5)*scale
        sy=size*.92-(pos[:,1]-pos[:,1].min())*scale
        rgba=np.zeros((size,size,4),dtype=np.uint8); zbuf=np.full((size,size),-np.inf,dtype=np.float32)
        # Far-to-near is not sufficient for intersecting cards; retain the
        # nearest projected sample with an explicit depth buffer.
        for ia,ib,ic in idx:
            x0,y0,x1,y1,x2,y2=float(sx[ia]),float(sy[ia]),float(sx[ib]),float(sy[ib]),float(sx[ic]),float(sy[ic])
            minx=max(0,int(math.floor(min(x0,x1,x2)))); maxx=min(size-1,int(math.ceil(max(x0,x1,x2))))
            miny=max(0,int(math.floor(min(y0,y1,y2)))); maxy=min(size-1,int(math.ceil(max(y0,y1,y2))))
            if minx>maxx or miny>maxy: continue
            den=(y1-y2)*(x0-x2)+(x2-x1)*(y0-y2)
            if abs(den)<1e-6: continue
            xx,yy=np.meshgrid(np.arange(minx,maxx+1,dtype=np.float32)+.5,np.arange(miny,maxy+1,dtype=np.float32)+.5)
            w0=((y1-y2)*(xx-x2)+(x2-x1)*(yy-y2))/den; w1=((y2-y0)*(xx-x2)+(x0-x2)*(yy-y2))/den; w2=1-w0-w1; inside=(w0>=0)&(w1>=0)&(w2>=0)
            if not inside.any(): continue
            zz=w0*depth[ia]+w1*depth[ib]+w2*depth[ic]; better=inside&(zz>=zbuf[miny:maxy+1,minx:maxx+1])
            if not better.any(): continue
            # Atlas UVs use the same top-origin image convention as the glTF
            # branchlet material (GLTFLoader uploads it with flipY=false).
            # Flipping v here sampled a different tile row and turned valid
            # foliage UVs into unrelated bark/triangle shards.
            uu=np.clip((w0*uv[ia,0]+w1*uv[ib,0]+w2*uv[ic,0])*tw,0,tw-1.001); vv=np.clip((w0*uv[ia,1]+w1*uv[ib,1]+w2*uv[ic,1])*th,0,th-1.001)
            ti=np.asarray(np.floor(vv),dtype=np.int32); tj=np.asarray(np.floor(uu),dtype=np.int32); sample=tex[ti,tj]
            # Alpha test matches the runtime glTF material.  Preserve the
            # source's soft edges above cutoff instead of filling the card.
            better &= sample[...,3]>=16
            zsub=zbuf[miny:maxy+1,minx:maxx+1]; zsub[better]=zz[better]
            dst=rgba[miny:maxy+1,minx:maxx+1]; dst[better]=sample[better]
        tile=Image.fromarray(rgba,'RGBA'); image.alpha_composite(tile,(frame%4*size,(1-frame//4)*size))
    image.save(out,optimize=True)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--source-dir',required=True); ap.add_argument('--output-dir',required=True); ap.add_argument('--prefix',default='conifer_v3'); args=ap.parse_args(); root=Path(args.source_dir); out=Path(args.output_dir); gltf=root.parent/'fir_tree_01_1k.gltf'; atlas_path=out/f'{args.prefix}_branchlet_atlas.png'; image=atlas(root/'fir_tree_01_twig_diff_1k.jpg',gltf,atlas_path); stats={}
    tile_bounds=alpha_tile_bounds(image)
    for lod in (0,1):
        stats[lod], mesh = build(lod,out/f'{args.prefix}_lod{lod}.glb',image,tile_bounds=tile_bounds)
        if lod == 0: impostor(mesh,out/f'{args.prefix}_impostor.png',image)
    print(json.dumps(stats,sort_keys=True)); print('atlas',atlas_path,hashlib.sha256(atlas_path.read_bytes()).hexdigest())
if __name__=='__main__': main()
