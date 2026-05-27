# Toward an ideal R2 — use-case-first roadmap

> Strategic plan, not a task spec. Implementation plans for each phase live as
> separate `docs/superpowers/plans/*.md` documents and get executed via
> ralphex one at a time.

## Why this rewrite

The previous 4-phase plan (context engine → feedback loop → undo →
transparency) was infrastructure-first: spend ~6-8 weeks building general
plumbing in hopes that proactive features become easy afterwards. Three
problems with that:

1. **Six weeks without visible value.** Motivation runs out before payoff.
   Easy to drop the project before any of the four phases ships end-to-end.
2. **Premature generalization.** A "context fusion module" designed before
   any concrete feature needs it is usually wrong in ways that only surface
   later, when refactoring is expensive.
3. **Explicit feedback assumes user discipline we don't have.** Three-button
   "spot on / so-so / shut up" requires the user to actually click. In
   practice, 80% of proactive nudges get ignored — silence is the dominant
   signal. The original plan didn't have a story for that.

This version flips it: **one pain at a time, infra grows only as needed.**

## Principle: one pain, end-to-end, before the next

Pick the single biggest concrete annoyance R2 could solve right now. Build
the whole loop for it — observation, suggestion, action, learning,
transparency — even if the implementation is hardcoded and not reusable.
Ship it. Live with it for two weeks. Then:

- If it works → extract the reusable parts into modules. Pick the next pain.
- If it doesn't → the failure mode tells you which assumption was wrong.
  Cheap lesson; no infrastructure to rip out.

Infra-first hides whether the idea works behind whether the framework was
designed well. Use-case-first separates them.

## Pain #1 — Important email triage (June 2026)

**Concrete goal:** by end of June, R2 catches ≥ 80% of emails that need a
response within 24 hours, before the user opens the inbox, and offers a
one-click draft reply for half of them.

### What gets built

Minimal version of each "ideal R2" trait, scoped to email only:

1. **Better observation.** Email watcher already exists. Upgrade scorer
   from single-pass importance score to a structured output:
   `{importance, action_needed, suggested_response_type, deadline_hint}`.
   Same Claude call, richer JSON.

2. **Proactive surfacing — but quieter.** Currently `emailDigest` fires
   when N pending accumulate. New: per-email immediate ping for `importance ≥ 8 AND action_needed = true`, suppressed in quiet hours. Digest stays for the long tail.

3. **One-tap action.** Embed includes a "Draft reply" button. R2 generates
   a draft via Claude (with full thread context), posts as ephemeral
   message with Send / Edit / Cancel buttons. Send goes through SMTP.

4. **Undo zone.** Sent draft has a 30-second hold window in DB before
   actually going out. "Cancel send" button on the original embed for those
   30 sec. After that, undo is impossible (acknowledge that openly).

5. **Implicit feedback — silence is data.** Track per-email:
   - Did user open the inbox within X min of the ping? (positive — R2's
     ping was useful)
   - Did user reply within Y hours? (positive — was actionable)
   - Did user ignore the embed for > 24 h? (negative — false positive)
   - Did user click "shut up" (new button)? (strong negative, suppresses
     similar senders/subjects for a week)
   
   Aggregate into a per-sender × subject-pattern score. Adjust threshold
   for surfacing dynamically.

6. **Transparency — one slash command.** `/why email <id>` shows the
   scorer's reasoning and what feedback signals exist for similar past
   emails. No big decision log yet — just for this feature.

### What does NOT get built yet

- General context fusion module
- Active window logger
- Calendar integration
- Generic action log with undo
- Generic feedback loop framework
- HA integration
- Camera, voice, vision

If any of the above seems necessary mid-implementation, that's a signal —
stop and reconsider whether the email use case actually needs it, or whether
it's premature generalization.

### Success criteria

End of June, looking back at the month:

- ≥ 80% of "important" emails (judged in hindsight by user) got a ping
  before user opened inbox manually
