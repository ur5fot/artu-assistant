# Pending actions — auto-close on browser activity (URL) (iter-3 of 3)

## Overview
Final auto-detect layer: when the owner actually visits the page a pending action points to, R2
closes the action itself. iter-1 gave the "✓ Готово" button + stores each action's `target_url`;
iter-3 makes the observer capture the **active-tab URL** and auto-closes an open action when a visited
URL matches its `target_url` (host + path). Like iter-2 it's **soft + reversible** (notice + "↩
Вернуть", reuses iter-2's reopen button + `action_autoclose_blocked_at` latch).

This is the part the owner approved URL-logging for: the observer already runs AppleScript for tab
**titles** (`window-snapshot.ts`, explicitly "title only — no URL"); iter-3 adds a URL fetch. Privacy:
the stored URL is **query/fragment-stripped** (host + path only) — enough to match `target_url`,
without capturing tokens in query strings. URLs live only in the local `data/r2.db`.

⚠️ The AppleScript URL grab can only be verified on the owner's Mac (Automation permission per
browser; headless ralphex can't test the real grab). Code is built behind an injectable provider so
unit tests mock the URL; the live grab is a manual/assisted post-deploy step.

## Context (from discovery)
- `packages/server/src/observers/window-snapshot.ts` — `createOsascriptProvider`: Call 1 = System
  Events (frontApp + generic title); Call 2 = `BROWSER_TITLE_SCRIPTS` (Chrome/Safari) for the active-
  tab title. `WindowSnapshot = {app_name, window_title}`. Add a parallel `BROWSER_URL_SCRIPTS` +
  `url?` field. The once-per-browser Automation-hint latch pattern already exists — reuse it.
- `packages/server/src/observers/window-logger.ts` — self-scheduling loop; records each snapshot via
  `WindowHistoryStore`. Blind-detection unaffected (URL is best-effort, never gates blindness).
- `packages/server/src/observers/window-history-store.ts` — `recordSample`/recent-row queries; add a
  `url` field + a `recentUrlsSince(sinceMs, limit)` read for the matcher.
- `packages/server/src/db.ts` — `window_history` table (`:407`); PRAGMA-guarded migration adds `url TEXT`.
- `topics/store.ts` (iter-1/2): `getOpenActions()` returns `{topicId,label,action,url,startedAt,
  autoCloseBlocked}`; `dismissAction`/`reopenAction`/`action_autoclose_blocked_at` already exist.
- iter-2 patterns to reuse: a cognition handler that closes actions in `onPublished` + publishes a
  notice with `buildActionReopenComponents` (`embeds.ts`) `followup:reopen:<topicId>` buttons.
  Registration mirrors `emailActionMatch` in `index.ts`.

## Development Approach
- **Testing approach**: TDD — failing snapshot/store/matcher tests first (mock the osascript provider).
- Additive & backward-safe: nullable `url` column; URL capture is best-effort (null when no
  privilege / non-browser); no behavior change to title capture, blind detection, or distraction.
- Match is **deterministic** (host + path) — no LLM. Soft + reversible; respects `autoCloseBlocked`
  and `startedAt`; dismiss only in `onPublished`.
- Out of scope: browsers beyond Chrome/Safari (add later, one script line each); storing query
  strings (privacy — stripped); fuzzy/semantic URL match.

## Testing Strategy
- snapshot: known browser → URL fetched + query/fragment stripped; no privilege → url null (title path
  unchanged); non-browser → no url.
- store: `url` persists + round-trips; `recentUrlsSince` returns url'd rows since the bound.
- matcher `actionActivityMatch`:
  - open action with target_url + a visited URL (host eq + path-prefix) after startedAt → dismiss +
    notice + reopen button.
  - visit before startedAt → no close.
  - host matches but path unrelated → no close (no bare-domain over-match).
  - autoCloseBlocked action → never closed.
  - action without target_url → ignored.

