# Seller agreement page showed raw JavaScript (incident, 2026-10-30)

## What happened
The agreement invitation sent to tyler@lmauctionco.com (agreement `95b0a2b5…`, Seller Agreement v3, sent 2026-10-29)
opened `sign-agreement.html`, but the page showed raw JavaScript instead of the agreement. The production record shows
the agreement was never marked viewed: the page's script failed before it could load the agreement.

## Root cause
`src/middleware/sashaTag.js` adds the help-button loader (`<script src="/widgets/sasha-loader.js">`) before the
**first** `</body>` in every page. `sign-agreement.html` builds its printable copy in JavaScript, and its inline script
contained the text `'</body></html>'`. The tag was inserted inside that script; its `</script>` ended the page's script
early. The browser showed the rest of the script as text, and the agreement never loaded.

## Why the existing tests did not catch it
- Every test read pages **from disk**, where the page was correct. Nothing checked a page **as served**, after
  middleware had changed it.
- No test ran the page in a real browser. Static assertions about strings in the file cannot see a script that no
  longer parses.
- The middleware's own tests used pages without closing-tag text inside scripts.

## Fixes (branch `feat/pro-seller-storefront-completion`, commit `5e9ed75`)
- **Injection:** tags go before the document's **last** `</body>` and after the real `<head>` (never `<header>`):
  `src/lib/htmlInjection.js`, used by `sashaTag` and `analyticsTag`.
- **Capability-token pages:** pages whose address carries a secret (signing links, password resets, invitations,
  unsubscribe links, also when wrapped in a login `next=`) get no third-party or help-button script. The analytics tag
  had been loading on the signing page, so the full address, token included, reached the analytics provider.
- **The page:**
  - renders the agreement as formatted text (`public/widgets/shared/agreement-render.js`, same rules as the PDF,
    text-only DOM building);
  - shows labelled terms (seller, signatory, seller type, effective date, version);
  - removes the token from the address bar;
  - contains no closing-tag text in its script.
- **Signing only what was displayed:** the page computes the SHA-256 of the exact text it displayed. Signing is offered
  only when it matches the server's hash, and the server refuses a signature without the matching hash
  (`DISPLAY_NOT_CONFIRMED`).
- **Links:** honour their own expiry. Admins can revoke the link (`POST /api/admin/agreements/agreements/:id/revoke-link`)
  and email a new one (`/resend`) from **Issued Seller Agreements** on `/admin/agreements.html`. The token hash is never
  returned to admins.
- **Signed PDF:** embeds the drawn signature, after strict PNG validation (a malformed PNG made the PDF library throw
  outside any error handler).
- **Mobile:** a high-density signature pad, and no sideways scrolling.

## Regression tests
- `tests/html-injection-integrity.test.js`: every page in `public/`, as served with both tags, keeps valid inline
  scripts. Reproduces the original defect with the saved pre-fix page (`tests/fixtures/sign-agreement-before-fix-2026-10-29.html`).
- `tests/browser/seller-agreement.browser.test.js`: Chromium against the real app on the real schema (isolated, see
  `tests/fullstack/`). Covers:
  - legibility on desktop and mobile;
  - terms, fees, version and effective date;
  - print and unsigned PDF;
  - acknowledgments and typed and drawn signatures, with the signing record;
  - refusal of an undisplayed agreement;
  - link revocation, replacement and expiry;
  - proof that the watchdog detector reports the original defect as raw script text.

## Production actions
- 2026-10-30: the Lewis & Maese signing link was revoked (audit `agreement_link_revoked`). The agreement itself is
  unchanged: still `sent`, same text hash, unsigned.
- **After this fix is deployed:** email a replacement link from **Issued Seller Agreements** (Email a new link). Do not
  send one before the deploy: it would open the broken page.
