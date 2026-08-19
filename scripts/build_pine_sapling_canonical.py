#!/usr/bin/env python3
"""Bake Poly Haven's CC0 Pine Sapling Medium into compact canonical GLBs.

The licensed source has three authored pine silhouettes and millions of needle
triangles.  This deterministic reservoir baker keeps silhouette-balanced
structural bark/deadwood and a dense, radial sample of the source needle mesh,
then bakes source albedo into linear vertex colors for the production one-part
WebGPU tree path.  No runtime fetch or procedural foliage is involved.
"""
from __future__ import annotations
import argparse, json, math, mmap, pathlib, random, struct
from collections import defaultdict
from PIL import Image

ROLE = {'bark': (0, 1), 'foliage': (1, 4), 'deadwood': (2, 7)}
TARGETS = {0: {'bark': 16000, 'foliage': 1200000, 'deadwood': 5000}, 1: {'bark': 7000, 'foliage': 320000, 'deadwood': 2200}}

def align4(v): return (v + 3) & ~3
def srgb(v): return (v / 255.0) ** 2.2

class Source:
    def __init__(self, path):
        self.path = pathlib.Path(path); self.doc = json.loads(self.path.read_text()); self.f = self.path.with_name(self.doc['buffers'][0]['uri']).open('rb'); self.mm = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
    def close(self): self.mm.close(); self.f.close()
    def setup(self, index):
        a=self.doc['accessors'][index]; v=self.doc['bufferViews'][a['bufferView']]; c={5121:('B',1),5123:('H',2),5125:('I',4),5126:('f',4)}[a['componentType']]; n={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']]; return a, v.get('byteOffset',0)+a.get('byteOffset',0), v.get('byteStride',c[1]*n), c[0], n
    def value(self,s,i): a,b,stride,fmt,n=s; return struct.unpack_from('<'+fmt*n,self.mm,b+i*stride)

def pick(src, primitive, target):
    pos=src.setup(primitive['attributes']['POSITION']); ind=src.setup(primitive['indices']); count=ind[0]['count']; bounds=src.doc['accessors'][primitive['attributes']['POSITION']]; lo,hi=bounds['min'][1],bounds['max'][1]; bands=96
    # Preserve contiguous source clusters. Random individual triangles retain
    # only a lace of needles because each source branch is a connected run of
    # small triangles; selecting complete runs keeps local volume and alpha
    # coverage while still imposing a deterministic budget.
    chunk_triangles = 300 if target > 10000 else 90
    chunk_indices = chunk_triangles * 3
    windows=[]
    for start in range(0, count, chunk_indices):
        end=min(count,start+chunk_indices); ids=[src.value(ind,i)[0] for i in range(start,end)]; ys=[src.value(pos,i)[1] for i in ids]; y=sum(ys)/len(ys); band=max(0,min(bands-1,int((y-lo)/max(hi-lo,1e-6)*bands))); windows.append((band,start,end))
    wanted=max(1,math.ceil(target/chunk_triangles)); quota=max(1,math.ceil(wanted/bands)); buckets=defaultdict(list); seen=defaultdict(int)
    for band,start,end in windows:
        seen[band]+=1; bucket=buckets[band]
        if len(bucket)<quota: bucket.append((start,end))
        else:
            n=(start*1664525+band*1013904223)&0xffffffff; slot=n%seen[band]
            if slot<quota: bucket[slot]=(start,end)
    out=[src.value(ind,t+i)[0] for bucket in buckets.values() for start,end in sorted(bucket) for t in range(start,end,3) for i in range(3)]
    return out[:target*3]

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output-dir',required=True); ap.add_argument('--prefix',default='pine_sapling_medium_canonical'); ap.add_argument('--atlas',required=True); args=ap.parse_args(); src=Source(args.input)
    try:
        mesh=src.doc['meshes'][0]; maps={0:Image.open(src.path.parent/'textures/pine_sapling_medium_bark_diff_1k.jpg').convert('RGB'),1:Image.open(src.path.parent/'textures/pine_sapling_medium_twig_diff_1k.jpg').convert('RGB'),2:Image.open(src.path.parent/'textures/pine_sapling_medium_twig_diff_1k.jpg').convert('RGB')}
        outputs={}
        for lod in (0,1):
            selected={}; sources={}
            for role,(pi,mat) in ROLE.items(): sources[role]=mesh['primitives'][pi]; selected[role]=pick(src,sources[role],TARGETS[lod][role])
            miny=min(src.value(src.setup(p['attributes']['POSITION']),i)[1] for role,p in sources.items() for i in selected[role]); pos=[]; nor=[]; col=[]; idx=[]; remap={}
            for role in ('bark','deadwood','foliage'):
                p=sources[role]; ps=src.setup(p['attributes']['POSITION']); ns=src.setup(p['attributes']['NORMAL']); uv=src.setup(p['attributes']['TEXCOORD_0']); atlas=maps[p['material']]
                for old in selected[role]:
                    key=(role,old)
                    # Merge close source needle vertices after reservoir
                    # selection. The source uses tiny disconnected alpha sheets;
                    # this 2.5 cm spatial weld keeps their volume while putting
                    # the hero below the old 510k-vertex cost.
                    x,y,z=src.value(ps,old); weld=(role,round(x/0.025),round(y/0.025),round(z/0.025)) if role=='foliage' else key
                    if weld not in remap:
                        remap[weld]=len(pos); nx,ny,nz=src.value(ns,old); u,v=src.value(uv,old); px=int(max(0,min(atlas.width-1,u%1*atlas.width))); py=int(max(0,min(atlas.height-1,(1-(v%1))*atlas.height))); r,g,b=atlas.getpixel((px,py));
                        # The tree shader identifies foliage by color chroma while
                        # retaining the source's natural bark/needle variation.
                        if role!='foliage': r,g,b=(max(r,35),max(g,16),max(b,7))
                        pos.append((x,y-miny,z)); nor.append((nx,ny,nz)); col.append((srgb(r),srgb(g),srgb(b),1.0))
                    idx.append(remap[weld])
            binary=bytearray(); views=[]; acc=[]
            def attr(payload,count,typ,minmax=None):
                st=align4(len(binary)); binary.extend(b'\0'*(st-len(binary))); binary.extend(payload); views.append({'buffer':0,'byteOffset':st,'byteLength':len(payload),'target':34962}); q={'bufferView':len(views)-1,'componentType':5126,'count':count,'type':typ};
                if minmax:q['min'],q['max']=minmax
                acc.append(q); return len(acc)-1
            bounds=([min(x[i] for x in pos) for i in range(3)],[max(x[i] for x in pos) for i in range(3)]); pa=attr(b''.join(struct.pack('<3f',*x) for x in pos),len(pos),'VEC3',bounds); na=attr(b''.join(struct.pack('<3f',*x) for x in nor),len(nor),'VEC3'); ca=attr(b''.join(struct.pack('<4f',*x) for x in col),len(col),'VEC4'); fmt='I' if len(pos)>=65536 else 'H'; typ=5125 if fmt=='I' else 5123; st=align4(len(binary)); binary.extend(b'\0'*(st-len(binary))); payload=struct.pack('<'+fmt*len(idx),*idx); binary.extend(payload); views.append({'buffer':0,'byteOffset':st,'byteLength':len(payload),'target':34963}); acc.append({'bufferView':len(views)-1,'componentType':typ,'count':len(idx),'type':'SCALAR'}); ii=len(acc)-1
            name=f'{args.prefix}_lod{lod}'; doc={'asset':{'version':'2.0','generator':'build_pine_sapling_canonical.py@1'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':name}],'meshes':[{'name':name,'primitives':[{'attributes':{'POSITION':pa,'NORMAL':na,'COLOR_0':ca},'indices':ii,'material':0}]}],'materials':[{'name':'pine_sapling_role_albedo_branches','doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':0.88}}],'buffers':[{'byteLength':len(binary)}],'bufferViews':views,'accessors':acc,'extras':{'sourceAsset':'polyhaven-pine-sapling-medium','sourceVariant':'a','sourceLicense':'CC0-1.0','lod':lod,'geometry':'source-needle-reservoir-v1','roles':['trunk','branches','foliage']}}
            js=json.dumps(doc,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4); bb=bytes(binary)+b'\0'*((4-len(binary)%4)%4); out=pathlib.Path(args.output_dir)/f'{name}.glb'; out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(struct.pack('<4sII',b'glTF',2,12+8+len(js)+8+len(bb))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(bb),0x004e4942)+bb); outputs[lod]={'vertices':len(pos),'triangles':len(idx)//3,'bounds':bounds}
            if lod==0:
                # Use the source's real albedo as a neutral, multi-azimuth far
                # representation. The runtime atlas shader supplies daylight.
                from PIL import ImageDraw
                size=512; result=Image.new('RGBA',(2048,1024),(0,0,0,0)); draw=ImageDraw.Draw(result,'RGBA'); triangles=[]
                for t in range(0,len(idx),3):
                    points=[]; dep=0
                    for j in idx[t:t+3]: x,y,z=pos[j]; points.append((x,y)); dep+=z
                    triangles.append((dep/3,points,col[idx[t]]))
                triangles.sort(key=lambda x:x[0]); scale=size*0.82/5.2
                for frame in range(8):
                    tile=Image.new('RGBA',(size,size),(0,0,0,0)); td=ImageDraw.Draw(tile,'RGBA'); angle=math.tau*frame/8; caa,saa=math.cos(angle),math.sin(angle)
                    # Approximate frame rotation in projection using source x/z.
                    for dep,points,c in triangles:
                        poly=[(int(size*.5+x*scale),int(size*.95-y*scale)) for x,y in points]; td.polygon(poly,fill=tuple(max(0,min(255,int(v*255))) for v in c[:3])+(255,))
                    result.alpha_composite(tile,(frame%4*size,(1-frame//4)*size))
                result.save(args.atlas,optimize=True)
        print(json.dumps(outputs,sort_keys=True))
    finally: src.close()
if __name__=='__main__': main()
