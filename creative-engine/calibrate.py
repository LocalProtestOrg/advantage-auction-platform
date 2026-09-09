#!/usr/bin/env python
"""Phase 3P Node <-> Python contract for the reference-calibrated families (Pillow; no browser).

INPUT (JSON on stdin): { "op": "render" | "signature" | "pairwise" | "image_info", ... }
  render:     { "family": "ENVIRONMENTAL_PHOTO" | "ACQUISITION", "spec": {...} }  → { ok, png, thumb, boxes, metrics, drawn_text }
  signature:  { "paths": [...] }                                                  → { ok, signatures: { path: [..] } }
  pairwise:   { "paths": [...] }                                                  → { ok, distances: { "a|b": d } }
  image_info: { "paths": [...] }                                                  → { ok, info: { path: {width,height,light_pct,dark_pct,sat_pct} } }
Reference images are only ever read by 'signature' / 'image_info' (scorer / indexer). 'render' never receives them.
"""
import os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _image_info(path):
    from PIL import Image
    import numpy as np
    im = Image.open(path).convert('RGB')
    a = np.asarray(im.resize((256, int(256 * im.height / im.width) or 1))).astype(np.float32) / 255.0
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    hsv = np.asarray(im.convert('HSV').resize((256, int(256 * im.height / im.width) or 1))).astype(np.float32) / 255.0
    return dict(width=im.width, height=im.height, light_pct=round(100 * float((lum > 0.85).mean()), 1),
                dark_pct=round(100 * float((lum < 0.15).mean()), 1), sat_pct=round(100 * float((hsv[..., 1] > 0.45).mean()), 1))


def run(req):
    op = req.get('op')
    if op == 'render':
        fam = req.get('family'); spec = req.get('spec') or {}
        if fam == 'ENVIRONMENTAL_PHOTO':
            from adb_engine.families import environmental_photo as f
        elif fam == 'ACQUISITION':
            from adb_engine.families import acquisition as f
        else:
            return dict(ok=False, error='unknown family: ' + str(fam))
        return f.render(spec)
    if op == 'signature':
        from adb_engine import signature as S
        return dict(ok=True, signatures={p: S.signature(p) for p in req.get('paths', [])})
    if op == 'pairwise':
        from adb_engine import signature as S
        sigs, d = S.pairwise(req.get('paths', []))
        return dict(ok=True, distances=d)
    if op == 'image_info':
        return dict(ok=True, info={p: _image_info(p) for p in req.get('paths', [])})
    return dict(ok=False, error='unknown op: ' + str(op))


def main():
    try:
        raw = open(sys.argv[1]).read() if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else sys.stdin.read()
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps(dict(ok=False, error='bad input: ' + str(e)))); return 2
    try:
        print(json.dumps(run(req))); return 0
    except Exception as e:
        import traceback
        print(json.dumps(dict(ok=False, error='engine error: ' + str(e), trace=traceback.format_exc()[-800:]))); return 1


if __name__ == '__main__':
    sys.exit(main())
