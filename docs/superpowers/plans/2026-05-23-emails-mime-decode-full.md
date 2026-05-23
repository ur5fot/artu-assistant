# Emails: full MIME decoding (base64 + bodyStructure)

## Overview

Quick patch in commit `320f3d8` decoded quoted-printable bodies and RFC2047
headers, but **base64-encoded bodies remain raw**. HTML emails (Upwork,
Djinni notifications, marketing) typically use `Content-Transfer-Encoding:
base64`, so the user still sees `PHN0eWxlPi4uLjwvc3R5bGU+...` gibberish in
snippets, digests, and `emails_get` output. The scorer also feeds garbage
to the LLM, which under-scores those emails.

This plan finishes the job: read `bodyStructure` per message, dispatch the
right decoder (base64 / qp / 7bit / 8bit) for the first text part, decode
charset, and tighten the patch's loose ends (string-path regression risk,
missing tests, type shim, parameter ceiling).

## Context (from discovery)

**Files involved:**
- [packages/server/src/emails/imap-client.ts](../../packages/server/src/emails/imap-client.ts) — fetch + decode
- [packages/server/src/emails/__tests__/imap-client.test.ts](../../packages/server/src/emails/__tests__/imap-client.test.ts) — existing tests use already-decoded mocks; no regression coverage for decoding
- [packages/tool-emails/src/index.ts](../../packages/tool-emails/src/index.ts) — `since_hours` clamp ceiling
- [packages/tool-emails/src/__tests__/index.test.ts](../../packages/tool-emails/src/__tests__/index.test.ts) — clamp tests

**Patterns found:**
- imapflow exposes `bodyStructure` (no extra round-trip — request it in the same `fetchAll` call)
- `libqp` and `libmime` are transitive deps via imapflow; available without adding to `package.json`
- Project uses `@ts-expect-error` workarounds for untyped modules — should consolidate via a `.d.ts` shim

**Dependencies identified:**
- `libqp` (transitive) — `decode(string|Buffer) → Buffer`
- `libmime` (transitive) — `decodeWords`, `charset.decode`
- Node built-in `Buffer.from(s, 'base64')` — base64 decode

**Review findings to address (from prior turn):**
1. 🔴 base64 bodies not decoded
2. 🔴 string-path regression in `firstBodyPart` — `libqp.decode` on already-decoded unicode string corrupts data
3. 🟡 zero test coverage for `decodeHeader`, QP body decode, base64 body decode, encoded `formatFrom`
4. 🟡 `@ts-expect-error` is fragile if upstream adds types
5. 🟡 `since_hours` max == default → parameter lost meaning
6. 🟢 `Buffer.toString('binary')` is deprecated alias — use `'latin1'`
7. 🟢 Misleading comment claiming bodyStructure costs an extra fetch

## Development Approach

- **Testing approach**: Regular (code first, then tests per task)
- Complete each task fully before the next
- Small, focused changes
- **Every task includes new/updated tests**
- All tests pass before next task — no exceptions
- Update this plan if scope shifts

## Testing Strategy

- **Unit tests** required per task
- No e2e: email flow is server-only (no UI)
- Mock imapflow `fetchAll` / `fetchOne` returns with realistic envelopes:
  - QP-encoded text/plain body
  - base64-encoded text/html body
  - 7bit ASCII body
  - `=?utf-8?Q?…?=` subject + name
  - `=?utf-8?B?…?=` subject
  - `=?KOI8-R?Q?…?=` subject (non-UTF charset)
  - empty / missing parts

## Progress Tracking

- Mark items `[x]` immediately on completion
- ➕ for newly discovered tasks
- ⚠️ for blockers

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, type shims, documentation in this repo
- **Post-Completion** (informational): manual rebuild restart, optional DB cleanup of stale rows

## Implementation Steps

### Task 1: Add type shim for libqp / libmime / libbase64

- [ ] create `packages/server/src/emails/mime-shims.d.ts` with `declare module 'libqp'; declare module 'libmime'; declare module 'libbase64';` (libbase64 needed in Task 3)
- [ ] remove `// @ts-expect-error` lines on libqp/libmime imports in `imap-client.ts:2-5`
- [ ] verify `npx tsc --noEmit -p packages/server/tsconfig.json` passes
- [ ] write test `mime-shims.test.ts` that imports all three modules and asserts they expose expected functions (`libqp.decode`, `libmime.decodeWords`, `libbase64.decode`) — guards against missing transitive deps after package-lock churn
- [ ] run server tests — must pass before Task 2