- ≤ 15% of pings were false positives ("shut up" clicked or ignored for
  > 24 h on first occurrence)
- ≥ 30% of replies sent that month went through R2's draft (rather than
  user typing from scratch)
- Median time-to-reply for actionable emails halved compared to May

If 2 of 4 hit → ship and keep. If 3 of 4 → extract patterns into reusable
modules. If < 2 → diagnose what failed, don't move to pain #2 yet.

### Estimate

3 weeks of vibe-coded work with Claude + ralphex. Half spent on the
implicit-feedback signal aggregation (the genuinely new part), the other
half on UI polish and SMTP send flow.

## Pain #2 — Candidate list (pick after #1 ships)

Don't commit now — depends on what we learn from #1. Candidates ranked
by likely impact:

- **Calendar pre-warn** — "your call with X is in 15 min, here's the last
  thread, agenda from last week, open these docs." Reuses observation
  patterns from emails (read events, score importance, ping before).
- **Tab restore on context switch** — "I noticed you switched from coding
  to email an hour ago and back. Want the editor tabs/PDFs/terminal state
  from before?" Needs active-window logger — first time we'd actually build
  it, and now we know the shape from email work.
- **Home Assistant — light off after leaving** — separate from PC context,
  but ideal for honing the action-with-undo pattern in a low-risk domain
  (toggling a light back on is trivial; sending an email back is not).

Pick whichever feels most painful after living with #1 for two weeks.

## What we extract into shared modules after #1

Only after pain #1 ships and works:

- **Implicit feedback signal aggregator** — if it worked for emails, it can
  work generically. Module that takes (handler, situation, user action,
  timing) and produces a score adjustment.
- **Undo-zone action wrapper** — if 30-second SMTP hold worked, generalize
  for any "send / commit" action: schedule action with grace period, cancel
  button in embed, execute on timeout. Backbone for future actions.
- **Per-feature `/why` pattern** — turned out useful for emails; standardize
  the shape so future handlers get it for free.

What we explicitly **don't** extract until pain #3 forces it:

- A general "context fusion model" abstraction. Wait until we have actual
  evidence of which signals matter for which decisions.
- A generic action log with universal undo. Wait until we have 3+ different
  action types — only then is the abstraction grounded.

## Things this plan still doesn't solve

Honest gaps, listed so future-me sees them:

- **Multi-device.** Plan assumes single-host R2. If user works from laptop
  + Mac Mini + phone, signals scatter. Defer until Mac Mini lands as the
  always-on host (separate decision).
- **Degraded mode.** What R2 does when Ollama / Anthropic / IMAP is down.
  Currently: silent. Should be: "I'm half-blind right now, don't trust my
  suggestions" — but that's a polish item, not a pain in itself.
- **Trust ceiling.** This plan assumes user wants to delegate more over
  time. May turn out user wants a hard cap at ~30% delegation and treats
  R2 as a thinking partner, not a doer. Pain #1's success criteria will
  reveal this — if user keeps clicking Edit instead of Send on drafts, the
  delegation hypothesis is wrong.
- **Reset on preference drift.** User wants morning brief at 08:00 today,
  at 06:00 after moving to a new schedule. Implicit feedback should pick
  this up over a week, but the explicit "I changed, forget what you learned"
  path is not designed.

## Operating principles

- One pain at a time. No parallel pains until the first ships.
- 3 weeks per pain, hard cap. If it slips past 4, descope or rethink.
- Each pain produces a `docs/superpowers/plans/YYYY-MM-DD-<pain>.md` with
  TDD-grade implementation steps. This document is the strategy on top.
- After each pain, write a short retro: what worked, what didn't, what to
  reuse, what to discard. Update this document.
- "Built but not used" code is technical debt — delete on retro if no real
  user demand.

## Status

- **2026-05-27** — plan drafted. Pain #1 (email triage) targeted for June 2026.
- Next: write the detailed implementation plan for pain #1, review, then
  run through ralphex one sub-task at a time.
