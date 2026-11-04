# Secret Management SOP

Rules for handling credentials, API keys, and sensitive configuration across the
Advantage Auction Platform codebase, agents, and operational systems.

---

## The Absolute Rules

1. **No real credentials in any committed file — ever.** This includes source code, tests,
   docs, scripts, agent files, ops Markdown, and seed data.
2. **No real credentials in AI model context.** Do not paste `.env` contents into a Claude
   conversation, agent prompt, or Claude.md file.
3. **`.env.example` uses placeholders only.** The example file documents variable names and
   format — never real values.
4. **Scratch files with secrets must be gitignored before creation.** If you write a temp
   file that will contain credentials, add its pattern to `.gitignore` first.
5. **Test accounts use hardcoded seeded passwords — not production credentials.**
   The test credential policy is below.
6. **Rotate immediately if exposure is suspected.** Treat any unconfirmed exposure as a
   real compromise and rotate first, investigate second.

---

## Environment File Hierarchy

| File | Committed | Purpose |
|---|---|---|
| `.env.example` | **Yes** | Placeholder template — documents required variable names |
| `.env` | **No** | Local development secrets — gitignored |
| `.env.local` | **No** | Local overrides — gitignored |
| `.env.production` | **No** | Production secrets — managed in Railway / deployment platform |
| `.env.test` | **No** | Test environment overrides — gitignored |

**Never create `.env.development`, `.env.dev`, or any other `.env.*` variant without
first adding it to `.gitignore`.**

### Setting production secrets

All production secrets are set in the Railway project environment variables panel.
They are never stored in files and never committed. The deployment platform injects
them at runtime via `process.env.*`.

---

## Hardcoded Secret Policy

**Never hardcode secrets.** This includes:

- API keys (`sk_live_...`, `sk_test_...`, `whsec_...`)
- Database connection strings with credentials
- SMTP passwords
- JWT secrets
- Cloudinary API secrets
- Railway or Vercel deployment tokens
- Personal access tokens (GitHub, etc.)
- Admin account passwords (even test/demo ones)

**Correct pattern — always use environment variables:**

```javascript
// ✓ Correct
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwtSecret = process.env.JWT_SECRET;

// ✗ Wrong — never do this
const stripe = require('stripe')('sk_test_abc123...');
const jwtSecret = 'my-hardcoded-secret';
```

---

## Test Credential Policy

Tests use **seeded accounts with known test passwords** — not real user passwords or
production credentials.

### Allowed pattern for test accounts

Test E2E accounts are seeded by `scripts/seed-validation-fixtures.js` with stable,
deterministic passwords. These passwords are:
- Simple strings that are obviously test-only (e.g., `ValidationAdmin2025!`)
- Committed to test seed files — this is intentional and safe
- Never the same as any production account password

### Required pattern for test scripts

```javascript
// ✓ Use environment variable with test-only fallback
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'validation-admin@advantage.bid';
const ADMIN_PASS  = process.env.TEST_ADMIN_PASS  || 'ValidationAdmin2025!';

// ✗ Do not use a fallback that looks like a real password
const ADMIN_PASS = process.env.ADMIN_PASS || 'password123'; // 'password123' is a real-looking password
```

The seeded test password `ValidationAdmin2025!` is clearly test-purpose only.
`password123` is ambiguous — it may match a real account and should not be used as a fallback.

### Replacing `password123` in existing test files

The legacy fallback `password123` appears in several E2E specs written before this SOP.
These should be migrated to use the seeded validation credentials on the next test
maintenance pass. The validation fixture seed file is:
`scripts/seed-validation-fixtures.js`

---

## Credential Rotation Policy

Rotate credentials whenever any of the following occur:
- Any credential is found in a committed file (even if later removed from tracking)
- Any `.env` file is accidentally added to a commit
- A developer leaves the team
- A deployment token is used in a public context
- GitHub secret scanning flags any alert (treat as confirmed exposure)

### Rotation priority tiers

**Critical — rotate within 1 hour:**
- Stripe webhook secrets (`whsec_*`)
- Stripe live secret keys (`sk_live_*`)
- JWT secret
- Database connection string / password

**High — rotate within 24 hours:**
- Stripe test secret keys (`sk_test_*`)
- Cloudinary API secret
- SMTP password

**Precautionary — rotate at next scheduled maintenance:**
- GitHub personal access tokens
- Railway deployment tokens
- Vercel tokens