### Task 2: Extract decoder helpers into module + fix string-path regression

- [ ] create `packages/server/src/emails/mime-decode.ts` with three exported functions:
  - `decodeHeader(s: string | null | undefined): string` — RFC2047 + try/catch fallback, moved from `imap-client.ts`
  - `decodeBodyPart(value: unknown, encoding: string | null, charset: string | null): string` — dispatches by encoding (base64 / quoted-printable / 7bit / 8bit / unknown), then decodes charset to UTF-8 string
  - `pickTextPart(bodyStructure: any): { partId: string; encoding: string; charset: string; type: string } | null` — walks bodyStructure tree, prefers `text/plain` over `text/html`, returns first match or null
- [ ] `decodeBodyPart` rules:
  - if `value` is `Buffer`: use `libqp.decode(buf.toString('latin1'))` for QP, `Buffer.from(buf.toString('latin1'), 'base64')` for base64, raw Buffer for 7bit/8bit, falls through to `libqp.decode` for unknown
  - if `value` is `string`: only QP-decode if `/=[0-9A-F]{2}/i.test(value)` heuristic matches; otherwise return as-is (preserves already-decoded unicode strings — fixes prior regression)
  - charset decode via `libmime.charset.decode(buf, charset || 'utf-8')`; on failure fall back to `buf.toString('utf-8')`
- [ ] update `imap-client.ts` to import from `mime-decode.ts`, remove inline `decodeHeader` and `firstBodyPart`
- [ ] write `mime-decode.test.ts` with table-driven cases:
  - decodeHeader: plain ASCII, `=?utf-8?Q?...?=`, `=?utf-8?B?...?=`, null/undefined, malformed input → fallback
  - decodeBodyPart Buffer: QP UTF-8, base64 UTF-8, 7bit ASCII, 8bit Latin-1 (`charset=ISO-8859-1`), unknown encoding falls back to QP, empty Buffer
  - decodeBodyPart string: plain unicode (`'Привет'`) returns unchanged, ASCII QP-like (`=D0=9F`) gets decoded
  - pickTextPart: text/plain preferred over text/html, finds nested in multipart/alternative, returns null when no text part
- [ ] run server tests — must pass before Task 3

### Task 3: Wire bodyStructure into fetchNewMessages

- [ ] add `bodyStructure: true` to `client.fetchAll` query in `fetchNewMessages`
- [ ] on each row: call `pickTextPart(row.bodyStructure)` to find which part to fetch and how to decode
- [ ] if `pickTextPart` returns non-null and its partId differs from `'1'`, request that part — but **stay within a single `fetchAll`**: pass all needed partIds in `bodyParts` array (e.g., `bodyParts: ['1', '1.1', '2']`) on the initial call. Avoid per-message re-fetch.
- [ ] decode chosen part via `decodeBodyPart` with the encoding/charset from bodyStructure
- [ ] if no text part found (image-only emails, etc.) → snippet = `''` (gracefully empty rather than raw base64 of an image)
- [ ] remove misleading comment `"bodyStructure round-trip would be cleaner but requires an extra IMAP fetch"` — replace with note that bodyStructure rides on the same fetch
- [ ] write `imap-client.test.ts` additions:
  - mock returns text/plain QP part → snippet decodes
  - mock returns text/html base64 part → snippet decodes (html tags fine, just decoded)
  - mock returns multipart/alternative with text/plain + text/html → snippet uses text/plain
  - mock returns no text part (only image) → snippet is empty string, not raw base64
  - mock returns encoded subject + encoded `from.name` → both decoded in NewMessage
- [ ] run server tests — must pass before Task 4

### Task 4: Wire bodyStructure into fetchFullBody

- [ ] mirror Task 3 changes in `fetchFullBody`: add `bodyStructure: true`, pick text part, decode via `decodeBodyPart`
- [ ] preserve newlines for full body (existing `extractBody` semantics): `decodeBodyPart` returns the decoded UTF-8 string; `extractBody` then normalizes CRLF and applies length cap
- [ ] for HTML-only emails, the body returned by `emails_get` will be the decoded HTML. That's correct — user can read it. Optional: strip HTML tags via simple regex when picked part is text/html. Decide YAGNI: skip stripping unless tests show user complaint. Default = decode and return as-is.
- [ ] write `imap-client.test.ts` additions:
  - `fetchFullBody` with QP body → decoded
  - `fetchFullBody` with base64 body → decoded
  - `fetchFullBody` preserves newlines
  - `fetchFullBody` truncates with marker when over `FULL_BODY_LEN`
