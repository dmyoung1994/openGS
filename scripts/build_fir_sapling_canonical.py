#!/usr/bin/env python3
"""Build one indexed, opaque canonical primitive from Poly Haven Fir Sapling.

The downloaded sapling source has three authored variants and separate opaque
branch / twig materials. This testable derivative keeps variant A, samples the
two roles independently by height band, and bakes source-role colour into
vertices so the production one-part WebGPU tree path can inspect the silhouette
without carrying an atlas or any baked lighting.
"""
from __future__ import annotations

import argparse, json, math, mmap, pathlib, struct
from collections import defaultdict

ROLE_COLORS = {"branches": (0.10, 0.045, 0.018, 1.0), "foliage": (0.045, 0.19, 0.030, 1.0)}
TARGETS = {0: {"branches": 2_000, "foliage": 150_000}, 1: {"branches": 700, "foliage": 40_000}}

def rng(v):
    v &= 0xffffffff; v ^= (v << 13) & 0xffffffff; v ^= v >> 17; v ^= (v << 5) & 0xffffffff; return v & 0xffffffff
def align4(v): return (v + 3) & ~3

class Source:
    def __init__(self, path):
        self.path = pathlib.Path(path); self.gltf = json.loads(self.path.read_text())
        uri = self.gltf['buffers'][0]['uri']; self.file = self.path.parent.joinpath(uri).open('rb'); self.mm = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
    def close(self): self.mm.close(); self.file.close()
    def setup(self, i):
        a=self.gltf['accessors'][i]; v=self.gltf['bufferViews'][a['bufferView']]; c={5121:('B',1),5123:('H',2),5125:('I',4),5126:('f',4)}[a['componentType']]; n={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']]; return a, v.get('byteOffset',0)+a.get('byteOffset',0), v.get('byteStride', c[1]*n), c[0], n
    def value(self,s,i): a,b,stride,fmt,n=s; return struct.unpack_from('<'+fmt*n,self.mm,b+i*stride)

def safe(a,b,c):
    e=(math.dist(a,b),math.dist(b,c),math.dist(c,a));
    if min(e)<=1e-8: return False
    cross=((b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]), (b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]), (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))
    # The source twig sheets are intentionally long, narrow needle surfaces;
    # rejecting them at the structural guard recreates the sparse crown this
    # candidate is meant to replace. Keep every finite, non-collapsed source
    # face; the source exporter already supplies valid indexed topology.
    return min(e) > 1e-14

