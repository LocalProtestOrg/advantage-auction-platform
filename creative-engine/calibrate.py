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


def _jsonable(o):
    import numpy as np
    if isinstance(o, dict): return {str(k): _jsonable(v) for k, v in o.items() if not str(k).startswith('_')}
    if isinstance(o, (list, tuple)): return [_jsonable(v) for v in o]
    if isinstance(o, (np.bool_,)): return bool(o)
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (np.floating,)): return float(o)
    if isinstance(o, np.ndarray): return None
    return o


def run(req):
    op = req.get('op')
    if op == 'render':
        fam = req.get('family'); spec = req.get('spec') or {}
        if fam in ('ENVIRONMENTAL_PHOTO', 'ACQUISITION') and not spec.get('regression_anchor'):
            # Phase 3P.2: the 3P renderers composited an unregistered logo file — they run ONLY to reproduce the
            # 2026-09-09 regression anchors for v2 scoring, never to produce a new creative.
            return dict(ok=False, error='legacy 3P family %s is regression-only (pass regression_anchor:true); use EDITORIAL / EVENT_PHOTO' % fam)
        if fam == 'ENVIRONMENTAL_PHOTO':
            from adb_engine.families import environmental_photo as f
        elif fam == 'ACQUISITION':
            from adb_engine.families import acquisition as f
        elif fam == 'EDITORIAL':
            from adb_engine.families import editorial as f
        elif fam == 'EVENT_PHOTO':
            from adb_engine.families import event_photo as f
        else:
            return dict(ok=False, error='unknown family: ' + str(fam))
        return _jsonable(f.render(spec))
    if op == 'plan':
        from adb_engine import scene_planner as SP
        return _jsonable(SP.plan(req['objects'], req['field'], tuple(req['canvas']), family=req.get('family', 'ACQUISITION'), arrangement=req.get('arrangement', 'anchor_right'),
                                 copy_regions=req.get('copy_regions') or [], declared=req.get('declared') or [], options=req.get('options') or {}))
    if op == 'physical_audit':
        from adb_engine import physical_audit as PA
        return _jsonable(dict(ok=True, **PA.audit(req['scene'])))
    if op == 'taxonomy':
        from adb_engine import taxonomy as TX
        return dict(ok=True, resolved=[TX.resolve(o.get('title'), o.get('category_key'), o.get('dims_in'), o.get('semantic_class')) for o in req.get('objects', [])],
                    unresolved_support_refs=TX.support_references_resolve())
    if op == 'ocr':
        from adb_engine import ocr as O
        return dict(ok=True, results={p: O.read(p, region=req.get('region'), upscale=req.get('upscale', 1.0)) for p in req.get('paths', [])})
    if op == 'logo_registry':
        from adb_engine import logo_stage as LS
        r = LS.registry(); return dict(ok=not r['problems'], variants={k: dict(file=v['file'], sha256=v['sha256'], verified=v['verified']) for k, v in r['variants'].items()},
                                       problems=r['problems'], unregistered_files=r['unregistered_files'])
    if op == 'logo_scan':
        from adb_engine import logo_stage as LS
        from PIL import Image
        out = {}
        for p in req.get('paths', []):
            im = Image.open(p).convert('RGBA'); q = LS.qa(im, dict(ok=True, box=[0, 0, 1, 1], variant='primary_transparent', sha256='', _ground=None)) if False else None
            from adb_engine import ocr as O
            r = O.read(im); out[p] = dict(ocr_brand_hits=[i for i in r['items'] if O.is_brand_string(i['text'])], ocr_available=r['available'])
        return dict(ok=True, results=out)
    if op == 'media_measure':
        from adb_engine import media_measures as MM
        return _jsonable(dict(ok=True, results=MM.measure_set(req.get('paths', []), req.get('options') or {})))
    if op == 'video_select':
        from adb_engine import video_frames as VF
        return _jsonable(VF.select(req['video_path'], req.get('options') or {}))
    if op == 'regression_analyse':
        from adb_engine import regression as RG
        return _jsonable(RG.analyse(req))
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
