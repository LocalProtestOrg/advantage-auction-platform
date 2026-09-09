# Meta Organic Social — Intelligence + Marketing Director Feedback Loop

**Status:** software-side architecture complete (migration 146). All publishing gates OFF. Nothing here posts, replies, spends, or alters Page settings.
**Scope:** the national Advantage.Bid Facebook Page (`449143945236360`) and Instagram business account `@advantagebid` (`17841436199617514`) only. Other assets in the Meta Business Portfolio (for example Lewis & Maese) are never selected, queried, posted to, or routed — an unregistered account id in a webhook is ignored without storing its payload.

## 1. Operating loop (what runs where)

| Stage | Component | Runs when |
|---|---|---|
| PUBLISH | `socialAdapter.publishWave` → `metaGraphProvider.publish` (certified build) | A9 + `marketing.destinations.meta_enabled` both ON |
| OBSERVE / MEASURE | `socialInsightsService` (ladder h1 → h24 → h72 → d7 → d14) via `marketingSocialInsightsWorker` (forked, 15-min poll) | `marketing.social.insights_enabled` ON and a REAL post exists |
| INGEST ENGAGEMENT | `socialEngagementService.ingestEvent` (poll + webhook) | same as above; webhook needs `META_APP_SECRET` |
| DIRECTOR ANALYSIS | `socialLearningService.directorSummary` → `directorReportService.social_organic`, `GET /api/admin/director/social-performance`, Desktop bridge `social_organic` | always (returns honest zeros/gaps) |
| DURABLE LEARNING | `socialLearningService.recordLearnings` → `marketing_learnings` (segment `social_organic`, attribution `correlational`) | `POST /api/admin/director/social-learning/record` (Super Admin) |
| DECISIONS | existing Director decision/experiment/collision/execution-authorization services consume the learnings | unchanged |

Normalized facts also land in `marketing_performance_facts` (`MEASURED`, source `meta_insights`) so the seller allowlist renderer and the Director read the same structure. No parallel analytics platform was created.

## 2. Permission → capability matrix

| Permission | What Meta allows | Advantage.Bid uses it for | Consuming system | Software work | Active now | Safety / privacy |
|---|---|---|---|---|---|---|
| `public_profile` | Basic profile of the app user | Nothing at runtime (System User token) | — | none | n/a | No user profile stored |
| `pages_show_list` | List Pages the user manages | Not used. The registry holds explicit Page IDs; `/me/accounts` is never enumerated so other portfolio Pages are never touched | `socialDestinationService` | none | n/a | Prevents accidental selection of L&M assets |
| `pages_read_engagement` | Read Page content, post objects, comment/share/reaction summaries, Page follower fields | Post object metrics (`shares`, `comments.summary`, `reactions.summary`), Page `followers_count`, identity verify | `metaGraphProvider.fetchPostMetrics/fetchAccountMetrics/verifyIdentity` | done (mig 146) | when insights switch ON | Aggregate counts only |
| `pages_manage_posts` | Create/edit/delete Page posts | Facebook publishing (`/{page}/photos`, `/{page}/feed`) | `metaGraphProvider.publish` (certified) | done | OFF (A9 + Meta gates) | Factual copy manifest, clean links |
| `read_insights` | Page + post insights | Post ladder metrics (`post_impressions`, `post_impressions_unique`, `post_engaged_users`, `post_clicks`, `post_reactions_by_type_total`, `post_video_views`) and daily Page metrics (`page_impressions`, `page_post_engagements`) | `socialInsightsService` → snapshots → performance facts → Director | done | when insights switch ON | Read-only; unsupported metrics recorded as `not_supported`, never fabricated |
| `pages_manage_engagement` | Comment/like/reply as the Page | **Not used.** Reserved for stage E (publish reply), which is structurally disabled | `socialEngagementService.publishReply` (always refuses) | none until Owner policy exists | OFF (structural) | Publishing authorization ≠ reply authorization |
| `pages_manage_metadata` | Page settings + webhook subscriptions (`/{page}/subscribed_apps`) | Future Page-level webhook subscription. Receiver is built; subscribing is an Owner console step | `metaWebhookService` (receiver only) | receiver done; subscribe call intentionally NOT automated | receiver 503 until secrets set | Never alters Page settings |
| `pages_read_user_content` | Read user-generated comments/posts on the Page | **Needed** to read public comments on Facebook posts (poll). Not currently granted → comments report `unavailable`, never "zero" | `metaGraphProvider.fetchComments` | none | n/a | Only comment id, timestamp, ≤500-char excerpt stored; no author identity |
| `instagram_basic` | IG account + media fields | `like_count`, `comments_count`, `followers_count`, `media_count`, identity verify | provider read functions | done | when insights switch ON | Aggregate only |
| `instagram_content_publish` | Create/publish IG media | Instagram publishing (`/media` → `/media_publish`) | `metaGraphProvider.publish` (certified) | done | OFF | Public Cloudinary image URL |
| `instagram_manage_insights` | IG media/account insights | `reach`, `impressions` (deprecated for newer media → `not_supported`), `views`, `likes`, `comments`, `shares`, `saved`, account `reach` | `socialInsightsService` | done | when insights switch ON | Read-only |
| `instagram_manage_comments` | Read/reply/hide IG comments | READ only (`/{media}/comments?fields=id,text,timestamp`) + IG `comments` webhook field | `fetchComments`, webhook | done (read) | when insights switch ON | Reply path absent by design |
| `instagram_manage_messages` | IG DMs | **Not needed. Do not request.** | — | — | — | Out of scope |