- [ ] run server tests — must pass before Task 5

### Task 5: Fix `since_hours` ceiling in tool-emails

- [ ] raise `since_hours` clamp max from 720 → 8760 (1 year) in `tool-emails/src/index.ts` `clampInt` call
- [ ] keep default at 720 (30 days) — sensible window for "show me recent important mail"
- [ ] update parameter description to reflect new ceiling: `'За сколько часов назад смотреть (default 720 = 30 дней, max 8760 = 1 год)'`
- [ ] update existing `__tests__/index.test.ts` "clamps since_hours" test: `since_hours: 99_999` should now clamp to 8760, not 720
- [ ] add test case for `since_hours: 8760` (boundary) — should pass through unchanged
- [ ] run tool-emails tests — must pass before Task 6

### Task 6: Replace deprecated `'binary'` encoding alias

- [ ] sweep `imap-client.ts` and `mime-decode.ts` for `Buffer.toString('binary')` and `Buffer.from(s, 'binary')`
- [ ] replace with `'latin1'` (functionally identical, not deprecated)
- [ ] write test asserting equivalence is preserved (one case round-tripping a Buffer through both encodings produces equal bytes)
- [ ] run server tests — must pass before Task 7

### Task 7: Verify acceptance criteria

- [ ] verify all 7 review findings from Overview are addressed
- [ ] verify edge cases:
  - empty envelope.from → 'unknown'
  - empty subject → ''
  - missing bodyStructure → snippet=''
  - charset name imapflow doesn't recognize → utf-8 fallback (no throw)
- [ ] run full test suite from repo root: `npm test` — all 2006+ tests must pass
- [ ] run `npx tsc --noEmit -p packages/server/tsconfig.json` and `-p packages/tool-emails/tsconfig.json` — no errors
- [ ] verify no `@ts-expect-error` remain for libqp/libmime/libbase64

### Task 8: [Final] Update documentation

- [ ] add a short note in [README.md](../../README.md) under "Emails" section: "Bodies and headers are MIME-decoded (quoted-printable, base64, charset). Stale rows from before this fix may still display raw encoding — they're already marked delivered."
- [ ] add JSDoc block at top of `mime-decode.ts` explaining what each helper does and why bodyStructure dispatch was chosen over blanket QP decode

## Technical Details

**Data structures:**
- `bodyStructure` is a nested tree:
  ```
  { type: 'multipart/alternative', childNodes: [
    { type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' }, part: '1' },
    { type: 'text/html',  encoding: 'base64',           parameters: { charset: 'utf-8' }, part: '2' },
  ]}
  ```
- For single-part emails, `bodyStructure` itself is the leaf with `part` undefined (treat as `'1'`)

**Decode dispatch:**
| encoding | decoder |
|----------|---------|
| `quoted-printable` | `libqp.decode(buf.toString('latin1'))` |
| `base64` | `Buffer.from(buf.toString('latin1'), 'base64')` |
| `7bit`, `8bit`, undefined | raw Buffer |
| anything else | log warn, fall through to QP |

After decoding bytes, apply `libmime.charset.decode(buf, charset || 'utf-8')` to get UTF-8 string.

**Processing flow:**
1. `fetchAll` with `envelope`, `internalDate`, `bodyStructure: true`, `bodyParts: ['1']` initially
2. After first fetch, scan returned rows; if any row's `pickTextPart` returns a partId not in the requested set, do a single follow-up `fetchAll` for those specific UID+partId pairs
3. Alternative (simpler, current task description): just always request `['1', '1.1', '2']` upfront — small bandwidth cost, eliminates round-trip logic. **Choose this for YAGNI.**

## Post-Completion

**Manual verification:**
- Restart `npm run dev`; wait one poll cycle (5 min)
- New emails arriving should show readable subjects/snippets in next digest and `emails_list`
- Spot-check an Upwork (HTML/base64) email via `emails_get` from chat: body should be readable HTML, not raw base64

**External system updates:**
- None — feature is internal to R2

**Stale data cleanup (optional, not required for plan completion):**
- The 18 emails captured before the quick patch have raw QP snippets in DB. They're already `delivered_at != NULL` so won't surface in digest. If user wants clean state: `DELETE FROM email_pending WHERE id IN (<those ids>)` and reset `email_account_state.last_seen_uid = 0` to refetch. Not part of this plan.
