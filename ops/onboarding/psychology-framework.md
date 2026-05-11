# Onboarding Psychology and Conversion Framework

Defines the psychological model underlying Advantage's seller onboarding —
what sellers feel at each stage, what creates friction, and how the experience
resolves it.

---

## The Seller's Emotional Journey

Estate and liquidation sellers are typically:

- Under time pressure (estate settlement deadline, lease end, business closure)
- Emotionally invested (family items, lifetime of work, business legacy)
- Uncertain about value (worried about underselling, don't know market prices)
- Trust-sensitive (concerned about handing over valuable items to strangers)
- Process-naive (have never used an online auction platform)

These conditions create predictable friction points. Each stage of onboarding
should be designed to reduce a specific fear or uncertainty.

---

## Friction Map

| Stage | Primary fear | Resolution |
|---|---|---|
| Awareness | "Is this legitimate?" | Trust signals: business history, testimonials, professional brand |
| Landing page | "Is this right for MY situation?" | Scenario-specific copy — speak to exactly their context |
| Application start | "What are they going to do with my information?" | Minimal fields, privacy assurance, clear next step |
| Application mid | "This is more complicated than I thought" | Progress indicator, simple language, save-and-return |
| Post-application wait | "Did anyone actually receive this?" | Immediate confirmation email, clear timeline expectation |
| Assessment call | "Will they try to lowball me?" | Education-first approach — explain the process before discussing value |
| Activation | "What if nothing sells?" | Honest expectations, reserve option (if enabled), buyer base info |
| Live auction | "Is anyone actually bidding?" | Real-time visibility, progress updates |
| Payout | "Did I get what I deserved?" | Transparent statement, clear fee breakdown |

---

## Conversion Principles

### 1. Reduce decisions, don't add them.
Every extra choice or field on the application reduces completion rate. The form
should ask only what ops needs to make a qualified decision — nothing more.

### 2. Show the next step, not the whole journey.
Sellers who see the full scope of the process get overwhelmed. Each page shows
only what happens immediately next, with a single CTA.

### 3. Social proof at the right moment.
Testimonials and past auction results are most effective just before a commitment
decision — not in the awareness phase. Place social proof near the primary CTA.

### 4. Fast personal response beats automation.
A personal email from a real ops team member within hours of application submission
is more valuable than any automation sequence. Invest in response speed.

### 5. Language mirrors the seller's vocabulary.
Use "estate contents," "consign," "items," not "lots," "inventory," "assets" with
first-time sellers. Match their vocabulary to reduce cognitive load.

---

## Application Form Psychology

**Fields to include (minimum viable):**
- Name
- Email
- Phone
- City / state (for pickup logistics)
- Brief description of what they want to auction (text area)
- Rough timeline ("within 2 weeks", "1-3 months", "not urgent")
- How they heard about Advantage (attribution)

**Fields to avoid at application stage:**
- Detailed item lists (ask after qualification, not before)
- Estimated value (creates anchoring problems — let ops assess)
- Address (not needed until auction is scheduled)

**UX principles:**
- Single-column form on mobile
- Progress bar if multi-step
- Auto-save draft to prevent loss on navigation
- Confirmation page: "What happens next" with timeline

---

## Post-Application Email Sequence

The ops response is the most important touchpoint. If ops cannot respond within
[X hours], an automated holding email should set expectations:

> "We received your submission and will be in touch within [X] business hours.
> In the meantime, here's what the process typically looks like..."

This reduces anxiety and prevents the seller from submitting elsewhere.

---

## AI Onboarding Agent Considerations

*(See `ai-agents/README.md` for full design)*

An AI agent can assist onboarding by:
- Answering common seller questions 24/7 (FAQ-style)
- Pre-qualifying leads before ops review
- Sending personalized follow-up when applications stall
- Drafting the initial ops response for review

The agent must never:
- Make promises about sale price or timeline
- Collect financial information
- Bypass the human ops review step for auction approval

*Last updated: 2026-05-11*
