"""Phase 3P.1 Mission 3 — walkthrough-video frame selection (tier 2 of the media hierarchy).

Nothing here invents video content: the pipeline only SELECTS a frame that exists and may apply the correction
whitelist (crop, straighten ≤ 3°, exposure, white balance, mild sharpen, downscale). The event binding (provenance) is
checked by Node BEFORE this runs; select() refuses without options.event_bound=True.

select(video_path, options) →
  decode metadata → sample (scene-change peaks + 1 fps, cap 300, exclude the first/last 1.5 s) → per-frame measures
  (Laplacian sharpness normalised to the video's 90th percentile, frame-difference motion, luminance/clipping/dark,
  skin-tone near-field obstruction proxy, OCR text on the shortlist, tilt, crop fit) → hard gates → scene clustering by
  perceptual signature → weighted ranking (config tier-2 weights) → shortlist ≤ 8 scene-diverse → the highest-scoring
  ready frame. The first frame is never chosen by position: every frame wins on score or not at all.
frames_iter may be injected (tests) as an iterable of (index, t_seconds, HxWx3 uint8).
"""
import os, subprocess, tempfile
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from . import ocr

WEIGHTS = dict(sharpness=15, motion_stability=10, exposure_and_colour=10, merchandise_visibility=20, obstruction_free=15, representative_value=15, aspect_suitability=15)
ALLOWED_CORRECTIONS = {'crop', 'straighten', 'exposure', 'white_balance', 'sharpen', 'downscale'}


class CorrectionRefused(Exception):
    pass


def apply_corrections(img, ops):
    """Correction whitelist (asset pipeline). Anything else — generative fill, inpainting, object removal,
    super-resolution > 1.25×, interpolation, HDR merge — is refused."""
    out = img
    for op in ops:
        kind = op.get('op')
        if kind not in ALLOWED_CORRECTIONS: raise CorrectionRefused('correction not allowed: %s' % kind)
        if kind == 'crop':
            x, y, w, h = op['box']; out = out.crop((x, y, x + w, y + h))
        elif kind == 'straighten':
            if abs(op.get('degrees', 0)) > 3: raise CorrectionRefused('straighten beyond 3 degrees')
            out = out.rotate(op['degrees'], resample=Image.BICUBIC, expand=False)
        elif kind == 'exposure':
            f = float(op.get('factor', 1.0))
            if not 0.7 <= f <= 1.4: raise CorrectionRefused('exposure change beyond the whitelist range')
            out = ImageEnhance.Brightness(out).enhance(f)
        elif kind == 'white_balance':
            a = np.asarray(out.convert('RGB')).astype(np.float32); m = a.reshape(-1, 3).mean(axis=0)
            a = np.clip(a * (m.mean() / np.maximum(m, 1)), 0, 255).astype(np.uint8); out = Image.fromarray(a)
        elif kind == 'sharpen':
            if op.get('radius', 1) > 1 or op.get('amount', 0.4) > 0.4: raise CorrectionRefused('sharpen beyond radius 1 / amount 40%')
            out = out.filter(ImageFilter.UnsharpMask(radius=op.get('radius', 1), percent=int(op.get('amount', 0.4) * 100), threshold=2))
        elif kind == 'downscale':
            k = float(op.get('factor', 1.0))
            if k > 1.25: raise CorrectionRefused('upscaling beyond 1.25x is not allowed')
            out = out.resize((max(1, int(out.width * k)), max(1, int(out.height * k))), Image.LANCZOS)
    return out


def _probe(path):
    import imageio_ffmpeg
    gen = imageio_ffmpeg.read_frames(path, output_params=['-vf', 'scale=320:-2'])
    meta = next(gen)
    return meta, gen


def _frames(path, sample_fps=None):
    meta, gen = _probe(path)
    W, H = meta['size']
    fps = float(meta.get('fps') or 30.0)
    for i, raw in enumerate(gen):
        yield i, i / fps, np.frombuffer(raw, np.uint8).reshape(H, W, 3), meta


