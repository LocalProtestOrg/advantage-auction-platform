# Member-Neutral Import Architecture

Owner architectural correction, 2026-09-24. Migration 168.

## Rule
No Advantage.Bid member has a privileged inventory integration. Every Professional Seller uses the same paths:

1. **Member account** (primary): the member publishes its auctions and events itself.
2. **Member Feed Sync** (optional, generic): the member authorizes us to sync a feed it publishes itself (RSS, iCal or JSON-LD).
   - The feed lives on the single `member-feeds` import source.
   - It is fetched only while its recorded consent (`granted_by`, `granted_at`, `evidence`) is present and not revoked (`feedConnector.hasMemberConsent`).
   - Events are hosted by the owning member (`authorized_source`).
   - Admin endpoints: `GET/POST /api/admin/event-imports/member-feeds` and `POST /member-feeds/revoke`, all audited.

The rule rules out:
- a company-specific connector
- a crawler or browser-identity exception
- a special crawler permission request
- a default member in tooling
- a member source that inventory health depends on

**Generic external discovery** (government surplus, original-host public listings) stays on its own separate sources.

## Retired
The dedicated Lewis & Maese connector, its registration script and its test suite have been removed.

The `lmauction-lewis-maese` source row is `disabled` with health `RETIRED` and a recorded `retired_reason`. The row and its run history are kept.

Lewis & Maese remains a normal member. Nothing about its membership was touched:
- organization, member account and Professional Seller status
- events, including its historical imported events and their attribution
- orders and agreements
- negotiated pricing

`getConnector` now fails closed on an unknown selector, so a retired source can never silently run as another connector.

## Health
- Retired sources are not live and are not action items.
- Image placeholder policy is the source config flag `placeholder_images`, not a source name.
- Supply shortfalls, such as the external auction target and missing estate sales, still report as DEGRADED. Retirement never makes the system look HEALTHY.
