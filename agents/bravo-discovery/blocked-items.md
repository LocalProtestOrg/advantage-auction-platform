# Bravo-Discovery — Blocked Items

## Active Blockers

None at this time.

---

## Standing Dependencies on Alpha-Core

These are not blockers but known cross-domain dependencies to be aware of when planning future work:

### Discovery data comes from Alpha's tables
All auction, lot, seller, and video data in the public API is read from tables that Alpha-Core owns. If Alpha changes a column name or removes a field, Bravo's queries may break silently. To guard against this:
- Bravo should use explicit SELECT field names (already doing this — never SELECT *)
- If Alpha changes the schema (e.g., renames a column), they must notify Bravo in blocked-items.md

### Marketplace priority is set by Alpha's admin endpoint
The `PATCH /api/admin/auctions/:id/discovery` endpoint lives in `src/routes/admin.js` (Alpha-Core). Bravo reads `marketplace_priority`, `lat`, and `lng` but does not write them. If Alpha removes or changes this endpoint, Bravo's ordering logic still works (falls back to `start_time DESC`) but the ranking model degrades.

### Auction lat/lng geocoding is a manual admin step
There is currently no geocoding automation — lat/lng must be set manually via the admin discovery endpoint. When a geocoding service is added (future Alpha-Core or infrastructure work), Bravo's radius search will automatically start returning richer results.

---

## Blocker Template

```
## BLOCKER: [Short title]

- **Opened:** YYYY-MM-DD
- **Blocking:** [What Bravo work is waiting on this]
- **Owner:** [Alpha-Core / Charlie-BD / Delta-Testing / Infrastructure]
- **Resolution needed:** [Specific thing that must happen]
- **Impact if unresolved:** [What breaks or cannot proceed]

### Context
[Background]

### Resolution
[Filled in when resolved]
```

---

## Resolved Blockers

_None yet._