## Implementation Steps

### Task 1: Observer captures active-tab URL (snapshot + store + migration)
- [x] `window-snapshot.ts`: add `BROWSER_URL_SCRIPTS` (Chrome: `get URL of active tab of front
      window`; Safari: `get URL of current tab of front window`); add `url?: string` to
      `WindowSnapshot`; fetch for known browsers (Call 3), reuse the once-per-browser hint latch;
      **strip query + fragment** before returning (store host+path only).
- [x] `window-history-store.ts`: thread `url` through `recordSample`; add `recentUrlsSince(sinceMs,
      limit): {url, last_seen_at}[]` (url IS NOT NULL).
- [x] `db.ts`: PRAGMA-guarded `ALTER TABLE window_history ADD COLUMN url TEXT` (nullable).
- [x] tests: snapshot url-fetch + strip + no-privilege fallback; store url round-trip + recentUrlsSince
- [x] run `npm test` — must pass before next task

### Task 2: actionActivityMatch cognition handler
- [x] new `cognition/handlers/actionActivityMatch.ts`: `createActionActivityMatchHandler({
      windowHistoryStore, topicStore, lookbackHours=72 })`.
- [x] `trigger`: true only if some open action has a `target_url` and is not `autoCloseBlocked`
      (cheap; no heavy work in trigger). Short cooldown after a publish (mirror emailActionMatch).
- [x] `run`: for each eligible open action, normalize `target_url` → {host, path}; scan
      `recentUrlsSince(now - lookback)` for a visit with host equal AND path-prefix match (require the
      action path to have ≥2 segments so a bare domain can't match), `last_seen_at >= action.startedAt`;
      on match → collect; dismiss each in `onPublished`; return `{publish, content: notice, components:
      buildActionReopenComponents(closed)}`; none → `{skip}`.
- [x] register conditionally in `index.ts` (window logger enabled + topicStore present).
- [x] tests (match→close+notice+button, pre-startedAt→no, path-mismatch→no, blocked→no, no-url→no)
- [x] run `npm test` — must pass before next task

### Task 3: Verify acceptance & build
- [ ] verify (automated, mocked provider): seeded window_history URL matching an open action's
      target_url → handler closes it + notice; non-matching/old/blocked → not closed.
- [ ] run full suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` — no type errors
- [ ] confirm additive + safe (nullable url; best-effort capture; title/blind paths unchanged)

## Technical Details
- URL match: host equality (after `www.`-strip) AND visited-path starts-with action-path (trailing
  slash ignored), action path ≥2 segments. Deterministic; reversible via "↩ Вернуть".
- Reuses iter-2: `onPublished`-dismiss, `action_autoclose_blocked_at` latch (reopen → never re-close),
  `buildActionReopenComponents`, cognition publish (DM + redelivery + published_at).
- Privacy: stored URL is host+path only (query/fragment stripped); URLs only in local `data/r2.db`.

## Post-Completion
*Items requiring manual / on-device action — informational only*

**Deploy** (per flow): ralphex on `dev`; `dev`→`master` + `git push origin master`; **stay on
`master`**; supervisor auto-restarts.

**On-device verification (required — ralphex can't do this):**
- Grant Automation permission: System Settings → Privacy & Security → Automation → node/R2 → Chrome
  (& Safari) if not already (the snapshot hint logs which is missing).
- Open Chrome to a URL, wait one logger tick (~30s), then confirm `window_history.url` is populated
  (host+path, no query). I can drive/observe this via the Chrome MCP + a DB check after deploy.
- End-to-end: an open action whose `target_url` you then visit → next tick R2 DMs "✅ Закрыл «…» — ты
  открывал страницу [↩ Вернуть]".

**Completes the staged feature** (iter-1 button + iter-2 email + iter-3 activity). After this, a pending
action closes by: visiting its page, a confirmation email, OR the manual "✓ Готово" button.
