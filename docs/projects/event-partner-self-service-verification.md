# Event Partner self-service verification — the lightweight trust ladder

Owner policy, 2026-09-12. **Supersedes** the technical domain-control proposal in
`event-partner-communications-audit-phase2.md` §10.

## Governing principle

> No ordinary estate sale company or auction house should need to understand DNS, upload verification
> files, or perform technical domain administration just to allow Advantage.Bid to promote its public
> events. This program succeeds only if participation feels nearly effortless.

The security model must prevent **obvious abuse** without putting every legitimate company through
enterprise identity verification. Friction is not created merely because abuse is theoretically
possible.

The abuse that actually matters is narrow and specific: somebody authorizing a website that is not
theirs — most damagingly, a competitor's. The ladder below is calibrated to that risk and nothing
more.

## The ladder

Evaluated in order. The first path that applies wins.

### Path A — requester email domain matches the company website

```
Website:   abcestatesales.com
Requester: mary@abcestatesales.com
```

Proceed **directly** to the secure authorization flow when all of the following hold:

- the business appears legitimate;
- the requested website is publicly reachable;
- the email domain reasonably matches the company website (equal, or a subdomain of it);
- there are no conflicting company records or suspicious signals.

No DNS record. No uploaded file. No verification ceremony. Controlling `name@company.com` is
sufficient evidence for this purpose.

### Path B — requester uses a free or personal mailbox (primary fallback)

```
Website:   abcestatesales.com
Requester: marysmith@gmail.com
```

Do **not** reject. Inspect the company's own public website for an official contact address, and send
a short confirmation link **to that published address** — never to the requester's mailbox.

The requester is told, in substance:

> We see that the email address you entered is not associated with **{Company}**'s website.
>
> For your protection, we've sent a quick verification link to the contact email published on
> **{Company}**'s website. Please have the person responsible for that email open the message and
> confirm the request. That's all we need.

When that link is confirmed, the normal authorization flow continues. This is the **primary**
fallback path and should carry most non-matching requests.

### Path C — an existing trusted Advantage.Bid relationship

Reuse it rather than inventing new verification. Qualifying relationships:

- a claimed Professional listing for the company;
- a verified Professional Seller account;
- a known verified organization contact;
- an existing trusted company or member relationship;
- any other Advantage.Bid identity already proven to represent the organization.

### Path D — no company email can be found

When the requester uses a personal mailbox, the company website publishes no usable contact address,
and no trusted relationship exists: **do not fall back to DNS or file verification.** Flag for
lightweight Admin review, presenting the company website, requester name and email, public company
details, and any existing directory or listing match. An administrator may approve a request that is
obviously legitimate.

Technical domain verification exists only as an exceptional fallback, never as the normal experience.

### Path E — suspicious or conflicting request

Require human review only when signals are genuinely concerning:

- the requester is attempting to authorize a domain associated with another verified Advantage.Bid
  organization;
- the company explicitly disputes the request;
- website or contact information conflicts materially;
- the request appears abusive or fraudulent;
- multiple unrelated parties are attempting to control the same company;
- the source is not actually a legitimate professional estate sale or auction business.

## What the company is never asked to do

Create an account. Choose a password. Select an importer technology. Configure a feed. Upload events.
Understand structured data. Modify DNS under normal circumstances. Complete a long seller application.

## What the public form collects

Company name, company website, requester name, requester email. Nothing else.

## Invariant preserved

The trust ladder decides **whether an authorization link may be issued**. It never *is* the
authorization. Permission is still recorded only by the deterministic, single-use, evidence-backed
authorization action from Phase 1, and `authorization_method` remains limited to its four approved
evidence types.
