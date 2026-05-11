# Rollback Guide

How to safely undo a widget deployment if something goes wrong.

---

## Before Every Deployment: Save Your Rollback Snapshot

This is the most important step. Before replacing any existing BD section with
a widget embed, copy the old HTML into the deployment log. A 30-second paste
saves hours of recovery.

**In `deployment-log.md`:**
```markdown
Previous HTML (for rollback):
```html
<section class="old-section">
  <!-- paste the exact existing HTML here -->
</section>
```

If you don't have the old HTML, check:
1. BD's version control / CMS history
2. `git log` if the BD page is in a repo
3. The Wayback Machine for publicly cached versions

---

## Rollback Scenarios

### Scenario A: Widget shows blank / empty state

**Symptoms:** Widget container renders but shows "No auctions available" or nothing at all.

**Cause:** Usually no live featured data matching the filter, or wrong `data-api-base`.

**Fix before rollback:**
1. Open browser DevTools → Network tab
2. Find the API request the widget made — check its URL and response
3. If `data-api-base` is wrong, fix it in the embed code
4. If the API returned 0 results, this is a data issue — contact ops to feature some lots/auctions
5. If the API returned an error, contact engineering

**Rollback only if:** The fix is not immediate and the page needs to show content now.

---

### Scenario B: Widget causes layout breakage on BD page

**Symptoms:** Host page layout shifts, columns collapse, or navigation overlaps widget.

**Cause:** CSS conflict between host page and widget styles.

**Fix before rollback:**
1. Open DevTools → inspect the broken element
2. Look for `!important` overrides on layout properties in BD page CSS
3. Try wrapping the widget in a `<div style="overflow:hidden;">` first
4. Check `shared-css-strategy.md` for known compatibility issues

**Rollback:** Replace the widget embed code with the saved snapshot from the deployment log.

---

### Scenario C: Widget shows JavaScript error in console

**Symptoms:** Console shows `TypeError`, `ReferenceError`, or similar. Widget may not render.

**Cause:** Script load order issue, or BD page's JavaScript is conflicting.

**Fix before rollback:**
1. Confirm all script tags are in the correct order (see deployment-workflow.md)
2. Confirm `shared/utils.js` and `shared/config.js` are loaded before any widget script
3. Check if BD page has a conflicting global variable (`window.AAPConfig`, `window.AAPWidgetUtils`)
4. Try the standalone embed (single script) instead of the full platform layer

**Rollback:** Replace the widget embed code with the saved snapshot.

---

### Scenario D: Widget works but analytics events are not firing

**Symptoms:** Widget renders correctly, but GTM / GA event tracking shows no events.

**Cause:** Event listener is attached before the widget container exists, or listener is on wrong element.

**Fix:**
```javascript
// Wait for DOM ready before attaching listeners
document.addEventListener('DOMContentLoaded', function() {
  var container = document.getElementById('aap-featured-lots');
  if (container) {
    container.addEventListener('aap:widget:loaded', function(e) {
      // handle event
    });
  }
});
```

This is not a widget failure — no rollback needed. Fix the analytics code on the BD page.

---

### Scenario E: Widget renders differently than expected (wrong number of cards, wrong data)

**Symptoms:** 12 cards showing instead of 6, wrong auction state shown, etc.

**Fix:**
1. Check `data-limit` attribute on the container — must be an integer string (`"6"`, not `6`)
2. Check `data-auction-state` — must be `"published"`, `"active"`, or `"closed"`
3. Check `AAPConfig` if a site-wide limit was set higher than intended

**Rollback:** Adjust the `data-*` attributes. No full rollback needed.

---

## Full Rollback Procedure

When an immediate fix is not possible and the page needs to be restored:

1. **Locate the rollback snapshot** in `deployment-log.md` for this deployment.

2. **Remove the widget embed code** from the BD page:
   - Remove the widget container `<div>`
   - Remove the widget `<script>` tag(s)
   - If using the full platform layer, remove all shared layer scripts ONLY if
     no other widgets on the page depend on them

3. **Paste the saved HTML** back in place of the removed embed code.

4. **Verify the page looks correct** — hard refresh and check in both desktop and mobile.

5. **Log the rollback** in the deployment log:
   ```markdown
   ## [Date] — ROLLBACK: [Widget Name] rolled back on [BD Page]
   - Reason: [brief description]
   - Restored to: pre-deployment state
   - Engineering notified: [yes/no]
   ```

6. **Notify engineering** if the rollback was caused by a widget bug (not a
   configuration error). Submit a bug report with:
   - The BD page URL where it was deployed
   - The exact embed code used
   - The browser console error or network response
   - Screenshot of the broken state

---

## Version Pinning (Not Currently Supported)

Widget scripts at `https://auctions.advantage.bid/widgets/[name].js` serve the
latest stable version. There is no version-pinned URL path today (e.g., `/widgets/v1/featured-lots.js`).

**Implication:** If engineering releases a new widget version, all BD embeds update automatically.

This is intentional for PATCH and MINOR changes. For MAJOR changes (breaking), engineering
will communicate with frontend ops before releasing, and a new package document will be published.

**Future capability:** Version-pinned CDN paths may be added in a future engineering cycle.
Submit the request if BD operations require independent version control.

*Last updated: 2026-05-11*