def _luma(a):
    a = a.astype(np.float32); return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def _lap(g):
    g = g.astype(np.float64)
    return float((-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]).var())


def _skin_near_field(a):
    """Obstruction proxy: skin-tone pixels in the near field (bottom third + side strips). No detector ships; recorded."""
    r, g, b = [a[..., i].astype(np.int32) for i in range(3)]
    skin = (r > 95) & (g > 40) & (b > 20) & ((np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)) > 15) & (np.abs(r - g) > 15) & (r > g) & (r > b)
    return float(skin.mean())


def _tilt(g):
    gy, gx = np.gradient(g.astype(np.float64))
    ang = np.degrees(np.arctan2(gy, gx)); mag = np.hypot(gx, gy)
    strong = mag > np.percentile(mag, 90)
    a = ang[strong] % 90.0
    a = np.where(a > 45, a - 90, a)
    return float(np.median(a)) if a.size else 0.0


def _sig(a):
    im = Image.fromarray(a).convert('L').resize((12, 12), Image.BILINEAR)
    v = np.asarray(im).astype(np.float64).ravel(); v -= v.mean(); n = np.linalg.norm(v) or 1.0
    return v / n


def select(video_path=None, options=None, frames_iter=None):
    opts = options or {}
    if not opts.get('event_bound'):
        return dict(ok=False, error='refused: the video is not bound to the campaign event (provenance gate runs before decoding)')
    exclude_s = float(opts.get('exclude_edges_s', 1.5)); cap = int(opts.get('max_candidates', 300))
    frames = frames_iter if frames_iter is not None else (dict(i=i, t=t, a=a, meta=m) for i, t, a, m in _frames(video_path))
    cands, prev, diffs, meta, duration = [], None, [], {}, 0.0
    buf = []
    for f in frames:
        if isinstance(f, tuple): f = dict(i=f[0], t=f[1], a=f[2], meta={})
        meta = f.get('meta') or meta; duration = max(duration, f['t'])
        g = _luma(f['a'])
        d = float(np.abs(g - prev).mean()) if prev is not None else 0.0
        prev = g; diffs.append(d); buf.append(dict(i=f['i'], t=f['t'], a=f['a'], diff=d))
    if not buf: return dict(ok=False, error='no frames decoded')
    duration = max(duration, buf[-1]['t'])
    d_arr = np.array(diffs); thr = float(d_arr.mean() + 2 * d_arr.std()) if len(d_arr) > 2 else 1e9
    last_sec = -1
    for k, f in enumerate(buf):
        if f['t'] < exclude_s or f['t'] > duration - exclude_s: continue
        sec = int(f['t'])
        scene_change = f['diff'] > thr
        if sec != last_sec or scene_change:
            last_sec = sec
            nb = [buf[j]['diff'] for j in (k, k + 1) if j < len(buf)]
            f['motion'] = float(np.mean(nb)) if nb else 0.0
            cands.append(f)
        if len(cands) >= cap: break
    if not cands: return dict(ok=False, error='no candidates after excluding the first/last %.1f s' % exclude_s)
    laps = [_lap(_luma(c['a'])) for c in cands]; p90 = float(np.percentile(laps, 90)) or 1.0
    motions = [c['motion'] for c in cands]; mnorm = float(np.percentile(motions, 90)) or 1.0
    sigs = [_sig(c['a']) for c in cands]
    # scene clustering (greedy, signature distance)
    clusters = []
    for idx, sg in enumerate(sigs):
        for cl in clusters:
            if 1 - float(np.dot(sg, sigs[cl[0]])) < 0.25: cl.append(idx); break
        else: clusters.append([idx])
    cluster_of = {i: ci for ci, cl in enumerate(clusters) for i in cl}
    biggest = max(len(cl) for cl in clusters)
    scored = []
    for idx, c in enumerate(cands):
        a = c['a']; L = _luma(a)
        sharp = min(1.0, laps[idx] / p90); motion = min(1.0, c['motion'] / mnorm) if mnorm else 0.0
        clipped = float((L > 245).mean()) * 100; dark = float((L < 40).mean()) * 100; lum = float(L.mean())
        skin = _skin_near_field(a); tilt = _tilt(L)
        edges = np.asarray(Image.fromarray(a).convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float64)
        vis = min(1.0, edges.mean() / 30.0)                          # merchandise-visibility proxy (edge density); judge stands in for classes
        gates = dict(sharpness=sharp >= 0.30, motion=motion <= 0.25 or c['motion'] < 2.0, lighting=(90 <= lum <= 200 and clipped <= 6 and dark <= 25),
                     obstruction=skin <= 0.05, tilt=abs(tilt) <= 3.0)
        rep = len(clusters[cluster_of[idx]]) / float(biggest)
        score = (WEIGHTS['sharpness'] * sharp + WEIGHTS['motion_stability'] * (1 - min(1, motion)) +
                 WEIGHTS['exposure_and_colour'] * (1 - min(1, abs(lum - 140) / 80.0)) + WEIGHTS['merchandise_visibility'] * vis +
                 WEIGHTS['obstruction_free'] * (1 - min(1, skin / 0.05)) + WEIGHTS['representative_value'] * rep + WEIGHTS['aspect_suitability'] * 1.0)
        scored.append(dict(frame_index=c['i'], timestamp_ms=int(c['t'] * 1000), scene_cluster=cluster_of[idx], score=round(score, 1), gates=gates,
                           measures=dict(sharpness_norm=round(sharp, 3), motion_blur=round(motion, 3), luminance=round(lum, 1), clipped_pct=round(clipped, 2),
                                         dark_pct=round(dark, 2), skin_near_field=round(skin, 4), tilt_deg=round(tilt, 2), visibility_proxy=round(vis, 3)), _a=a))
    ready = [s for s in scored if all(s['gates'].values())]
    ready.sort(key=lambda s: -s['score'])
    shortlist, seen = [], set()
    for s in ready:
        if s['scene_cluster'] in seen: continue
        seen.add(s['scene_cluster']); shortlist.append(s)
        if len(shortlist) >= 8: break
    # OCR on the shortlist only (signage / seller marks → rejected; price tags allowed)
    final = []
    for s in shortlist:
        r = ocr.read(Image.fromarray(s['_a']), upscale=2.0) if opts.get('ocr', True) else dict(available=False, items=[])
        H_, W_ = s['_a'].shape[:2]
        big = [i['text'] for i in r['items'] if (i['box'][3] - i['box'][1]) >= 0.03 * H_ * 2.0 / 2.0 or len(i['text']) >= 6]
        s['gates']['text'] = not big; s['measures']['ocr_text'] = [i['text'] for i in r['items']][:8]
        if s['gates']['text']: final.append(s)
    for s in scored: s.pop('_a', None)
    selected = final[0] if final else None
    return dict(ok=True, video=os.path.basename(video_path) if video_path else 'injected', duration_s=round(duration, 2), fps=meta.get('fps'),
                candidates_sampled=len(cands), scene_clusters=len(clusters),
                shortlist=[dict({k: v for k, v in s.items() if k != '_a'}) for s in final],
                selected_frame_index=selected['frame_index'] if selected else None, selected_timestamp_ms=selected['timestamp_ms'] if selected else None,
                selection_method='score-ranked, scene-diverse; first/last %.1f s excluded; the first frame is never chosen by position' % exclude_s,
                ready=bool(selected), detector='none in runtime (skin-tone proxy for hands/people; the vision judge confirms clutter/obstruction on the shortlist)')


def extract_frame(video_path, timestamp_ms, out_png):
    """Full-resolution extraction of one selected frame (ffmpeg seek)."""
    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([exe, '-y', '-loglevel', 'error', '-ss', '%.3f' % (timestamp_ms / 1000.0), '-i', video_path, '-frames:v', '1', out_png], check=True)
    return out_png
