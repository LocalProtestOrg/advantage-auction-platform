# Daily Operator Checklist

Last updated: 2026-05-11
Maintained by: Human Operator

This checklist governs every session. It is not optional.
Work that skips this checklist is unauthorized regardless of urgency.

---

## 1. Morning / Session-Start Check (run before any terminal opens)

### Platform State
- [ ] `git status` — confirm no uncommitted changes from the previous session
- [ ] `git log --oneline -5` — confirm the last commit is what you expect
- [ ] Review `agents/orchestration/active-work-queue.md` — any stream left ACTIVE?
      If yes: complete or checkpoint before starting new work
- [ ] Review `agents/orchestration/blocked-items.md` — any HIGH-urgency blockers?
      If yes: resolve blockers before assigning new work

### Migration Safety
- [ ] Confirm current migration ceiling in `active-work-queue.md` (currently: `044`)
- [ ] If any stream is about to create a migration, confirm the next number is claimed
      in `active-work-queue.md` first

### Secret Safety
- [ ] Confirm `.env` is NOT tracked: `git ls-files .env` should return nothing
- [ ] Confirm no scratch `.txt` or notes files are staged: `git status`
- [ ] If any doubt, run: `git diff --cached | grep -E "(sk_live_|sk_test_|whsec_|sk-ant-)"`
      and confirm the result is empty

---

## 2. Before Starting Any Engineering Work Cycle

- [ ] Read the target stream's `current-work.md` — is it IDLE?
- [ ] Read ALL other active streams' `current-work.md` files
- [ ] Confirm the files to be modified do NOT appear in any other stream's active list
- [ ] If modifying `server.js`: confirm no other stream has it checked out
- [ ] If creating a migration: claim the migration number in `active-work-queue.md`
- [ ] Update the target stream's `current-work.md` to ACTIVE with files listed
- [ ] If this work resolves a blocker: update `blocked-items.md` when complete

---

## 3. Before Opening a Second Terminal

A second terminal is a parallel work session. It is only allowed when both of the
following are true:

**Condition A — Zero file overlap**
The two streams have no files in common in their active work sets. Verify by
reading both streams' `current-work.md` files and the `ownership-matrix.md`
parallelism safety table.

**Condition B — No risky actions in progress**
Neither terminal is running or about to run any of the following:
- A database migration
- A `server.js` modification
- A `git reset`, `git rebase`, or `git push --force`
- A `git add -A` or broad staging command
- Any Stripe or payment-related route change

### Safe second-terminal combinations (from `ownership-matrix.md`):

**Consistently safe:**
- Terminal A: Alpha-Core — Terminal B: Growth Ops
- Terminal A: Alpha-Core — Terminal B: Marketplace Intelligence
- Terminal A: Alpha-Core — Terminal B: Frontend Ops
- Terminal A: Bravo-Discovery — Terminal B: Growth Ops
- Terminal A: Bravo-Discovery — Terminal B: Marketplace Intelligence
- Terminal A: Bravo-Discovery — Terminal B: Frontend Ops
- Terminal A: Charlie-BD — Terminal B: Growth Ops
- Terminal A: Charlie-BD — Terminal B: Marketplace Intelligence
- Terminal A: Delta-Testing — Terminal B: Growth Ops
- Terminal A: Delta-Testing — Terminal B: Frontend Ops
- Terminal A: Delta-Testing — Terminal B: Marketplace Intelligence

**Conditionally safe (verify before opening):**
- Terminal A: Alpha-Core — Terminal B: Charlie-BD
  → Only if Alpha is not touching `server.js` and no shared route files
- Terminal A: Alpha-Core — Terminal B: Delta-Testing
  → Only if Delta is not writing specs for files Alpha is modifying
- Terminal A: Bravo-Discovery — Terminal B: Delta-Testing
  → Only if Delta is not writing specs for files Bravo is modifying
- Terminal A: Charlie-BD — Terminal B: Delta-Testing
  → Only if Delta is not testing files Charlie is modifying
- Terminal A: Charlie-BD — Terminal B: Frontend Ops
  → Only if Charlie is not actively publishing new exports in the same session

**Never safe:**
- Terminal A: Alpha-Core — Terminal B: Bravo-Discovery
- Terminal A: Bravo-Discovery — Terminal B: Charlie-BD

### Before opening the second terminal:
- [ ] Both streams confirmed IDLE before starting
- [ ] Both streams' active file sets are confirmed non-overlapping
- [ ] No migrations scheduled in either terminal this session
- [ ] No `server.js` edits in either terminal this session
- [ ] You can describe in one sentence what each terminal will do

---

