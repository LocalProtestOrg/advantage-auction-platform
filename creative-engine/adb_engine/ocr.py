"""OCR engine for the creative runtime (Phase 3P.1 build blocker closed): RapidOCR on ONNX Runtime, run locally.

read(image_or_path, region=None, upscale=1.0) -> {available, engine, items: [{text, conf, box: [x0,y0,x1,y1]}]}
Used for: is_photograph / text contamination (media director), logo_source (the box must read ADVANTAGE.BID),
rendered_logo_elsewhere (no ADVANTAGE.BID string outside the box and the band wordmark), feed-proxy wordmark legibility
and capitalization hygiene on rendered headlines. When the engine cannot load, callers receive available:false and
report the check as unavailable — never as passed.
"""
import re
import numpy as np
from PIL import Image

_ENGINE = None
_ERR = None


def engine():
    global _ENGINE, _ERR
    if _ENGINE is None and _ERR is None:
        try:
            import logging
            from rapidocr_onnxruntime import RapidOCR
            logging.getLogger('RapidOCR').setLevel(logging.ERROR)
            _ENGINE = RapidOCR()
        except Exception as e:   # pragma: no cover - environment dependent
            _ERR = str(e)
    return _ENGINE


def available():
    return engine() is not None


def read(img, region=None, upscale=1.0, min_conf=0.5):
    eng = engine()
    if eng is None:
        return dict(available=False, engine='rapidocr-onnxruntime', error=_ERR, items=[])
    im = Image.open(img).convert('RGB') if isinstance(img, str) else img.convert('RGB')
    ox, oy = 0, 0
    if region:
        x, y, w, h = [int(round(v)) for v in region]
        x0, y0 = max(0, x), max(0, y)
        im = im.crop((x0, y0, min(im.width, x + w), min(im.height, y + h))); ox, oy = x0, y0
    if upscale and upscale != 1.0:
        im = im.resize((max(1, int(im.width * upscale)), max(1, int(im.height * upscale))), Image.LANCZOS)
    res, _ = eng(np.asarray(im))
    items = []
    for box, text, conf in (res or []):
        try: conf = float(conf)
        except Exception: conf = 0.0
        if conf < min_conf: continue
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        k = 1.0 / (upscale or 1.0)
        items.append(dict(text=str(text), conf=round(conf, 3), box=[int(min(xs) * k) + ox, int(min(ys) * k) + oy, int(max(xs) * k) + ox, int(max(ys) * k) + oy]))
    return dict(available=True, engine='rapidocr-onnxruntime', items=items)


def squash(s):
    """Normalise OCR text for brand matching: letters/digits only, upper-case ('GET THE ADVANTAGE' == 'GETTHEADVANTAGE')."""
    return re.sub(r'[^A-Z0-9]', '', str(s).upper())


BRAND_TOKENS = ('ADVANTAGEBID', 'ADVANTAGE8ID', 'ADVANTAGEB1D')   # tolerate the classic B/8 and I/1 OCR confusions


def is_brand_string(s):
    q = squash(s)
    return any(t in q for t in BRAND_TOKENS)
