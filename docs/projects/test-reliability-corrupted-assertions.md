# Test Reliability: Corrupted Regex Assertions

Found 2026-10-29 during the event-import investigation. **Status: RESOLVED 2026-10-29** (branch `feat/provider-neutral-event-discovery`). It had no production effect.

## Problem
Four test assertions contain a literal backspace control character (byte 0x08) where the regex word boundary `\b` was intended. This came from an earlier tooling error that turned the escape into a raw control character.

A regex containing a raw backspace only matches text that itself contains a backspace. Real text never does, so these alternatives never match. A `not.toMatch` assertion built on them therefore passes no matter what the code does: the guard is silently disabled.

The same corruption in production code, in the importer's HTTP-status regex, was fixed in commit 70186ae. That code is now guarded by a test that rejects control characters in the importer connector files.

## Affected assertions
| File | Line | Intended guard | Effect today |
|---|---|---|---|
| `tests/sasha-phone/phone-sasha.test.js` | 975 | Phone Sasha's progress phrases never contain the words "system" or "AI" (Public Language Standard) | The "system" and "AI" parts never match; only "processing", "status" and "query" are actually checked |
| `tests/metaFullFunnel.test.js` | 186 | Marketing copy never pairs a percentage with fee, commission, premium, rate or pricing | The whole assertion never matches, so it guards nothing |
| `tests/metaFullFunnel.test.js` | 187 | The same guard, with the words in the other order | Never matches, so it guards nothing |
| `tests/meta-measurement-connection.test.js` | 245 | Detects Meta ad-management write endpoints (`/act_.../campaigns\|adsets\|ads`) in source files | The `act_` alternative never matches; only the `graph.facebook.com` part works |

## Resolution (2026-10-29)
1. Each backspace byte was replaced with the two characters `\b`, byte-exactly with line endings preserved. That made 9 replacements: 4 in `phone-sasha.test.js`, 4 in `metaFullFunnel.test.js` and 1 in `meta-measurement-connection.test.js`.
2. **What the corrected guards revealed: nothing.** All 146 tests in the three files pass with working word boundaries. I also checked that the restored patterns really match their targets now (for example "the AI is checking" and "4% platform fee").
   - No Phone Sasha progress phrase says "system" or "AI".
   - No marketing copy pairs a percentage with a fee word.
   - No source file references a Meta ad-management write endpoint.

   No product change was needed.
3. Three other files held raw control characters on purpose. Each was rewritten as an escape, so the runtime strings are unchanged:
   - `src/services/eventImport/dedupe.js`: the `\x01` fingerprint separator. Hashes are identical; this was verified.
   - `tests/directory/directory-mirror.test.js`: `\x01` sample input.
   - `tests/eventImport/canonical.test.js`: `\x07` sample input.
4. New guard: `tests/no-control-characters.test.js`. No tracked `.js`, `.html`, `.sql` or `.md` file may contain a raw control character other than tab, line feed and carriage return. No exemptions.

## Original correction plan
1. Replace each 0x08 with the two characters `\b`.
2. Run each test. A corrected guard may now fail, which would expose a real violation hidden until now. Fix any such violation in the product, not in the test.
3. Add a repository-wide check that tracked `.js` and `.html` files contain no control characters other than tab, line feed and carriage return. `src/services/eventImport/dedupe.js` intentionally uses `\x01` as a hash-field separator: exempt it, or switch it to an escaped form.

## Detection command
`git grep -nP '\x08' -- '*.js' '*.html'`