---

## Local Development Rules

1. Copy `.env.example` to `.env` and fill in real values — never commit `.env`.
2. Use `node -r dotenv/config` or `require('dotenv').config()` to load `.env` in scripts.
3. Never `console.log(process.env)` — log specific non-sensitive values only.
4. Never paste `.env` contents into a pull request, issue, Slack, or chat interface.
5. Do not use personal email accounts as admin credentials in shared dev environments.

---

## Agent and Ops Discipline

Agents (Alpha-Core, Bravo-Discovery, Charlie-BD, Delta-Testing) and ops contributors:

- **Never write real credentials into any file they create or edit.**
- **Never copy `.env` contents into Markdown documentation.**
- **Use only placeholder values** in examples: `sk_test_...`, `whsec_...`, `your-secret-here`
- **Never commit scratch or debug scripts** that read from the database or call external APIs
  without first adding them to `.gitignore`.
- **Never commit log files** (`*.log`, `server.log`, `npm-debug.log`, etc.).

---

## Safe `.env.example` Pattern

The `.env.example` file documents variable names. Use format indicators, never real values:

```env
# Format: sk_test_... for sandbox, sk_live_... for production
STRIPE_SECRET_KEY=sk_test_...

# From Stripe dashboard → Webhooks → [endpoint] → Signing secret
STRIPE_WEBHOOK_SECRET=whsec_...

# From Cloudinary dashboard → Settings → Access Keys
CLOUDINARY_API_KEY=your_api_key_here
CLOUDINARY_API_SECRET=your_api_secret_here
CLOUDINARY_CLOUD_NAME=your_cloud_name

# Generate with: openssl rand -base64 48
JWT_SECRET=change-this-to-a-long-random-secret

# Full connection string from Railway / Neon / Supabase
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
```

---

## Automated Credential-Exposure Checks (built in, 2026-11-04)

One list of credential shapes (`src/lib/secretPatterns.js`: payment, cloud, code-hosting, chat and model-provider keys,
webhook secrets, private keys, signed tokens, database addresses with a password, and any key, secret, token or password
written right after its name or on a command line) is used everywhere below. A finding names the place and the kind of
credential and its length; it never repeats the value.

| Where | How | When |
|---|---|---|
| Commits | `.githooks/pre-commit` runs `node scripts/check-secrets.js --staged` | every commit (enable once per clone: `git config core.hooksPath .githooks`) |
| Repository | `node scripts/check-secrets.js --all` | CI, every push to main and every pull request (Tests workflow) |
| Test output | the CI test run is saved and scanned with `--file jest-output.txt` | CI, after every test run |
| Application logs | `src/lib/logRedaction.js` replaces credential-shaped values with `[REDACTED:<kind>]` in every console line of the server and its background workers | always, in production |
| Command lines | `node scripts/check-secrets.js --processes` (running processes) and `--config <claude_desktop_config.json>` (a desktop integration must take its key from `env`, never from `args`) | on demand, e.g. after changing a desktop integration |
| Any text | `<command> \| node scripts/check-secrets.js --stdin` | on demand |

Labelled test values (`test-secret-...`, `sk_test_isolated_placeholder`, `change-this-...`) and code references
(`process.env.X`) are allowed. A real test-mode key (`sk_test_51...`) is still a credential. A line that is truly not a
credential can carry the comment `secret-scan: allow <reason>`; use it sparingly and never for a real value.

---

## Incident Response Quick Reference

1. **Identify** — find the file, commit, and credential type
2. **Rotate** — invalidate the exposed credential immediately (before anything else)
3. **Stop the active exposure** — `git rm --cached <file>`, update `.gitignore`
4. **Assess history** — determine if cleanup is needed (see below)
5. **Document** — record what happened, when, and what was rotated
6. **Harden** — add rules/checks to prevent recurrence

### On git history cleanup

If a rotated credential still exists in git history:
- The rotated credential is now useless — exposure risk is resolved
- History cleanup with BFG Repo Cleaner is possible but destructive
- BFG rewrites history, force-push, and invalidates all existing clones
- Only pursue history cleanup if the repo is private or if legal/compliance requires it
- If you proceed: use BFG Repo Cleaner (safer than `git filter-branch`), coordinate with
  all contributors, and force-push only with explicit approval

*Last updated: 2026-05-11*
