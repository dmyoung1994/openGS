#!/usr/bin/env python3
"""Search BlenderKit's public API for tree assets and rank the free ones.

Usage: python3 scripts/blenderkit_search.py [query ...]
Prints: name | assetBaseId | rating | blend file id+size | access
"""
import json
import sys
import urllib.parse
import urllib.request

API = 'https://www.blenderkit.com/api/v1'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'golfsim-catalog/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    queries = sys.argv[1:] or ['fir tree', 'spruce', 'douglas fir', 'pine tree', 'larch']
    seen = {}
    for q in queries:
        page = 1
        while page <= 2:
            try:
                d = get(f'{API}/search/?query={urllib.parse.quote(q)}&page={page}')
            except Exception as e:
                print(f'!! {q} p{page}: {e}', file=sys.stderr)
                break
            for r in d.get('results', []):
                base = r.get('assetBaseId')
                if not base or base in seen:
                    continue
                seen[base] = r
            if not d.get('next'):
                break
            page += 1

    rows = []
    for base, r in seen.items():
        try:
            det = get(f'{API}/assets/{r["id"]}/')
        except Exception:
            continue
        files = [f for f in det.get('files', []) if f.get('fileType') == 'blend']
        blend = min(files, key=lambda f: f.get('fileUploadSize', 10**12)) if files else None
        rows.append({
            'name': det.get('name'),
            'base': base,
            'free': det.get('isFree'),
            'access': det.get('access'),
            'rating': (det.get('ratingsAverage') or {}).get('rating') if isinstance(det.get('ratingsAverage'), dict) else det.get('ratingsAverage'),
            'ratingCount': det.get('ratingsCount'),
            'license': det.get('license'),
            'blendId': blend['id'] if blend else None,
            'blendMB': round(blend['fileUploadSize'] / 1e6, 1) if blend else None,
            'hasGltf': any(f.get('fileType') == 'gltf' for f in det.get('files', [])),
        })

    rows.sort(key=lambda x: (not x['free'], -(float(x['rating']) if x['rating'] is not None else 0)))
    print(f'{"NAME":45} {"FREE":5} {"RATING":>8} {"N":>5} {"BLEND_MB":>9} GLB')
    for x in rows:
        print(f'{(x["name"] or "?")[:45]:45} {str(x["free"]):5} {str(x["rating"] or "-"):>8} '
              f'{str(x["ratingCount"] or 0):>5} {str(x["blendMB"] or "-"):>9} {str(x["hasGltf"])}')
        print(f'    base={x["base"]} blendId={x["blendId"]} access={x["access"]} lic={x["license"]}')


if __name__ == '__main__':
    main()
