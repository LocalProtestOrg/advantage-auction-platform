"""Phase 3P.1 — Owner headline capitalization, REFERENCE IMPLEMENTATION. Driven by config/capitalization-rules.json.
title_case(text, role) → text. Roles in apply_to_roles get title style; sentence_case_roles get sentence style; fixed tokens keep their casing."""
import json, os, re

CFG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "capitalization-rules.json")))
TC = CFG["title_case"]["lowercase_unless_first_or_last"]
SMALL = set(TC["articles"]) | set(TC["coordinating_conjunctions"]) | set(TC["short_prepositions_max_3_letters"]) | {"with"}
# 'with' is four letters; Chicago lowercases prepositions regardless of length — kept lowercase mid-line to match the Owner's natural style
FIXED = {t.lower(): t for t in CFG["fixed_case_tokens"]}

def _cap_word(w):
    """Capitalize a single word, respecting apostrophes, hyphens and fixed tokens."""
    low = w.lower()
    core = re.sub(r"^[^\w]+|[^\w.]+$", "", low)   # strip leading/trailing punctuation for lookup (keep dots for Advantage.Bid)
    if core in FIXED:
        return w.lower().replace(core, FIXED[core], 1)
    if "-" in w:
        return "-".join(_cap_word(p) if p else p for p in w.split("-"))
    m = re.match(r"^([^\w]*)(\w)(.*)$", w, re.S)
    if not m: return w
    return m.group(1) + m.group(2).upper() + m.group(3).lower()

def title_case(text, role="headline"):
    if role in CFG["sentence_case_roles"]:
        words = text.split(" ")
        out = []
        for i, w in enumerate(words):
            low = w.lower(); core = re.sub(r"^[^\w]+|[^\w.]+$", "", low)
            if core in FIXED: out.append(w.lower().replace(core, FIXED[core], 1))
            elif i == 0: out.append(_cap_word(w))
            else: out.append(w if w != w.upper() or len(w) <= 2 else w.lower())
        return " ".join(out)
    words = text.split(" ")
    n = len(words); out = []
    for i, w in enumerate(words):
        core = re.sub(r"^[^\w]+|[^\w]+$", "", w.lower())
        first_or_last = (i == 0 or i == n - 1)
        after_break = i > 0 and words[i - 1].endswith((":", "—", "–"))
        if not first_or_last and not after_break and core in SMALL and core not in FIXED:
            out.append(w.lower())
        else:
            out.append(_cap_word(w))
    return " ".join(out)

if __name__ == "__main__":
    ok = True
    for t in CFG["tests"]:
        got = title_case(t["in"], t.get("role", "headline"))
        flag = "PASS" if got == t["out"] else "FAIL"
        if flag == "FAIL": ok = False
        print(f"{flag}: {t['in']!r} → {got!r}" + ("" if flag == "PASS" else f"   expected {t['out']!r}"))
    print("ALL PASS" if ok else "FAILURES")
