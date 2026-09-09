"""Perceptual layout signature (Phase 3P anti-similarity, gate G11).

signature(path) → a deterministic vector describing WHERE light/dark, colour and edges sit on the canvas: 12x12 grids
of luminance mean, saturation mean and edge density (mean-centred per channel) plus a coarse global shape. Two
renders of the same layout with swapped merchandise stay close; a reference image submitted as a candidate has
distance 0 to itself; a crop / recolour of a reference stays well under the reference threshold; genuinely different
layouts sit far apart. Distance = cosine distance in [0, 2] (0 = identical). Thresholds live in config, not here.
"""
import numpy as np
from PIL import Image

GRID = 12


def _grid_mean(a, g=GRID):
    H, W = a.shape[:2]
    H2, W2 = (H // g) * g, (W // g) * g
    a = a[:H2, :W2]
    return a.reshape(g, H2 // g, g, W2 // g).mean(axis=(1, 3))


def signature(path, size=192):
    im = Image.open(path).convert('RGB').resize((size, size), Image.BILINEAR)
    rgb = np.asarray(im).astype(np.float32) / 255.0
    lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    hsv = np.asarray(im.convert('HSV')).astype(np.float32) / 255.0
    sat = hsv[..., 1]
    gy, gx = np.gradient(lum)
    edge = np.sqrt(gx * gx + gy * gy)
    parts = []
    for ch in (lum, sat, edge):
        g = _grid_mean(ch).flatten()
        parts.append(g - g.mean())
    vec = np.concatenate(parts)
    # global shape descriptors (kept small so the grids dominate)
    glob = np.array([lum.mean() - 0.5, sat.mean() - 0.5, (lum > 0.85).mean() - 0.5, (lum < 0.15).mean() - 0.5], np.float32)
    return np.concatenate([vec, glob]).round(5).tolist()


def distance(a, b):
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0: return 1.0
    d = float(round(1.0 - float(np.dot(a, b) / (na * nb)), 4))
    return 0.0 if d == 0 else d


def pairwise(paths):
    sigs = {p: signature(p) for p in paths}
    out = {}
    for i, p in enumerate(paths):
        for q in paths[i + 1:]:
            out[p + '|' + q] = distance(sigs[p], sigs[q])
    return sigs, out
