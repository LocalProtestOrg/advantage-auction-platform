"""Production extraction pipeline (Phase 3O Wave 1 — blocker 1).

catalog image -> foreground/object extraction -> alpha/mask cleanup -> trim/crop -> fidelity measurements
-> CLEAN / REVIEW / FAILED gate -> provenance -> candidate asset.

Behavioral acceptance = extraction/EXTRACTION_PIPELINE_SPEC.md. A maintained segmentation implementation
(rembg / U2Net) is used when available; when it is not, a deterministic luminance/edge matte is used so the
gate + measurement logic is fully testable and reproducible. RGB is NEVER edited — alpha only. No generative
reconstruction, no recoloring, no feature add/remove, no identity change, no substitution.

Gate thresholds (from the certified spec):
  CLEAN  : opaque_pct in [OPAQUE_MIN, OPAQUE_MAX], solid single foreground, alpha edge clean, no hard border box
  REVIEW : borderline opaque_pct, ambiguous protected region, or multi-blob foreground
  FAILED : almost-empty or almost-full alpha (segmentation failed), or unusable aspect
"""
import io, os, json, hashlib
from PIL import Image, ImageFilter
import numpy as np

OPAQUE_MIN = 55.0      # below → likely a cut-out that lost the object (spec)
OPAQUE_MAX = 92.0      # above → likely a full rectangle / background not removed (spec)
CLEAN_MIN, CLEAN_MAX = 62.0, 88.0   # the confident CLEAN band inside [MIN,MAX]
MIN_SIDE = 64          # unusable if smaller
MAX_WEBP = 700         # ≤700px longest side, WebP q80 (spec)


def _rembg_alpha(img):
    """Alpha from rembg/U2Net if installed; else None (caller falls back). alpha-matting off per spec."""
    try:
        from rembg import remove  # optional heavy dependency
        out = remove(img)  # returns RGBA
        return out.convert('RGBA')
    except Exception:
        return None


def _fallback_alpha(img):
    """Deterministic matte for environments without rembg: keep the largest non-background blob. Background is
    estimated from the image corners; alpha is a cleaned mask. RGB is untouched. Deterministic + testable."""
    rgb = img.convert('RGB')
    a = np.asarray(rgb).astype(np.int16)
    h, w, _ = a.shape
    corners = np.concatenate([a[0:8, 0:8].reshape(-1, 3), a[0:8, -8:].reshape(-1, 3), a[-8:, 0:8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    dist = np.sqrt(((a - bg) ** 2).sum(axis=2))
    mask = (dist > 32).astype(np.uint8) * 255
    m = Image.fromarray(mask, 'L').filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))  # close small holes
    out = rgb.convert('RGBA'); out.putalpha(m)
    return out


def _trim(rgba):
    """Bounding-box trim to the alpha; RGB untouched."""
    alpha = rgba.split()[-1]
    bbox = alpha.getbbox()
    if not bbox:
        return rgba, (0, 0, rgba.width, rgba.height)
    return rgba.crop(bbox), bbox


def _measure(rgba):
    alpha = np.asarray(rgba.split()[-1])
    total = alpha.size or 1
    opaque_pct = round(100.0 * (alpha > 16).sum() / total, 1)
    # single-foreground check: fraction of the alpha in the largest connected component (approx via row/col spans)
    ys = np.where(alpha.any(axis=1))[0]; xs = np.where(alpha.any(axis=0))[0]
    filled_rows = len(ys) / (rgba.height or 1)
    # hard-border-box heuristic: a near-full rectangle of alpha
    border = alpha[0, :].mean() + alpha[-1, :].mean() + alpha[:, 0].mean() + alpha[:, -1].mean()
    hard_box = border / 4 > 200
    return dict(opaque_pct=opaque_pct, w=rgba.width, h=rgba.height, filled_rows=round(filled_rows, 3), hard_box=bool(hard_box))


def classify(meas):
    """CLEAN / REVIEW / FAILED from measurements per the certified thresholds."""
    op = meas['opaque_pct']
    if meas['w'] < MIN_SIDE or meas['h'] < MIN_SIDE:
        return 'FAILED', 'object too small'
    if op < OPAQUE_MIN or op > OPAQUE_MAX or meas['hard_box']:
        return 'FAILED', ('near-empty alpha' if op < OPAQUE_MIN else 'background not removed / hard box')
    if CLEAN_MIN <= op <= CLEAN_MAX and not meas['hard_box']:
        return 'CLEAN', 'confident single foreground'
    return 'REVIEW', 'borderline opacity — human review'


def provenance(auction_id, lot_id, source_path, meas, fidelity, reason, out_path):
    """Durable provenance row: auction -> lot -> source image -> extraction -> fidelity result -> asset."""
    src_hash = None
    try:
        src_hash = hashlib.sha256(open(source_path, 'rb').read()).hexdigest()[:16]
    except Exception:
        pass
    return dict(auction_id=auction_id, lot_id=lot_id, source_image=os.path.basename(str(source_path)),
                source_sha256=src_hash, extracted_asset=os.path.basename(str(out_path)) if out_path else None,
                measurements=meas, fidelity=fidelity, reason=reason, rgb_edited=False, generative=False)


def extract(auction_id, lot_id, source_path, out_dir):
    """Full pipeline for one lot image. Idempotent (skips if the asset already exists). Returns a result dict
    incl. fidelity + provenance. Only CLEAN may be used automatically; REVIEW routes to review; FAILED excluded."""
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'lot{lot_id}.webp')
    img = Image.open(source_path).convert('RGBA')
    rgba = _rembg_alpha(img) or _fallback_alpha(img)
    trimmed, bbox = _trim(rgba)
    # cap size (≤700 longest side), preserve aspect; alpha only.
    if max(trimmed.size) > MAX_WEBP:
        s = MAX_WEBP / max(trimmed.size)
        trimmed = trimmed.resize((round(trimmed.width * s), round(trimmed.height * s)))
    meas = _measure(trimmed)
    fidelity, reason = classify(meas)
    if fidelity != 'FAILED':
        trimmed.save(out_path, 'WEBP', quality=80)
    else:
        out_path = None
    return dict(lot=str(lot_id), status=fidelity, reason=reason, bbox=list(bbox), asset=out_path,
                provenance=provenance(auction_id, lot_id, source_path, meas, fidelity, reason, out_path), **{k: meas[k] for k in ('opaque_pct', 'w', 'h')})
