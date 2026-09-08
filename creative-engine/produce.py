#!/usr/bin/env python
"""Autonomous creative production job — the Node <-> Python contract (Phase 3O Wave 1, blocker 5).

INPUT (JSON on stdin, or a path arg):
  { "job_id": str, "auction_id": str, "formats": ["4:5","1:1"], "assets_dir": str(optional pre-extracted),
    "catalog_families": [..], "lots": [ {"lot_id","cat","name","source_image"(optional),
                                          "w","h","status"(optional if pre-extracted)} ] }
OUTPUT (JSON on stdout):
  { "ok": bool, "job_id", "auction_id", "runtime_version", "extraction":[...], "clean":[...], "review":[...],
    "failed":[...], "selection":[...], "audit":{...}, "qa":{...}, "creative":{...}, "provenance":[...],
    "error"(on failure) }

The pipeline: extraction -> fidelity CLEAN/REVIEW/FAILED -> selection -> protected derivation -> automatic
placement (audited by the shipped spatial.py) -> thumbnail/feed QA -> creative result + provenance. Only
CLEAN objects are used automatically; REVIEW is surfaced (routed to controlled review); FAILED excluded.
No merchandise is invented; RGB is never edited.
"""
import os, sys, json, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'runtime'))
sys.path.insert(0, HERE)
import compose, spatial  # noqa: E402
from adb_engine import extraction, selection, placement, protected, qa  # noqa: E402

RUNTIME_VERSION = '3M.3+wave1'


def _brand_layers():
    """Minimal Owner-approved brand-frame layers: logo + presenter kicker + primary title + support line +
    essential event info. Text/logo layers are ignored by spatial.audit (it audits kind=='obj' only) but feed
    the text-budget QA. Exactly 5 copy blocks max (logo + footer wordmark excluded)."""
    L = [dict(kind='logo', logo=True, text='', x=(1080 - 250) // 2, y=50, w=250)]
    L.append(dict(kind='text', text='ADVANTAGE.BID PRESENTS', x=0, y=130, w=1080))
    L.append(dict(kind='text', text='Estate Auction', x=0, y=170, w=1080))
    L.append(dict(kind='text', text='Antiques, Furniture, Lighting & More', x=0, y=360, w=1080))
    L.append(dict(kind='text', text='Bidding opens Friday - advantage.bid', x=0, y=470, w=1080))
    return L


def _text_boxes():
    return [dict(text='ADVANTAGE.BID PRESENTS'), dict(text='Estate Auction'),
            dict(text='Antiques, Furniture, Lighting & More'), dict(text='Bidding opens Friday - advantage.bid'),
            dict(logo=True, text=''), dict(text='Advantage.Bid')]


def run(job):
    auction_id = job.get('auction_id')
    assets_dir = job.get('assets_dir')
    formats = job.get('formats') or ['4:5', '1:1']
    catalog_families = set(job.get('catalog_families') or [])
    work_assets = assets_dir or tempfile.mkdtemp(prefix='adb_creative_')
    compose.ASSETS = work_assets

    extraction_results, clean, review, failed = [], [], [], []
    for lot in job.get('lots', []):
        lid = str(lot['lot_id'])
        if lot.get('source_image'):
            res = extraction.extract(auction_id, lid, lot['source_image'], work_assets)
        else:
            # pre-extracted asset already present in assets_dir; trust the provided status/dims.
            res = dict(lot=lid, status=lot.get('status', 'CLEAN'), reason='pre-extracted',
                       opaque_pct=lot.get('opaque_pct', 75.0), w=lot.get('w'), h=lot.get('h'),
                       provenance=dict(auction_id=auction_id, lot_id=lid, source_image=lot.get('source_image'),
                                       extracted_asset=f'lot{lid}.webp', fidelity=lot.get('status', 'CLEAN'), rgb_edited=False, generative=False))
        res['cat'] = lot.get('cat'); res['name'] = lot.get('name'); res['importance'] = lot.get('importance', 0.5)
        extraction_results.append(res)
        # Register into the shipped inventory so compose/spatial can use it. CLEAN only for auto use.
        compose.INV[lid] = dict(name=lot.get('name') or lid, cat=lot.get('cat'), status=res['status'],
                                w=res.get('w') or lot.get('w'), h=res.get('h') or lot.get('h'),
                                bbox=[0, 0, res.get('w') or lot.get('w'), res.get('h') or lot.get('h')], opaque_pct=res.get('opaque_pct'))
        if res['status'] == 'CLEAN':
            pr = protected.apply_to_spatial(spatial, lid, lot.get('cat'))
            if pr == 'REVIEW':
                res['status'] = 'REVIEW'; res['reason'] = 'ambiguous protected region — review'; review.append(res); continue
            clean.append(dict(lot=lid, cat=lot.get('cat'), name=lot.get('name'), w=res.get('w') or lot.get('w'), h=res.get('h') or lot.get('h'), importance=lot.get('importance', 0.5)))
        elif res['status'] == 'REVIEW':
            review.append(res)
        else:
            failed.append(res)

    if not clean:
        return dict(ok=False, error='no CLEAN merchandise available for automatic creative', extraction=extraction_results, review=review, failed=failed)

    sel = selection.select(clean)
    name = f'auction_{auction_id}'
    comp, audit_summary, rows = placement.place(name, sel, compose.INV, _brand_layers())
    if comp is None:
        return dict(ok=False, error='no composition passed the spatial audit (routed to REVIEW)',
                    audit=audit_summary, selection=sel, extraction=extraction_results)
    qa_result = qa.qa_all(comp, _text_boxes(), tuple(formats), catalog_families)

    creative = dict(name=name, size=comp['size'], object_lots=[L['lot'] for L in comp['layers'] if L.get('kind') == 'obj'],
                    formats=formats, runtime_version=RUNTIME_VERSION)
    provenance = [r.get('provenance') for r in extraction_results if r.get('provenance')]
    return dict(ok=(not audit_summary['violations']) and qa_result['pass'], job_id=job.get('job_id'), auction_id=auction_id,
                runtime_version=RUNTIME_VERSION, extraction=extraction_results,
                clean=[c['lot'] for c in clean], review=[r['lot'] for r in review], failed=[f['lot'] for f in failed],
                selection=sel, audit=audit_summary, qa=qa_result, creative=creative, provenance=provenance)


def main():
    try:
        raw = open(sys.argv[1]).read() if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else sys.stdin.read()
        job = json.loads(raw)
    except Exception as e:
        print(json.dumps(dict(ok=False, error='bad input: ' + str(e)))); return 2
    try:
        print(json.dumps(run(job)))
        return 0
    except Exception as e:
        print(json.dumps(dict(ok=False, error='engine error: ' + str(e)))); return 1


if __name__ == '__main__':
    sys.exit(main())
