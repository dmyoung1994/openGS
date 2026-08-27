#!/usr/bin/env python3
"""Download a BlenderKit asset's .blend via the public download API (no login).

Usage: python3 scripts/blenderkit_download.py <assetBaseId> <out.blend>
Resolves the asset version, picks the smallest .blend file, fetches the signed
URL, and streams the bytes. Prints the sha256 of the result for provenance.
"""
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid

# BlenderKit is now branded Blendkit, but the API remains compatible. Keep the
# host configurable so archived source-download workflows can be reproduced if
# the service changes its public domain again.
API = os.environ.get('BLENDERKIT_API', 'https://www.blendkit.com/api/v1')


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'golfsim-catalog/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    base, out = sys.argv[1], sys.argv[2]
    # Resolve the versioned asset id. Searching the base id text usually works;
    # when it doesn't, scan a few common tree queries for a base-id match.
    versioned = None
    # The public API's full-text search does not always index UUIDs. Accepting a
    # versioned id directly makes exact asset acquisition deterministic and avoids
    # accidentally downloading a visually similar result.
    try:
        direct = get(f'{API}/assets/{base}/')
        if direct.get('id') == base:
            versioned = base
    except Exception:
        pass
    queries = [base] + (sys.argv[3].split(',') if len(sys.argv) > 3 else [])
    for q in queries if not versioned else []:
        for page in (1, 2, 3):
            try:
                d = get(f'{API}/search/?query={urllib.parse.quote(q)}&page={page}')
            except Exception:
                break
            for r in d.get('results', []):
                if r.get('assetBaseId') == base:
                    versioned = r['id']
                    break
            if versioned or not d.get('next'):
                break
        if versioned:
            break
    if not versioned:
        raise SystemExit(f'could not resolve versioned id for base {base}')
    det = get(f'{API}/assets/{versioned}/')
    blends = [f for f in det.get('files', []) if f.get('fileType') == 'blend']
    if not blends:
        raise SystemExit(f'no blend file for {det.get("name")}')
    blend = min(blends, key=lambda f: f.get('fileUploadSize', 10**12))
    signed = get(f'{API}/downloads/{blend["id"]}/?scene_uuid={uuid.uuid4()}')
    url = signed['filePath']
    print(f'{det["name"]}: {blend["fileUploadSize"]/1e6:.1f} MB <- {url[:80]}...')
    req = urllib.request.Request(url, headers={'User-Agent': 'golfsim-catalog/1.0'})
    h = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=600) as r, open(out, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    print(f'wrote {out} sha256={h.hexdigest()}')


if __name__ == '__main__':
    main()
