#!/usr/bin/env python3
"""Promote the reviewed v8 trial bytes without changing geometry or buffers.

Only the glTF JSON metadata is rewritten: production assets clear the trial flag
and carry a production generator label. PNG bytes and every GLB BIN chunk remain
byte-for-byte identical to the accepted candidate source.
"""

from __future__ import annotations

import json
import shutil
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/assets/trees_candidates/conifer_v8'
DEST = ROOT / 'public/assets/trees'
GENERATOR = 'build_conifer_v8@1-alpha-footprint-hulls-production'


def promote_glb(name: str) -> None:
    raw = (SOURCE / name).read_bytes()
    if raw[:4] != b'glTF' or struct.unpack_from('<I', raw, 4)[0] != 2:
        raise ValueError(f'{name} is not a glTF 2 binary')
    json_length = struct.unpack_from('<I', raw, 12)[0]
    old_json_end = 20 + json_length
    document = json.loads(raw[20:old_json_end])
    document['asset']['generator'] = GENERATOR
    document.setdefault('extras', {})['candidateOnly'] = False
    document['extras']['promotion'] = 'reviewed-v8-production'
    json_blob = json.dumps(document, separators=(',', ':')).encode('utf-8')
    json_blob += b' ' * ((4 - len(json_blob) % 4) % 4)
    binary = raw[old_json_end + 8:]
    total = 12 + 8 + len(json_blob) + 8 + len(binary)
    output = (
        b'glTF' + struct.pack('<I', 2) + struct.pack('<I', total)
        + struct.pack('<I', len(json_blob)) + struct.pack('<I', 0x4E4F534A) + json_blob
        + struct.pack('<I', len(binary)) + struct.pack('<I', 0x004E4942) + binary
    )
    (DEST / name).write_bytes(output)


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    for name in ('conifer_v8_macro_atlas.png', 'conifer_v8_impostor.png'):
        shutil.copyfile(SOURCE / name, DEST / name)
    for name in ('conifer_v8_lod0.glb', 'conifer_v8_lod1.glb'):
        promote_glb(name)
    metadata = json.loads((SOURCE / 'conifer_v8_impostor.json').read_text(encoding='utf-8'))
    metadata['candidateOnly'] = False
    metadata['generator'] = GENERATOR
    metadata['promotion'] = 'reviewed-v8-production'
    (DEST / 'conifer_v8_impostor.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