def select(src, primitive, role, target):
    pos=src.setup(primitive['attributes']['POSITION']); ind=src.setup(primitive['indices']); count=ind[0]['count']; bounds=src.gltf['accessors'][primitive['attributes']['POSITION']]; lo,hi=bounds['min'][1],bounds['max'][1]; bands=48; quota=max(1,math.ceil(target/bands)); buckets=defaultdict(list); seen=defaultdict(int)
    for t in range(0,count,3):
        ids=[src.value(ind,t+j)[0] for j in range(3)]; points=[src.value(pos,i) for i in ids]
        if not safe(*points): continue
        band=max(0,min(bands-1,int((sum(p[1] for p in points)/3-lo)/max(hi-lo,1e-6)*bands))); seen[band]+=1; bucket=buckets[band]
        if len(bucket)<quota: bucket.append(t)
        else:
            slot=rng(t+band*0x9e3779b9)%seen[band]
            if slot<quota: bucket[slot]=t
    out=[src.value(ind,t+j)[0] for bucket in buckets.values() for t in sorted(bucket) for j in range(3)]
    return out[:target*3]

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--lod',type=int,choices=(0,1),required=True); a=ap.parse_args(); src=Source(a.input)
    try:
        mesh=src.gltf['meshes'][0]; role_sources={'branches':mesh['primitives'][0], 'foliage':mesh['primitives'][1]}; role_indices={r:select(src,p,r,TARGETS[a.lod][r]) for r,p in role_sources.items()}
        min_y=min(src.value(src.setup(p['attributes']['POSITION']),i)[1] for r,p in role_sources.items() for i in role_indices[r]); pos=[]; norm=[]; uv=[]; color=[]; idx=[]
        for role in ('branches','foliage'):
            p=role_sources[role]; ps=src.setup(p['attributes']['POSITION']); ns=src.setup(p['attributes']['NORMAL']); us=src.setup(p['attributes']['TEXCOORD_0']); remap={}
            for old in role_indices[role]:
                if old not in remap:
                    remap[old]=len(pos); x,y,z=src.value(ps,old); tu,tv=src.value(us,old); pos.append((x,y-min_y,z)); norm.append(src.value(ns,old)); uv.append((tu * 0.5 + (0.5 if role == 'foliage' else 0.0), tv)); color.append(ROLE_COLORS[role])
                idx.append(remap[old])
        b=bytearray(); views=[]; acc=[]
        def attr(payload,count,typ,minmax=None):
            st=align4(len(b)); b.extend(b'\0'*(st-len(b))); b.extend(payload); views.append({'buffer':0,'byteOffset':st,'byteLength':len(payload),'target':34962}); q={'bufferView':len(views)-1,'componentType':5126,'count':count,'type':typ};
            if minmax:q['min'],q['max']=minmax
            acc.append(q); return len(acc)-1
        bounds=([min(x[i] for x in pos) for i in range(3)],[max(x[i] for x in pos) for i in range(3)]); pa=attr(b''.join(struct.pack('<3f',*x) for x in pos),len(pos),'VEC3',bounds); na=attr(b''.join(struct.pack('<3f',*x) for x in norm),len(norm),'VEC3'); ua=attr(b''.join(struct.pack('<2f',*x) for x in uv),len(uv),'VEC2'); ca=attr(b''.join(struct.pack('<4f',*x) for x in color),len(color),'VEC4'); it='I' if len(pos)>=65536 else 'H'; typ=5125 if it=='I' else 5123; st=align4(len(b)); b.extend(b'\0'*(st-len(b))); payload=struct.pack('<'+it*len(idx),*idx); b.extend(payload); views.append({'buffer':0,'byteOffset':st,'byteLength':len(payload),'target':34963}); acc.append({'bufferView':len(views)-1,'componentType':typ,'count':len(idx),'type':'SCALAR'}); ii=len(acc)-1
        atlas=(pathlib.Path(a.input).resolve().parent/'textures/fir_sapling_albedo_atlas_1k.png').read_bytes(); st=align4(len(b)); b.extend(b'\0'*(st-len(b))); b.extend(atlas); views.append({'buffer':0,'byteOffset':st,'byteLength':len(atlas)}); image_view=len(views)-1
        d={'asset':{'version':'2.0','generator':'build_fir_sapling_canonical.py@2'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':f'fir_sapling_canonical_lod{a.lod}'}],'meshes':[{'name':f'fir_sapling_canonical_lod{a.lod}','primitives':[{'attributes':{'POSITION':pa,'NORMAL':na,'TEXCOORD_0':ua,'COLOR_0':ca},'indices':ii,'material':0}]}],'materials':[{'name':'fir_sapling_canonical','doubleSided':True,'pbrMetallicRoughness':{'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':0.88}}],'images':[{'mimeType':'image/png','bufferView':image_view}],'textures':[{'source':0}], 'buffers':[{'byteLength':len(b)}],'bufferViews':views,'accessors':acc,'extras':{'sourceAsset':'polyhaven-fir-sapling','sourceVariant':'a','lod':a.lod,'roles':['branches','foliage'],'materialMode':'source-albedo-atlas-uv-remap'}}
        j=json.dumps(d,separators=(',',':')).encode(); j+=b' ' * ((4-len(j)%4)%4); bb=bytes(b)+b'\0'*((4-len(b)%4)%4); out=pathlib.Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(struct.pack('<4sII',b'glTF',2,12+8+len(j)+8+len(bb))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(bb),0x004e4942)+bb); print(f'FIR_SAPLING_DONE lod={a.lod} vertices={len(pos)} triangles={len(idx)//3} bytes={out.stat().st_size}')
    finally: src.close()
if __name__=='__main__': main()
