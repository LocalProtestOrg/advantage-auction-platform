# AI-Assisted Onboarding Agents

Design planning for AI agents that support the seller onboarding experience.
These are conversational or automated agents — not Claude Code engineering agents.

---

## Agent Types Under Consideration

### 1. Seller FAQ Agent (Conversational)

**Purpose:** Answer common seller questions 24/7 without requiring ops availability.
**Channel:** Website chat widget or embedded Q&A interface
**Scope:** Information only — answers questions, explains process, links to application

**Sample questions it handles:**
- "What kinds of things do you auction?"
- "How long does the process take?"
- "Do I need to photograph items myself?"
- "How do I get paid?"
- "What happens if items don't sell?"
- "Is there a minimum value?"

**What it never does:**
- Promise specific prices or timelines
- Collect financial information
- Approve or decline applications
- Make commitments on behalf of Advantage

**Data it needs:**
- FAQ knowledge base (maintained in `/ops/onboarding/faq.md` — create when ready)
- Approved answer language for each question
- Escalation path: "For this, I'd recommend speaking directly with our team → [contact link]"

**Engineering dependency:**
- Chat widget integration (not yet scoped — submit as engineering request when ready)
- FAQ knowledge base API (or static JSON file the widget reads)

---

### 2. Application Follow-Up Agent (Automated)

**Purpose:** Detect stalled applications (form started, not completed) and send a
personalized nudge via email.

**Trigger:** Seller starts application but does not submit within 48 hours

**Action:**
1. Send email: "Were you still thinking about consigning?"
2. Include link back to the in-progress application (requires save-draft feature)
3. Offer to answer questions: "Reply to this email and I'll help."

**Engineering dependency:**
- Save-draft / resume application feature (not yet built — engineering request needed)
- Webhook or background job to detect incomplete applications after 48h
- Email delivery integration

---

### 3. Post-Auction Re-Engagement Agent (Automated)

**Purpose:** Contact sellers after their auction closes to invite them to consign again.

**Trigger:** Auction closes and seller payout is recorded

**Timing:** 30 days post-payout (give them time to process)

**Action:** Personalized email referencing their specific auction:
> "Your [estate/auction] sold [X lots] last month. If you have more items
> coming up, we'd love to work with you again."

**Engineering dependency:**
- Post-payout event hook (payout system exists; hook/trigger not yet built)
- Email delivery integration

---

## Design Principles for All Onboarding Agents

1. **Human in the loop for approvals.** No agent makes auction approval decisions.
   All agents route qualified leads to human ops review.

2. **Honest about being automated.** If the agent is a bot, it says so when asked.
   This builds trust rather than undermining it.

3. **Narrow knowledge scope.** Each agent knows about one domain (FAQ, application,
   re-engagement). It does not try to answer outside its scope.

4. **Graceful escalation.** When an agent cannot answer, it provides a clear path
   to a human: email, phone, or calendar link.

5. **No hallucination risk for financial data.** Agents never generate specific price
   estimates, sale predictions, or financial advice. These require human expertise.

---

## Implementation Roadmap (Future)

| Agent | Phase | Prerequisites |
|---|---|---|
| FAQ chat widget | Phase 1 | FAQ knowledge base, chat widget tool selection |
| Application follow-up | Phase 2 | Save-draft feature, email delivery |
| Post-auction re-engagement | Phase 3 | Payout event hook, email delivery |

---

## Tool Selection (TBD)

Chat widget and AI model selection are not yet decided. Options to evaluate:

- Hosted chat tools with AI (Intercom, Drift, Tidio)
- Custom implementation using Claude API
- Static FAQ page as an interim alternative (no engineering complexity)

*Engineering must be consulted before any production AI agent is deployed.*

*Last updated: 2026-05-11*
