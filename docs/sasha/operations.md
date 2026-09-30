# Sasha: operations

Sasha is Advantage.Bid's customer-service representative. She answers email sent to info@advantage.bid (a copy of it) and website chat on bid.advantage.bid and www.advantage.bid. Migration 180 adds the tables, switches and guidance.

## Admin pages (Super Admin, or staff with `support.view` / `support.manage`)

**Shared Inbox:** /admin/sasha-inbox.html
- Views: Needs a person / Open / With staff / Resolved / All / Ignored.
- Actions: Take over, Return to Sasha, Reply (by email or into the chat), Internal note, Resolve / Reopen.
- Replying takes the conversation over first. Sasha never replies to a conversation that staff own. This is enforced under a row lock in `conversationService.addSashaReply`.

**Settings & Knowledge:** /admin/sasha.html
- Switches can be changed by a Super Admin only.
- Also shows the daily spend limit, spend today, the inbox address, mail received, guidance (add / edit / approve / mark as a conflict / disable), live platform rules, the help pages that are indexed, activity and errors.

## Switches (platform_config, category `sasha`)

| Key | Effect when OFF |
|---|---|
| `sasha.enabled` | Global stop. Everything below is inactive. |
| `sasha.engine_enabled` | No model calls. Messages are kept and handed to staff. Chat visitors are told the team will follow up. |
| `sasha.email_inbound_enabled` | Mail to the inbox route is **held**, not lost, and retried when switched on. |
| `sasha.email_autoreply_enabled` | Sasha drafts a reply as an internal note, and staff review and send it. |
| `sasha.chat_bid_enabled` | No help button on bid.advantage.bid. |
| `sasha.chat_www_enabled` | No help button on www.advantage.bid. |
| `sasha.daily_budget_usd` | Model spend cap per UTC day. When it is reached, conversations go to staff. |

Every change is audited as `sasha.setting_changed`.

## Help button on www.advantage.bid (Brilliant Directories)

In BD Admin, open the site-wide custom footer code area, before `</body>`. This is the same place other site-wide scripts are installed; in most BD versions it is under **Settings → Design Settings → Custom Code / Footer**. Add this line:

```html
<script src="https://bid.advantage.bid/widgets/sasha-loader.js" async></script>
```

How the loader behaves:
- It shows nothing unless `sasha.chat_www_enabled` is on.
- It never shows on live-bidding paths, or when the page is inside a frame.
- The chat window is served from bid.advantage.bid, so a signed-in member's session works there.
- The chat window is frameable only by `'self'`, advantage.bid and www.advantage.bid.
- To remove the button, delete the line or switch `sasha.chat_www_enabled` off.

On bid.advantage.bid the button is added automatically by `src/middleware/sashaTag.js`. It is excluded from:
- lot pages and auction-view (live bidding);
- payment, admin, org, embeds and widgets;
- demo and claim pages.

## Email route (added last, after acceptance)

Mail flow: customer → info@advantage.bid (cPanel mailbox + existing Gmail forwarder, **unchanged**) → **additional** cPanel forwarder → `inbox@reply.advantage.bid` → SES (reply.advantage.bid MX) → S3 → SNS → `/api/webhooks/email/ses-inbound` → programme `company_inbox` → Sasha.

What stays unchanged:
- the root MX;
- the info@ mailbox and the Gmail forwarder;
- the Claimed Listing and Event Partner routes. Their reply keys are separate, and they keep their own switches.

**To add the cPanel forwarder**
1. In cPanel, go to **Email → Forwarders → Add Forwarder**.
2. **Address to forward:** `info`, **Domain:** `advantage.bid`.
3. **Destination → Forward to email address:** `inbox@reply.advantage.bid`.
4. Save. The existing forwarder to Gmail stays in place. cPanel allows several forwarders for one address, and the mailbox keeps its copy.
5. To stop Sasha receiving mail: delete that one forwarder, or switch `sasha.email_inbound_enabled` off (mail is then held).

Replies go out from info@advantage.bid ("Sasha at Advantage.Bid") with:
- `In-Reply-To` / `References`;
- `Auto-Submitted: auto-replied`;
- `X-Advantage-Sasha: <ref>`;
- a `[Ref Sxxxxxx]` subject token.

The customer's answer comes back through the same path and threads onto the same conversation.

**Protections**
- Never answered: our own mail; Sasha mail (loop); Auto-Submitted, bulk, list and autoresponder mail; bounces; no-reply and system senders; empty mail.
- A duplicate Message-ID is a no-op.
- Caps: 4 auto-replies per sender per hour, 12 per day and 25 per conversation. Above a cap, the conversation goes to staff.
- Spam is marked for review; a virus is quarantined unopened.
- Attachments are never opened; only their names are recorded.

## Privacy rules (enforced in code, `src/services/sasha/tools.js`)

- Email is not verified identity: no account data by email. Sasha asks the customer to sign in and use chat.
- Account tools exist only for a signed-in chat user, and only for their own data.
- Public data shows city and state only.
- The pickup street address is given only to the signed-in buyer, and only for an auction where their invoice is **paid**.
- Public users cannot list or read conversations. `/api/admin/sasha/*` requires staff permissions, and the chat API returns only the caller's own conversation, identified by a random token (stored hashed) plus the session user.

## info@ mailbox reader (IMAP, migration 183)

Sasha can read NEW mail directly from the info@advantage.bid mailbox. No change is needed to MX, DNS, SES, BD/cPanel or the Gmail delivery.

**Read-only by construction** (`src/services/sasha/imap/safeImapClient.js`):
- the mailbox is opened with EXAMINE and messages are fetched with BODY.PEEK[], so nothing is marked read;
- the reader cannot delete, move, copy, flag, append, expunge or close the mailbox;
- TLS certificate verification is always on.

**Switches** (Admin, Sasha Settings & Knowledge), both OFF by default:

| Key | Effect when ON |
|---|---|
| `sasha.imap_read_enabled` | Connects every 2 minutes and records new mail. Test mode: nothing is answered. |
| `sasha.imap_process_enabled` | Hands newly recorded mail to Sasha through the same path as the SES route. Needs "read" on. |

**Railway variables** (entered by the Owner; the password is SEALED; never in git, logs or docs):

| Variable | Value |
|---|---|
| `SASHA_IMAP_HOST` | `mail.advantage.bid` |
| `SASHA_IMAP_PORT` | `993` |
| `SASHA_IMAP_USER` | `info@advantage.bid` |
| `SASHA_IMAP_PASSWORD` | the mailbox password (**sealed**) |
| `SASHA_IMAP_TLS_SERVERNAME` | optional; only if the server's certificate is issued for a different host name |

**Safety**
- **First connection:** the reader starts at the newest existing message, so the backlog is never answered.
- **Duplicates:** each mailbox position is recorded once, the Message-ID is unique across IMAP and SES, and mail without a Message-ID is matched by content fingerprint.
- **Age limit:** mail older than 48 hours when first read goes to staff, never to an automatic reply.
- **Rejected login:** the reader stops and alerts the Owner by SMS, with no retries. A Super Admin clears the block in Sasha settings after fixing the password.

**Alerts** (owner SMS, `sasha_imap_health`):
- login rejected;
- no successful check for 15 minutes;
- mailbox renumbered;
- no new mail for 24 hours.
