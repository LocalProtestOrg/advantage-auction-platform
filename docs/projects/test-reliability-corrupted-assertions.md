# Test Reliability: Corrupted Regex Assertions

Found 2026-10-29 during the event-import investigation. Status: OPEN, not yet corrected. This is a separate reliability item; it has no production effect.

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

## Correction (separate change, owner-approved scope)
1. Replace each 0x08 with the two characters `\b`.
2. Run each test. A corrected guard may now fail, which would expose a real violation hidden until now. Fix any such violation in the product, not in the test.
3. Add a repository-wide check that tracked `.js` and `.html` files contain no control characters other than tab, line feed and carriage return. `src/services/eventImport/dedupe.js` intentionally uses `\x01` as a hash-field separator: exempt it, or switch it to an escaped form.

## Detection command
`git grep -nP '\x08' -- '*.js' '*.html'`