## 4. Approval Required Before Risky Actions

The following actions require the human operator to **explicitly approve before execution**.
An agent must not proceed with these autonomously.

| Action | Why It Requires Approval |
|---|---|
| `git push --force` | Can overwrite remote history permanently |
| `git reset --hard` | Discards uncommitted work permanently |
| `git rebase` (published commits) | Rewrites shared history |
| `DROP TABLE` or `DROP COLUMN` in a migration | Destructive, irreversible data loss |
| Deleting any file in `/src/`, `/db/`, `/e2e/`, `/public/widgets/` | Potentially removes production behavior |
| Modifying an existing migration file | Breaks migration idempotency guarantees |
| Modifying `src/middleware/authMiddleware.js` | Auth failure can lock all users out |
| Modifying `src/routes/payments.js` or `src/services/paymentService.js` | Payment flow breakage has financial impact |
| Modifying `src/routes/bids.js` or `src/services/bidService.js` | Bid integrity failure affects auction outcomes |
| Changing `STRIPE_WEBHOOK_SECRET` behavior in code | Can silently break payment confirmation |
| Any change to the pre-commit hook | Could disable secret scanning protection |
| Publishing a new export package to `/exports/frontend-widgets/` | Triggers a downstream Frontend Ops deployment |
| Running a seed script against the production database | Can corrupt live auction data |
| Adding a new npm dependency | Widens the attack surface; requires review |

**Approval format:**
The operator must state the action explicitly and give a reason. Example:
> "Approved: run `git push --force` on this branch because the pre-commit hook
> was triggered by a false positive on a placeholder key."

---

## 5. Commit Discipline Checklist

Before every commit, verify:
- [ ] `git diff --cached` reviewed — only intended files are staged
- [ ] No `.env`, `.env.local`, or any real credential file is staged
- [ ] `git ls-files --others --exclude-standard` — no untracked files that should be staged
- [ ] Commit message explains WHY, not just what
- [ ] Commit message includes `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
      if AI-assisted
- [ ] Staged diff does not contain `sk_live_`, `sk_test_`, `whsec_`, `sk-ant-`, `ghp_`

**Staging discipline:**
- Always use explicit file paths: `git add src/routes/analytics.js`
- Never use `git add -A` or `git add .` unless every file in the diff has been reviewed
- Prefer multiple small commits over one large staging

---

## 6. Checkpoint Discipline (Engineering Streams)

After completing a work cycle:
- [ ] All new spec files run clean
- [ ] Full suite shows no new failures beyond the known 10 pre-existing
- [ ] `current-work.md` is cleared (status: IDLE)
- [ ] Checkpoint tag applied: `git tag checkpoint-[name]-v[N]`
- [ ] Tag pushed: `git push origin checkpoint-[name]-v[N]`
- [ ] `checkpoint-log.md` updated with: commit hash, what was done, test counts, what's next
- [ ] `active-work-queue.md` updated: stream status set to IDLE, completed item added to Recently Completed
- [ ] Any handoffs due to this checkpoint written in `active-work-queue.md`

---

## 7. End-of-Session Check

- [ ] All streams are IDLE (or active work is documented in `current-work.md`)
- [ ] No half-written files are uncommitted
- [ ] `active-work-queue.md` reflects current state accurately
- [ ] `blocked-items.md` is up to date
- [ ] `git status` is clean (or intentional uncommitted changes are understood)
- [ ] No scratch files (e.g., `check-*.js`, `debug-*.js`, `*.txt`) left at repo root

---

## 8. When Something Goes Wrong

**If a stream breaks the suite:**
1. Stop the stream immediately — do not continue
2. Run the full suite to confirm the failure count
3. Identify which commit introduced the failure: `git bisect` if needed
4. If the fix is simple: fix and commit in the same stream
5. If the fix requires another stream: log a HIGH-urgency blocker in `blocked-items.md`
6. Do not merge or push until the suite is restored to the known pre-existing failure count

**If a secret is accidentally committed:**
1. Do NOT push to remote
2. If already pushed: follow `docs/security/secret-management.md` incident response
3. Rotate the credential immediately
4. Remove from git history using BFG Repo Cleaner or `git filter-repo`
5. Force-push only after operator approval and after the credential is rotated
6. Document the incident in `docs/security/secret-management.md`

**If two streams have modified the same file:**
1. Stop both streams
2. Identify the conflict scope
3. Sequence the work — one stream checkpoints, then the other merges/rebases
4. Log what happened in `blocked-items.md` as a resolved entry with a post-mortem note
5. Update `ownership-matrix.md` if the conflict revealed an ambiguity
