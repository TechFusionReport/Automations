# TechFusion OS — Architecture & Documentation Contract

**Status:** Adopted v1.2 — signed off by Justin, 2026-08-23
**Canonical copy:** [Notion](https://app.notion.com/p/3c5bd080de9281de81c6f4f883adaa6e). **This file is a reference copy** (kept in sync manually; if the two ever disagree, the Notion page wins — see §2).
**Applies to:** `TechFusionReport/Website`, `TechFusionReport/Automations`, Notion workspace, Master Task Tracker, Command Center
**Binds:** Claude and ChatGPT equally. Neither AI has domain ownership by identity — governance determines what can change and how, not which AI is asking.

## 0. Participants

There are exactly three parties in this system — no other humans or agents are involved:

- **Justin** — the sole human. Final approval authority on everything High-tier and on this document itself.
- **Claude**
- **ChatGPT**

Every reference to "human review," "human approval," or "the reviewer" elsewhere in this doc means Justin specifically — there is no separate approver pool or team to route to.

## 1. Purpose

Claude and ChatGPT both have direct write access to the same GitHub repos and Notion workspace. This doc is the single contract both are instructed against so that:

- either AI can pick up any task without re-negotiating ownership every time
- risk is gated by what's being touched, not by who's touching it
- there's one answer to "which system is right" when two sources disagree
- work is traceable: task → implementation → PR → review → merge → deployment

This document itself is canonical. If any other doc, memory, or conversation conflicts with it, this document wins until amended (see §7).

## 2. Source-of-Truth Hierarchy

When two systems disagree, the higher layer wins:

1. **This document** (TechFusion OS architecture/governance) — canonical
2. **GitHub** — authoritative implementation state
3. **Master Task Tracker** — authoritative work/coordination state
4. **Cloudflare / runtime systems** — authoritative deployed/health state
5. **ChatGPT memory / Claude persistent memory** — context cache only, never authoritative. When memory represents state also tracked by an authoritative system above, that system always wins — memory must never override it.
6. **Individual conversations** — ephemeral, non-authoritative

Practical rule: if a conversation or a memory entry says one thing and GitHub or the Task Tracker says another, GitHub/Task Tracker is correct. Update the memory, not the other way around.

## 3. Risk Tiers

Risk is defined by **capability and path**, not by a fixed filename list — new files inherit the correct tier automatically as the codebase grows.

### Low — AI-implemented, automated checks, merge without human gate
Presentation, copy, CSS, static content, non-destructive UI changes.

### Medium — review by the other AI, or by Justin, before merge
Schemas, coordination structures, operational config, architecture changes that don't directly mutate production state.

### High — Justin's approval always, no exception tier
Publishing/state-transition logic, any Content Catalog write path, auth/secrets, destructive DB operations, production routing/security.

Known High-tier examples today: `discovery.js`, `enhancement-poller.js`, `publisher-poller.js`, and anything writing to Content Catalog v2's write path. This list is illustrative, not exhaustive — the category (capability) is what actually governs.

## 4. Provenance

Use normal [Conventional Commits](https://www.conventionalcommits.org/) for commit subjects — e.g. `feat(ops): add system health aggregation`. **Do not** prefix commits with `[GPT]` / `[Claude]`.

Provenance is recorded in PR metadata instead, via the PR template (§8):

- `Agent:` — which of the three (Justin, Claude, or ChatGPT) did the work
- `Requested-by:` — who asked for it (in practice, almost always Justin; occasionally an AI acting on a standing instruction)
- `Task:` — Master Task Tracker link (primary linkage; `N/A` only for hotfixes)

Task is the backbone: task → implementation → PR → review → merge → deployment should be traceable end to end from the Task Tracker row.

## 5. Routing Heuristic

**Claude is the default entry point for new tasks.** Justin brings new work to Claude first, regardless of what it turns out to be. Claude checks the Task Tracker for existing claims, applies the risk tier (§3), and in the first response either:

- handles it directly, or
- hands off to ChatGPT with a ready-to-paste prompt (self-contained, since ChatGPT doesn't share this conversation's context) and logs the Task Tracker row (Owner/Active Agent/Risk) before handing off

This replaces deciding which chat window to open with a single front door — Claude acts as dispatcher, not gatekeeper; ChatGPT can still be brought in directly by Justin at any time, and the Task Tracker (not this heuristic) is the source of truth on who currently has a task claimed.

Exceptions to "Claude first":
- the Task Tracker shows a task already claimed by ChatGPT — go straight there
- Justin is already mid-conversation with ChatGPT on something — no need to relay through Claude to continue it

This avoids re-deciding ownership from scratch on every task while still letting either AI pick up anything.

## 6. Cross-Review

For significant changes (Medium and above), one AI implements and the other reviews — against this contract and the task's acceptance criteria, not just code style. This replaces "Claude reviews everything" with a bidirectional check between equals.

High-tier changes still require Justin's approval regardless of cross-review — cross-review is additive, not a substitute for it.

### 6a. Known Limitation: Shared GitHub Identity

Justin, Claude, and ChatGPT all authenticate to GitHub as the same account (`TechFusionReport`). This was discovered in practice on 2026-08-22 when Claude's attempted `REQUEST_CHANGES` review on a ChatGPT-opened PR was rejected by GitHub itself: *"Review Can not request changes on your own pull request."*

Practical consequence: **GitHub's native "required approving review" branch-protection setting cannot function here.** There is no technical way for one of the three parties to submit a formal Approve/Request-changes review on a PR opened by another, because GitHub sees only one identity. Any branch rule combining "require approvals" with "do not allow bypassing" will permanently deadlock — no PR can ever merge.

Until separate machine identities exist for each party (a real fix, not yet built — see §9), cross-review under §6 is enforced as a **process**, not a GitHub mechanic:

- The reviewing AI leaves its verdict as a **PR comment** (not a review), referencing this section.
- A **required status check** (e.g. the Automations PR-metadata validator) is the correct GitHub-native gate to require instead of approvals — it's satisfiable regardless of identity, because it's an automated job rather than a second human/AI account.
- Justin's own click to merge is what actually stands in for "approval" on anything Medium or above — this is already true in practice, just not previously written down.

## 7. Amending This Document

Changes to this doc are always **High** tier — Justin's approval required, no exception. Either AI may propose an amendment via PR; Justin approves before merge.

## 8. Master Task Tracker — Schema Additions

Add these fields to support future enforcement without a later migration (enforcement tooling itself is not being built yet — see §9):

| Field | Purpose |
|---|---|
| `Owner` | Who's accountable for the task — Justin, Claude, or ChatGPT |
| `Active Agent` | Which AI (Claude or ChatGPT) currently has it claimed, if any |
| `Risk` | Low / Medium / High, per §3 |
| `PR` | Link(s) to the implementing pull request(s) |

## 9. Not Now (Explicitly Deferred)

- Claim-collision detection / enforcement tooling — Justin works one task at a time, so collision risk is low today. The schema fields above just leave room for this later.
- Automatic risk classification
- Automated cross-agent review assignment
- Stale-memory reconciliation tooling
- Separate GitHub identities per party (bot account or GitHub App per AI) — would resolve §6a and make native GitHub review approvals actually usable. Not urgent while the status-check workaround holds.

## 10. Implementation Order

1. Verify and establish branch protection:
   - `TechFusionReport/Website` `preview` — PR-based promotion + automated checks
   - `TechFusionReport/Automations` `main` — PR required + High-risk human approval policy
2. Extend Master Task Tracker schema (§8 fields)
3. Add standardized PR templates to both repos (§8 template)
4. Automations-only CI enforcement — validate PR metadata (not commit trailers; squash/rebase makes trailers brittle)
5. Feed Task Tracker + GitHub PR + Cloudflare/runtime health into the Command Center data layer

## 11. PR Template

Both repos use this template (`.github/PULL_REQUEST_TEMPLATE.md`):

```markdown
## Summary
<!-- What was created, updated, or fixed — 1-3 bullets, no fluff -->

## Why
<!-- One line: what triggered this change -->

## Validation
<!-- How you confirmed this works -->

## Next
<!-- What, if anything, happens after this merges -->

---
**Agent:** <Claude / ChatGPT / Justin>
**Task:** <Master Task Tracker link, or "N/A — hotfix">
**Risk:** <Low / Medium / High>
```

---
*Revision history: v1 drafted 2026-08-22 (Claude), consolidating governance design agreed with ChatGPT across two review passes. v1.1 (2026-08-22/23, Claude): added §6a documenting the shared-GitHub-identity limitation found while executing step 1 of §10, plus the corresponding §9 follow-up. v1.2 (2026-08-23, Claude): §5 rewritten — Claude is now the default entry point for new tasks (dispatcher), replacing "whichever AI the conversation is already in."*
