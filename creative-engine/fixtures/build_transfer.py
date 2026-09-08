"""Generate a MATERIALLY DIFFERENT test auction (broad estate) with TEST-OWNED synthetic source photos, so
the full pipeline (extraction -> classification -> selection -> placement -> audit -> QA) can be proven to
GENERALIZE beyond Heritage & Home. Objects are NOT manually positioned — the engine selects + places them.

Each source image is a simple opaque shape on a plain background (so the extraction matte yields a clean
single foreground at a controlled aspect ratio). No real merchandise is used or implied.
"""
import os, tempfile
from PIL import Image, ImageDraw


def _shape(path, w, h, kind):
    """Draw a single foreground object (~78% opaque, transparent corners so extraction yields CLEAN, not a
    hard box) on a plain background at the target aspect ratio (h/w). Appearance is irrelevant to the
    pipeline — only fidelity + aspect matter; these are test fixtures, not real merchandise."""
    img = Image.new('RGB', (w, h), (245, 245, 245))
    d = ImageDraw.Draw(img)
    col = {'tall': (150, 130, 90), 'wide': (110, 90, 70), 'cabinet': (70, 80, 95), 'framed': (120, 110, 90)}.get(kind, (90, 100, 120))
    m = int(min(w, h) * 0.06)
    d.ellipse([m, m, w - m, h - m], fill=col)   # ellipse → ~78.5% opaque, corners transparent, bbox aspect = h/w
    img.save(path, 'JPEG', quality=90)


def build(out_dir=None):
    out_dir = out_dir or tempfile.mkdtemp(prefix='adb_transfer_src_')
    # (lot_id, category, name, source w,h aspect kind, importance)
    lots = [
        ('a1', 'Fine art',   'Framed landscape print',   620, 760, 'framed',  0.8),
        ('f1', 'Furniture',  'Mahogany dresser',         820, 640, 'wide',    0.95),
        ('t1', 'Power tools','Rolling tool cabinet',      520, 640, 'cabinet', 0.9),
        ('l1', 'Lighting',   'Brass floor lamp',          220, 760, 'tall',    0.85),
        ('h1', 'Household',  'Stoneware pitcher',         360, 420, 'small',   0.6),
        ('c1', 'Collectibles','Cast-iron bank',           320, 360, 'small',   0.55),
        ('o1', 'Outdoor',    'Garden planter',            420, 360, 'small',   0.5),
    ]
    job_lots = []
    for lid, cat, name, w, h, kind, imp in lots:
        p = os.path.join(out_dir, f'src_{lid}.jpg')
        _shape(p, w, h, kind)
        job_lots.append(dict(lot_id=lid, cat=cat, name=name, source_image=p, importance=imp))
    job = dict(job_id='transfer-fixture', auction_id='TESTAUC1', formats=['4:5', '1:1'],
               catalog_families=['art', 'furniture', 'tools', 'lighting', 'household', 'collectibles', 'outdoor'],
               lots=job_lots)
    return job, out_dir


if __name__ == '__main__':
    import json
    job, _ = build()
    print(json.dumps(job, indent=1))