Instagram use case ("Manage messaging & content on Instagram") — exact needs: publishing = `instagram_basic` + `instagram_content_publish` (+ `pages_read_engagement` or `pages_show_list` for the linked Page); reading media = `instagram_basic`; insights = `instagram_manage_insights`; comments/engagement = `instagram_manage_comments`; webhooks = `instagram_manage_comments` with the app subscribed to the `instagram` object `comments` field.

## 3. Data model (migration 146, additive)

- `marketing_social_jobs` + `platform`, `destination_id`, `state_code`, `market_key`, `creative_job_id`, `copy_style`, `insights_status`, `next_insights_poll_at`, `insights_poll_count`, `insights_error_count`, `last_insights_at`.
- `marketing_social_metric_snapshots` — one row per (job, window); `metrics` JSON `{ key: { value|null, availability, provider_metric } }`; provider post id + destination + observed_at retained.
- `marketing_social_account_snapshots` — one row per (destination, day).
- `marketing_social_engagement_events` — comment/reaction/share on our posts; UNIQUE (platform, provider_event_id); `text_excerpt` ≤ 500 chars; classification + reason; `response_state`; `draft_text`. **No author columns exist.**
- `marketing_social_webhook_events` — dedup key UNIQUE; payload stored only for registered destinations.
- Config: `marketing.destinations.meta_ads_enabled=false` (PAID, split from organic), `marketing.social.insights_enabled=false`, `marketing.social.reply_draft_enabled=false`.
- Seeds the two national destination rows with the Owner-supplied IDs; `active` stays FALSE; no token is stored (destinations reference the env-var NAME `META_SYSTEM_USER_TOKEN`).

## 4. Engagement governance (A–E)

| Stage | Autonomy | Implementation |
|---|---|---|
| A. Read / observe | autonomous | poll (`pollCommentsForJob`) + webhook (`processDelivery`) |
| B. Classify | autonomous, deterministic | `classify()` → question / purchase_intent / positive / negative / complaint / spam / other, with reason |
| C. Report / learn | autonomous | `summary()` counts → Director + admin page |
| D. Draft response | governed switch `marketing.social.reply_draft_enabled` (OFF) | factual, link-clean templates; stored only |
| E. Publish reply | **disabled by design** | `publishReply()` always returns `autonomous_public_replies_not_authorized`; no Graph write path for comments exists; no config flag can enable it |

## 5. Organic vs paid boundary

| | Organic social intelligence | Paid Meta retargeting / Marketing API |
|---|---|---|
| Gate | `marketing.a9_publish_enabled` + `marketing.destinations.meta_enabled` (publish); `marketing.social.insights_enabled` (read) | `marketing.destinations.meta_ads_enabled` (FALSE) |
| Consumers | `socialDispatchService`, `socialInsightsService`, Director | `executionAuthorizationService` channel `meta`, `channelReadinessService` `paid`, `audienceDestinations.meta` |
| Data | aggregate post/account metrics; comment excerpts without identity | would need hashed-contact export, Custom Audience terms, Pixel/CAPI — **none built, none authorized** |

Flipping the organic gate can no longer authorize paid channels (previously both read the same key). Later paid activation dependencies: Meta ad account + Custom Audience terms, Pixel id + Conversions API token, `ads_management`/`ads_read` permissions, advertising consent from the banner, and an explicit Owner decision.

## 6. Production configuration

Env vars (Railway; names only — never paste values into chat or code):

| Variable | Purpose | Required for |
|---|---|---|
| `META_SYSTEM_USER_TOKEN` | Business Manager System User long-lived token (Page + IG scopes above) | publishing (gated) and insights |
| `META_APP_SECRET` | verifies `X-Hub-Signature-256` on `/api/meta/webhook` | webhooks (503 until set) |
| `META_WEBHOOK_VERIFY_TOKEN` | random string echoed during Meta's GET verification | webhooks |
| `META_GRAPH_VERSION` | Graph version, default `v21.0` | optional |

Platform config keys (admin edit path `/admin/social-destinations.html` for the two intelligence switches; publishing gates remain Owner activation decisions): `marketing.social.insights_enabled`, `marketing.social.reply_draft_enabled`, `marketing.destinations.meta_ads_enabled` (paid; not exposed for editing).

## 7. Remaining Owner (provider-side) steps

1. In Business Settings → System Users: create/choose a System User for **Advantage Auction Company**, assign the AdvantageBid Page and `@advantagebid` IG asset only, generate a long-lived token with the scopes in §2, and set it as Railway env `META_SYSTEM_USER_TOKEN`.
2. Set `META_APP_SECRET` (App Dashboard → Settings → Basic) and choose a `META_WEBHOOK_VERIFY_TOKEN`.
3. On `/admin/social-destinations.html`, run **Verify** on each national destination (read-only identity check confirms the token resolves the configured IDs) and set `active` on the two national rows.
4. App Dashboard → Webhooks: callback `https://bid.advantage.bid/api/meta/webhook`, verify token from step 2; subscribe Page object field `feed` and Instagram object field `comments`; then subscribe the Page to the app (uses `pages_manage_metadata`).
5. Optionally request `pages_read_user_content` if Facebook user comments should be observed via polling (otherwise Facebook comments arrive through the webhook only).
6. Turn on `marketing.social.insights_enabled` (admin switch) — read-only.
7. Publishing itself remains a separate, later Owner decision: `marketing.a9_publish_enabled` + `marketing.destinations.meta_enabled`.
