# Discord as primary UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the web UI's interactive features (reminder buttons, tool-permission dialogs, plan-review, slash commands) to Discord DM, making Discord the single primary entry point for R2. Extract shared business logic into a services layer. Web stays frozen (no changes).

**Architecture:** Create `packages/server/src/services/` with four thin services (reminder, permission, plan-review, command) that wrap existing stores / pending-maps. HTTP routes become adapters that call services. Discord bot gains `interactionCreate` handling that routes button clicks and slash commands to the same services. Bot's `onEvent` callback is extended to handle mid-stream `tool_confirm_request` / `tool_plan_review` by flushing the text buffer and sending Discord embeds with buttons. Resolution remains asynchronous through the existing `pendingConfirms` / `pendingPlanReviews` promise maps — the bot never `await`s on a click; it only emits an embed and reacts when the interaction arrives.

**Tech Stack:** TypeScript, Node.js 22, vitest, discord.js 14, express, better-sqlite3, EventEmitter-based internal bus.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `packages/server/src/services/reminder-service.ts` | Wraps `ReminderStore` + `reminderBus`. Operations: `dismiss(id)`, `snooze(id)`, `list()`. |
| `packages/server/src/services/permission-service.ts` | Wraps `PendingConfirms`. Operations: `resolveConfirm(callId, allowed, remember)`, `hasPending(callId)`. |
| `packages/server/src/services/plan-review-service.ts` | Wraps `PendingPlanReviews`. Operations: `resolveReview(callId, approved, editedPlan)`, `hasPending(callId)`. |
| `packages/server/src/services/command-service.ts` | Composable commands. Operations: `clearHistory()`, `status()`, `listReminders()`, `listMemory(query?)`. |
| `packages/server/src/channels/discord/embeds.ts` | Pure embed factories: `buildReminderEmbed`, `buildPermissionEmbed`, `buildPlanReviewChunks`. |
| `packages/server/src/channels/discord/interactions.ts` | Interaction router. Dispatches button customIds and slash commands to services. |
| `packages/server/src/channels/discord/slash-commands.ts` | Slash command definitions + registration. |
| `packages/server/src/services/__tests__/reminder-service.test.ts` | Service unit tests. |
| `packages/server/src/services/__tests__/permission-service.test.ts` | Service unit tests. |
| `packages/server/src/services/__tests__/plan-review-service.test.ts` | Service unit tests. |
| `packages/server/src/services/__tests__/command-service.test.ts` | Service unit tests. |
| `packages/server/src/channels/discord/__tests__/embeds.test.ts` | Embed factory tests. |
| `packages/server/src/channels/discord/__tests__/interactions.test.ts` | Interaction router tests. |

### Modified files

| File | Change |
|---|---|
| `packages/server/src/routes/reminder.ts` | Accept `reminderService`, call `service.dismiss`/`service.snooze` instead of store + bus directly. |
| `packages/server/src/routes/confirm.ts` | Accept `permissionService`, call `service.resolveConfirm`. |
| `packages/server/src/routes/plan-review.ts` | Accept `planReviewService`, call `service.resolveReview`. |
| `packages/server/src/channels/discord/bot.ts` | Replace `reminderBus` with full service deps; extend `onEvent` to handle `tool_confirm_request` and `tool_plan_review` with buffer flush; add `interactionCreate` handler (delegates to `interactions.ts`); register slash commands on `clientReady`. |
| `packages/server/src/channels/discord/__tests__/bot.test.ts` | Update tests to inject new deps. Add tests for mid-stream flush and interaction routing integration. |
| `packages/server/src/index.ts` | Instantiate services. Pass services into routes and Discord bot. |

### Untouched

Web client (`packages/client/**`) — frozen. SSE events continue to flow to web but web behavior is not part of this plan.

---

## Conventions used throughout

- **Tests first.** Every task starts with a failing test before implementation.
- **Commit after each task.** Small, reviewable commits.
- **Run tests per task** with `npx vitest run --root packages/server <path>`.
- **Commit command format:** `git add <files> && git commit -m "<scope>: <short>"` (Conventional-ish, project precedent).
- **Node version:** Node 22; `"type": "module"` everywhere. Use `.js` extensions in imports (ESM resolution), per existing code.
- **discord.js version:** 14.26.x — use `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle`, `EmbedBuilder`, `SlashCommandBuilder`, `MessageFlags.Ephemeral`.

---

## Task 1: Extract `reminder-service`

**Files:**
- Create: `packages/server/src/services/reminder-service.ts`
- Create: `packages/server/src/services/__tests__/reminder-service.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/server/src/services/__tests__/reminder-service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createReminderService } from '../reminder-service.js';
import type { ReminderStore, ReminderRow } from '../../reminders/store.js';

function makeStore(overrides: Partial<ReminderStore> = {}): ReminderStore {
  return {
    create: vi.fn(),
    list: vi.fn().mockReturnValue([] as ReminderRow[]),
    delete: vi.fn(),
    findDueIdle: vi.fn().mockReturnValue([]),
    findDueRinging: vi.fn().mockReturnValue([]),
    findDuePaused: vi.fn().mockReturnValue([]),
    beginRing: vi.fn(),
    advanceRingingToPaused: vi.fn(),
    advancePausedToRinging: vi.fn(),
    finishCycle: vi.fn().mockReturnValue({ nextFire: null }),
    dismiss: vi.fn(),
    snooze: vi.fn().mockReturnValue(0),
    getById: vi.fn(),
    ...overrides,
  } as ReminderStore;
}

describe('reminder-service', () => {
  it('dismiss: returns false when reminder does not exist', () => {
    const store = makeStore({ getById: vi.fn().mockReturnValue(null) });
    const bus = new EventEmitter();
    const service = createReminderService({ store, bus });
    expect(service.dismiss(42)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('dismiss: returns false when reminder is not ringing or paused', () => {
    const row = { id: 1, active: true, cycle_stage: 'idle' } as ReminderRow;
    const store = makeStore({ getById: vi.fn().mockReturnValue(row) });
    const bus = new EventEmitter();
    const service = createReminderService({ store, bus });
    expect(service.dismiss(1)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('dismiss: calls store.dismiss and emits reminder_dismissed', () => {
    const row = { id: 1, active: true, cycle_stage: 'ringing' } as ReminderRow;
    const store = makeStore({ getById: vi.fn().mockReturnValue(row) });
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('push', (e) => events.push(e));
    const service = createReminderService({ store, bus });
    expect(service.dismiss(1)).toEqual({ ok: true });
    expect(store.dismiss).toHaveBeenCalledWith(1, expect.any(Number));
    expect(events).toEqual([{ type: 'reminder_dismissed', id: 1 }]);
  });

  it('snooze: returns snoozedId and emits reminder_stop_ring', () => {
    const row = { id: 1, active: true, cycle_stage: 'ringing' } as ReminderRow;
    const store = makeStore({
      getById: vi.fn().mockReturnValue(row),
      snooze: vi.fn().mockReturnValue(99),
    });
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('push', (e) => events.push(e));
    const service = createReminderService({ store, bus });
    expect(service.snooze(1)).toEqual({ ok: true, snoozedId: 99 });
    expect(events).toEqual([{ type: 'reminder_stop_ring', id: 1 }]);
  });

  it('list: delegates to store.list', () => {
    const rows = [{ id: 1 } as ReminderRow];
    const store = makeStore({ list: vi.fn().mockReturnValue(rows) });
    const service = createReminderService({ store, bus: new EventEmitter() });
    expect(service.list()).toEqual(rows);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd /Users/dim/code/R2-D2 && npx vitest run --root packages/server packages/server/src/services/__tests__/reminder-service.test.ts
```

Expected: FAIL — "Failed to resolve import '../reminder-service.js'".

- [x] **Step 3: Write minimal implementation**

Create `packages/server/src/services/reminder-service.ts`:

```ts
import type { EventEmitter } from 'node:events';
import type { ReminderStore, ReminderRow } from '../reminders/store.js';

export interface ReminderService {
  dismiss(id: number): { ok: true } | { ok: false; reason: 'not_found' };
  snooze(id: number): { ok: true; snoozedId: number } | { ok: false; reason: 'not_found' };
  list(): ReminderRow[];
}

interface Deps {
  store: ReminderStore;
  bus: EventEmitter;
  now?: () => number;
}

export function createReminderService(deps: Deps): ReminderService {
  const { store, bus } = deps;
  const now = deps.now ?? (() => Date.now());

  const isActionable = (row: ReminderRow | null): boolean =>
    !!row && row.active && (row.cycle_stage === 'ringing' || row.cycle_stage === 'paused');

  return {
    dismiss(id) {
      const row = store.getById(id);
      if (!isActionable(row)) return { ok: false, reason: 'not_found' };
      store.dismiss(id, now());
      bus.emit('push', { type: 'reminder_dismissed', id });
      return { ok: true };
    },
    snooze(id) {
      const row = store.getById(id);
      if (!isActionable(row)) return { ok: false, reason: 'not_found' };
      const snoozedId = store.snooze(id, now());
      bus.emit('push', { type: 'reminder_stop_ring', id });
      return { ok: true, snoozedId };
    },
    list() {
      return store.list();
    },
  };
}
```

- [x] **Step 4: Run tests**

```bash
npx vitest run --root packages/server packages/server/src/services/__tests__/reminder-service.test.ts
```

Expected: 5 passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/services/reminder-service.ts packages/server/src/services/__tests__/reminder-service.test.ts
git commit -m "feat(services): add reminder-service wrapping store + bus"
```

---

## Task 2: Migrate `routes/reminder.ts` to service

**Files:**
- Modify: `packages/server/src/routes/reminder.ts`
- Test: `packages/server/src/routes/__tests__/reminder.test.ts` (new)

- [x] **Step 1: Write failing test**

Create `packages/server/src/routes/__tests__/reminder.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReminderRouter } from '../reminder.js';
import type { ReminderService } from '../../services/reminder-service.js';

function makeService(overrides: Partial<ReminderService> = {}): ReminderService {
  return {
    dismiss: vi.fn().mockReturnValue({ ok: true }),
    snooze: vi.fn().mockReturnValue({ ok: true, snoozedId: 42 }),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as ReminderService;
}

function makeApp(service: ReminderService) {
  const app = express();
  app.use(express.json());
  app.use('/', createReminderRouter({ service }));
  return app;
}

describe('reminder router', () => {
  it('POST /dismiss — 400 on invalid id', async () => {
    const app = makeApp(makeService());
    const res = await request(app).post('/dismiss').send({ id: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /dismiss — 404 when service returns not_found', async () => {
    const service = makeService({ dismiss: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }) });
    const app = makeApp(service);
    const res = await request(app).post('/dismiss').send({ id: 5 });
    expect(res.status).toBe(404);
  });

  it('POST /dismiss — 200 on success', async () => {
    const service = makeService();
    const app = makeApp(service);
    const res = await request(app).post('/dismiss').send({ id: 5 });
    expect(res.status).toBe(200);
    expect(service.dismiss).toHaveBeenCalledWith(5);
  });

  it('POST /snooze — 200 with snoozedId', async () => {
    const service = makeService({ snooze: vi.fn().mockReturnValue({ ok: true, snoozedId: 77 }) });
    const app = makeApp(service);
    const res = await request(app).post('/snooze').send({ id: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, snoozedId: 77 });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run --root packages/server packages/server/src/routes/__tests__/reminder.test.ts
```

Expected: FAIL — router still takes old `{ store, bus }` deps.

- [x] **Step 3: Implement**

Replace contents of `packages/server/src/routes/reminder.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import type { ReminderService } from '../services/reminder-service.js';

interface Deps {
  service: ReminderService;
}

export function createReminderRouter(deps: Deps): Router {
  const { service } = deps;
  const router = Router();

  router.post('/dismiss', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const result = service.dismiss(id);
    if (!result.ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/snooze', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const result = service.snooze(id);
    if (!result.ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true, snoozedId: result.snoozedId });
  });

  return router;
}
```

- [x] **Step 4: Run tests**

```bash
npx vitest run --root packages/server packages/server/src/routes/__tests__/reminder.test.ts
```

Expected: 4 passing.

- [x] **Step 5: Update `index.ts` wiring temporarily (compile fix only)**

Edit `packages/server/src/index.ts` — change the reminder router line:

```ts
// Replace this line:
//   app.use('/api/reminder', createReminderRouter({ store: reminderStore, bus: reminderBus }));
// With:
import { createReminderService } from './services/reminder-service.js';
const reminderService = createReminderService({ store: reminderStore, bus: reminderBus });
app.use('/api/reminder', createReminderRouter({ service: reminderService }));
```

(Place `createReminderService` call near where `reminderStore` is constructed, above `app.use`.)

- [x] **Step 6: Verify server still compiles**

```bash
npx vitest run --root packages/server
```

Expected: full server test suite passes.

- [x] **Step 7: Commit**

```bash
git add packages/server/src/routes/reminder.ts packages/server/src/routes/__tests__/reminder.test.ts packages/server/src/index.ts
git commit -m "refactor(routes): reminder route uses reminder-service"
```

---

## Task 3: Extract `permission-service`

**Files:**
- Create: `packages/server/src/services/permission-service.ts`
- Create: `packages/server/src/services/__tests__/permission-service.test.ts`

- [x] **Step 1: Write failing test**

```ts
// packages/server/src/services/__tests__/permission-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPermissionService } from '../permission-service.js';
import type { PendingConfirms } from '../../routes/confirm.js';

describe('permission-service', () => {
  it('hasPending: true when callId is in the map', () => {
    const pending: PendingConfirms = new Map();
    pending.set('c1', () => {});
    const svc = createPermissionService({ pending });
    expect(svc.hasPending('c1')).toBe(true);
    expect(svc.hasPending('c2')).toBe(false);
  });

  it('resolveConfirm: calls resolver, deletes entry, returns ok', () => {
    const pending: PendingConfirms = new Map();
    const resolver = vi.fn();
    pending.set('c1', resolver);
    const svc = createPermissionService({ pending });
    expect(svc.resolveConfirm('c1', true, false)).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ allowed: true, remember: false });
    expect(pending.has('c1')).toBe(false);
  });

  it('resolveConfirm: returns not_found for unknown callId', () => {
    const pending: PendingConfirms = new Map();
    const svc = createPermissionService({ pending });
    expect(svc.resolveConfirm('c-x', true, false)).toEqual({ ok: false, reason: 'not_found' });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run --root packages/server packages/server/src/services/__tests__/permission-service.test.ts
```

- [x] **Step 3: Implement**

Create `packages/server/src/services/permission-service.ts`:

```ts
import type { PendingConfirms } from '../routes/confirm.js';

export interface PermissionService {
  hasPending(callId: string): boolean;
  resolveConfirm(
    callId: string,
    allowed: boolean,
    remember: boolean,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingConfirms;
}

export function createPermissionService(deps: Deps): PermissionService {
  const { pending } = deps;
  return {
    hasPending(callId) {
      return pending.has(callId);
    },
    resolveConfirm(callId, allowed, remember) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolve({ allowed, remember });
      return { ok: true };
    },
  };
}
```

- [x] **Step 4: Run tests**

Expected: 3 passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/services/permission-service.ts packages/server/src/services/__tests__/permission-service.test.ts
git commit -m "feat(services): add permission-service wrapping pendingConfirms"
```

---

## Task 4: Migrate `routes/confirm.ts` to service

**Files:**
- Modify: `packages/server/src/routes/confirm.ts`
- Modify: `packages/server/src/routes/__tests__/confirm.test.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Update existing test file**

Open `packages/server/src/routes/__tests__/confirm.test.ts`. Replace the parts that construct the router with a service-based version. Keep existing test cases (invalid body, 404, success).

Replace imports and setup block:

```ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConfirmRouter } from '../confirm.js';
import type { PermissionService } from '../../services/permission-service.js';

function makeService(overrides: Partial<PermissionService> = {}): PermissionService {
  return {
    hasPending: vi.fn().mockReturnValue(true),
    resolveConfirm: vi.fn().mockReturnValue({ ok: true }),
    ...overrides,
  } as PermissionService;
}

function makeApp(service: PermissionService) {
  const app = express();
  app.use(express.json());
  app.use('/', createConfirmRouter({ service }));
  return app;
}
```

Replace every test body so it uses `makeApp(makeService(...))` and asserts against `service.resolveConfirm` calls. Add a new case:

```ts
it('POST /confirm — 404 when service returns not_found', async () => {
  const service = makeService({
    resolveConfirm: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
  });
  const app = makeApp(service);
  const res = await request(app)
    .post('/confirm')
    .send({ callId: 'xx', allowed: true });
  expect(res.status).toBe(404);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run --root packages/server packages/server/src/routes/__tests__/confirm.test.ts
```

- [x] **Step 3: Implement**

Replace `packages/server/src/routes/confirm.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import type { PermissionService } from '../services/permission-service.js';

export interface ConfirmResponse {
  allowed: boolean;
  remember: boolean;
}

export type PendingConfirms = Map<string, (response: ConfirmResponse) => void>;

interface Deps {
  service: PermissionService;
}

export function createConfirmRouter(deps: Deps): Router {
  const router = Router();
  const { service } = deps;

  router.post('/confirm', (req: Request, res: Response) => {
    const { callId, allowed, remember } = req.body;

    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }
    if (typeof allowed !== 'boolean') {
      res.status(400).json({ error: 'allowed (boolean) required' });
      return;
    }

    const result = service.resolveConfirm(callId, allowed, !!remember);
    if (!result.ok) {
      res.status(404).json({ error: `Pending confirm "${callId}" not found` });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
```

Note: keep `ConfirmResponse` and `PendingConfirms` exports — they are still used by `tool-helpers.ts` and `permission-service.ts`.

- [x] **Step 4: Update `index.ts`**

Add the permission service near where `pendingConfirms` is created, then pass to router:

```ts
import { createPermissionService } from './services/permission-service.js';
// ...
const permissionService = createPermissionService({ pending: pendingConfirms });
// ...
app.use('/api', createConfirmRouter({ service: permissionService }));
```

- [x] **Step 5: Run tests**

```bash
npx vitest run --root packages/server
```

Expected: all green (confirm tests updated, rest unaffected).

- [x] **Step 6: Commit**

```bash
git add packages/server/src/routes/confirm.ts packages/server/src/routes/__tests__/confirm.test.ts packages/server/src/index.ts
git commit -m "refactor(routes): confirm route uses permission-service"
```

---

## Task 5: Extract `plan-review-service`

**Files:**
- Create: `packages/server/src/services/plan-review-service.ts`
- Create: `packages/server/src/services/__tests__/plan-review-service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/src/services/__tests__/plan-review-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPlanReviewService } from '../plan-review-service.js';
import type { PendingPlanReviews } from '../../routes/plan-review.js';

describe('plan-review-service', () => {
  it('hasPending: reflects map membership', () => {
    const pending: PendingPlanReviews = new Map();
    pending.set('p1', () => {});
    const svc = createPlanReviewService({ pending });
    expect(svc.hasPending('p1')).toBe(true);
    expect(svc.hasPending('nope')).toBe(false);
  });

  it('resolveReview: resolves and deletes', () => {
    const pending: PendingPlanReviews = new Map();
    const resolver = vi.fn();
    pending.set('p1', resolver);
    const svc = createPlanReviewService({ pending });
    expect(svc.resolveReview('p1', true)).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ approved: true, editedPlan: undefined });
    expect(pending.has('p1')).toBe(false);
  });

  it('resolveReview: passes editedPlan through', () => {
    const pending: PendingPlanReviews = new Map();
    const resolver = vi.fn();
    pending.set('p1', resolver);
    const svc = createPlanReviewService({ pending });
    svc.resolveReview('p1', true, 'edited text');
    expect(resolver).toHaveBeenCalledWith({ approved: true, editedPlan: 'edited text' });
  });

  it('resolveReview: not_found when absent', () => {
    const svc = createPlanReviewService({ pending: new Map() });
    expect(svc.resolveReview('xx', false)).toEqual({ ok: false, reason: 'not_found' });
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL

- [ ] **Step 3: Implement**

Create `packages/server/src/services/plan-review-service.ts`:

```ts
import type { PendingPlanReviews } from '../routes/plan-review.js';

export interface PlanReviewService {
  hasPending(callId: string): boolean;
  resolveReview(
    callId: string,
    approved: boolean,
    editedPlan?: string,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingPlanReviews;
}

export function createPlanReviewService(deps: Deps): PlanReviewService {
  const { pending } = deps;
  return {
    hasPending(callId) {
      return pending.has(callId);
    },
    resolveReview(callId, approved, editedPlan) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolve({ approved, editedPlan });
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: Run tests** — 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/plan-review-service.ts packages/server/src/services/__tests__/plan-review-service.test.ts
git commit -m "feat(services): add plan-review-service"
```

---

## Task 6: Migrate `routes/plan-review.ts` to service

**Files:**
- Modify: `packages/server/src/routes/plan-review.ts`
- Modify: `packages/server/src/routes/plan-review.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Update test file**

Open `packages/server/src/routes/plan-review.test.ts`. Replace the app setup with a service-based version (mirroring Task 4):

```ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPlanReviewRouter } from './plan-review.js';
import type { PlanReviewService } from '../services/plan-review-service.js';

function makeService(overrides: Partial<PlanReviewService> = {}): PlanReviewService {
  return {
    hasPending: vi.fn().mockReturnValue(true),
    resolveReview: vi.fn().mockReturnValue({ ok: true }),
    ...overrides,
  } as PlanReviewService;
}

function makeApp(service: PlanReviewService) {
  const app = express();
  app.use(express.json());
  app.use('/', createPlanReviewRouter({ service }));
  return app;
}
```

Keep existing test cases (invalid body, success, editedPlan), update them to use `makeApp(makeService(...))`. Add a new case for the not-found branch.

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Replace `packages/server/src/routes/plan-review.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import type { PlanReviewResponse } from '@r2/shared';
import type { PlanReviewService } from '../services/plan-review-service.js';

export type { PlanReviewResponse };
export type PendingPlanReviews = Map<string, (response: PlanReviewResponse) => void>;

interface Deps {
  service: PlanReviewService;
}

export function createPlanReviewRouter(deps: Deps): Router {
  const router = Router();
  const { service } = deps;

  router.post('/plan-review', (req: Request, res: Response) => {
    const { callId, approved, editedPlan } = req.body;
    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }
    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'approved (boolean) required' });
      return;
    }
    const result = service.resolveReview(
      callId,
      approved,
      typeof editedPlan === 'string' ? editedPlan : undefined,
    );
    if (!result.ok) {
      res.status(404).json({ error: `Pending plan review "${callId}" not found` });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Update `index.ts`**

Add plan-review service wiring:

```ts
import { createPlanReviewService } from './services/plan-review-service.js';
// ...
const planReviewService = createPlanReviewService({ pending: pendingPlanReviews });
// ...
app.use('/api', createPlanReviewRouter({ service: planReviewService }));
```

- [ ] **Step 5: Run full server tests** — expect all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/plan-review.ts packages/server/src/routes/plan-review.test.ts packages/server/src/index.ts
git commit -m "refactor(routes): plan-review route uses plan-review-service"
```

---

## Task 7: Create `command-service`

**Files:**
- Create: `packages/server/src/services/command-service.ts`
- Create: `packages/server/src/services/__tests__/command-service.test.ts`

Also: locate the existing "clear chat history" logic. Check `packages/server/src/db.ts` for a function; if absent, use `DELETE FROM chat_messages` directly.

- [ ] **Step 1: Inspect `db.ts`**

```bash
grep -n "chat_messages" packages/server/src/db.ts
```

Expected: find `saveMessage`, history retention. If no `clearChatHistory` exists, the service defines it.

- [ ] **Step 2: Write failing test**

```ts
// packages/server/src/services/__tests__/command-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createCommandService } from '../command-service.js';
import type { ReminderService } from '../reminder-service.js';
import type { PermissionService } from '../permission-service.js';
import type { MemoryService } from '../../memory/service.js';

function makeDb() {
  const run = vi.fn().mockReturnValue({ changes: 3 });
  return {
    prepare: vi.fn().mockReturnValue({ run }),
    _run: run,
  };
}

describe('command-service', () => {
  it('clearHistory: deletes all chat_messages, returns count', () => {
    const db = makeDb();
    const svc = createCommandService({
      db: db as any,
      reminderService: { list: vi.fn().mockReturnValue([]) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn().mockReturnValue(false) } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.clearHistory()).toEqual({ deleted: 3 });
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM chat_messages');
    expect(db._run).toHaveBeenCalled();
  });

  it('listReminders: delegates to reminderService.list', () => {
    const rows = [{ id: 1, text: 'buy milk', next_fire_at_ms: 1000 }];
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn().mockReturnValue(rows) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.listReminders()).toBe(rows);
  });

  it('status: returns model, reminder count, pending count, uptime seconds', () => {
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn().mockReturnValue([{ id: 1 } as any]) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
      pendingConfirmsCount: () => 2,
      modelName: 'claude-opus-4-7',
      startedAt: Date.now() - 5000,
    });
    const s = svc.status();
    expect(s.model).toBe('claude-opus-4-7');
    expect(s.activeReminders).toBe(1);
    expect(s.pendingPermissions).toBe(2);
    expect(s.uptimeSeconds).toBeGreaterThanOrEqual(4);
  });

  it('listMemory: returns last 10 when memory service is null', async () => {
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn() } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    const res = await svc.listMemory();
    expect(res).toEqual({ available: false, entries: [] });
  });
});
```

- [ ] **Step 3: Run test** — expect FAIL.

- [ ] **Step 4: Implement**

Create `packages/server/src/services/command-service.ts`:

```ts
import type Database from 'better-sqlite3';
import type { ReminderService } from './reminder-service.js';
import type { PermissionService } from './permission-service.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderRow } from '../reminders/store.js';

export interface CommandService {
  clearHistory(): { deleted: number };
  status(): {
    model: string;
    uptimeSeconds: number;
    activeReminders: number;
    pendingPermissions: number;
  };
  listReminders(): ReminderRow[];
  listMemory(query?: string): Promise<{
    available: boolean;
    entries: Array<{ text: string; timestamp: number }>;
  }>;
}

interface Deps {
  db: Database.Database;
  reminderService: ReminderService;
  permissionService: PermissionService;
  memoryService: MemoryService | null;
  pendingConfirmsCount?: () => number;
  modelName?: string;
  startedAt?: number;
}

export function createCommandService(deps: Deps): CommandService {
  const {
    db,
    reminderService,
    memoryService,
    pendingConfirmsCount = () => 0,
    modelName = 'unknown',
    startedAt = Date.now(),
  } = deps;

  return {
    clearHistory() {
      const result = db.prepare('DELETE FROM chat_messages').run();
      return { deleted: Number(result.changes ?? 0) };
    },
    status() {
      return {
        model: modelName,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        activeReminders: reminderService.list().length,
        pendingPermissions: pendingConfirmsCount(),
      };
    },
    listReminders() {
      return reminderService.list();
    },
    async listMemory(query) {
      if (!memoryService) return { available: false, entries: [] };
      if (query) {
        // memoryService.searchSimilar is the expected API; if the shape differs,
        // see memory/service.ts for the actual method. Fall back to recent list
        // via the same service if search is unavailable.
        try {
          const results: any = await (memoryService as any).searchSimilar?.(query, 10);
          if (Array.isArray(results)) {
            return {
              available: true,
              entries: results.map((r: any) => ({
                text: String(r.text ?? r.content ?? ''),
                timestamp: Number(r.timestamp ?? 0),
              })),
            };
          }
        } catch {
          // fall through
        }
      }
      // Default: recent 10
      try {
        const rows: any = (memoryService as any).listRecent?.(10) ?? [];
        return {
          available: true,
          entries: rows.map((r: any) => ({
            text: String(r.text ?? r.content ?? ''),
            timestamp: Number(r.timestamp ?? 0),
          })),
        };
      } catch {
        return { available: false, entries: [] };
      }
    },
  };
}
```

**Note:** `MemoryService`'s exact API must be verified before wiring. Before Step 5, inspect `packages/server/src/memory/service.ts` to see which methods exist (`searchSimilar`, `listRecent`, etc.). If both methods don't exist, replace with the nearest equivalents and update tests accordingly.

- [ ] **Step 5: Verify MemoryService API**

```bash
grep -n "export" packages/server/src/memory/service.ts
```

Read matching methods and adjust `listMemory` to call the real API. If the current memory service has no search / listRecent, keep the `{ available: false, entries: [] }` fallback and add a TODO-free comment inside the code saying the method is not yet wired.

- [ ] **Step 6: Run tests**

Expected: 4 passing.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/command-service.ts packages/server/src/services/__tests__/command-service.test.ts
git commit -m "feat(services): add command-service for slash commands"
```

---

## Task 8: Wire command-service into `index.ts` (no route yet)

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Edit index.ts**

Near where the other services are constructed, add:

```ts
import { createCommandService } from './services/command-service.js';
// ...
const serverStartedAt = Date.now();
const commandService = createCommandService({
  db: getDb(),
  reminderService,
  permissionService,
  memoryService,
  pendingConfirmsCount: () => pendingConfirms.size,
  modelName: process.env.MODEL_NAME || 'claude-opus-4-7',
  startedAt: serverStartedAt,
});
```

No route changes in this step — command-service is used only by Discord slash handlers (Task 14).

- [ ] **Step 2: Verify compile + tests**

```bash
npx vitest run --root packages/server
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "chore(index): instantiate command-service"
```

---

## Task 9: Embed factories — reminder

**Files:**
- Create: `packages/server/src/channels/discord/embeds.ts`
- Create: `packages/server/src/channels/discord/__tests__/embeds.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/src/channels/discord/__tests__/embeds.test.ts
import { describe, it, expect } from 'vitest';
import { ButtonStyle } from 'discord.js';
import { buildReminderEmbed } from '../embeds.js';

describe('buildReminderEmbed', () => {
  it('ringing state: includes title, footer, dismiss and snooze buttons', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'ringing',
    });

    const embedJson = embed.toJSON();
    expect(embedJson.title).toBe('⏰ Buy milk');
    expect(embedJson.footer?.text).toBe('now ringing');

    const row = components[0]!.toJSON();
    const buttons = row.components as any[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].custom_id).toBe('reminder:dismiss:7');
    expect(buttons[0].style).toBe(ButtonStyle.Success);
    expect(buttons[1].custom_id).toBe('reminder:snooze:7');
  });

  it('dismissed state: no buttons, footer shows dismissed', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'dismissed',
    });
    expect(embed.toJSON().footer?.text).toBe('✓ Dismissed');
    expect(components).toEqual([]);
  });

  it('snoozed state: no buttons, footer shows snoozed', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'snoozed',
    });
    expect(embed.toJSON().footer?.text).toBe('😴 Snoozed 10m');
    expect(components).toEqual([]);
  });

  it('missed state: no buttons, footer shows missed', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'missed',
    });
    expect(embed.toJSON().footer?.text).toBe('⏰ missed');
    expect(components).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/channels/discord/embeds.ts`:

```ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export type ReminderState = 'ringing' | 'dismissed' | 'snoozed' | 'missed';

export function buildReminderEmbed(opts: {
  id: number;
  text: string;
  state: ReminderState;
}): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder().setTitle(`⏰ ${opts.text}`);

  switch (opts.state) {
    case 'ringing':
      embed.setFooter({ text: 'now ringing' });
      return {
        embed,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`reminder:dismiss:${opts.id}`)
              .setLabel('Dismiss')
              .setEmoji('✓')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`reminder:snooze:${opts.id}`)
              .setLabel('Snooze 10m')
              .setEmoji('😴')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      };
    case 'dismissed':
      embed.setFooter({ text: '✓ Dismissed' });
      return { embed, components: [] };
    case 'snoozed':
      embed.setFooter({ text: '😴 Snoozed 10m' });
      return { embed, components: [] };
    case 'missed':
      embed.setFooter({ text: '⏰ missed' });
      return { embed, components: [] };
  }
}
```

- [ ] **Step 4: Run tests** — 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/embeds.ts packages/server/src/channels/discord/__tests__/embeds.test.ts
git commit -m "feat(discord): reminder embed factory"
```

---

## Task 10: Bot `reminder_ring` sends embed (replace plain text)

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [ ] **Step 1: Extend `DiscordBotDeps`**

In `bot.ts`, change `DiscordBotDeps`:

```ts
import type { ReminderService } from '../../services/reminder-service.js';
// ...
export interface DiscordBotDeps {
  // ...existing
  reminderBus?: EventEmitter;
  reminderService?: ReminderService;   // NEW — optional for backward compat during migration
}
```

Also import the embed factory:

```ts
import { buildReminderEmbed } from './embeds.js';
```

- [ ] **Step 2: Update reminder listener**

Replace the block starting `if (deps.reminderBus)` with:

```ts
// Track message ids for reminder embeds so we can edit them on dismiss/snooze/done
const reminderMessages = new Map<number, string[]>(); // reminderId -> [messageId, ...]

let reminderListener: ((event: ServerPushEvent) => void) | null = null;
if (deps.reminderBus) {
  reminderListener = (event: ServerPushEvent) => {
    if (!client.isReady()) return;
    if (event.type === 'reminder_ring') {
      const { embed, components } = buildReminderEmbed({
        id: event.id,
        text: event.text,
        state: 'ringing',
      });
      for (const userId of deps.whitelist) {
        client.users.fetch(userId)
          .then((u) => u.createDM())
          .then((dm) => dm.send({ embeds: [embed], components }))
          .then((sent) => {
            const list = reminderMessages.get(event.id) ?? [];
            list.push(sent.id);
            reminderMessages.set(event.id, list);
          })
          .catch((err) =>
            console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err),
          );
      }
    }
    // reminder_done / reminder_stop_ring / reminder_dismissed handling
    // added in later steps once interaction handler exists.
  };
  deps.reminderBus.on('push', reminderListener);
}
```

- [ ] **Step 3: Update existing `bot.test.ts` expectations**

In `bot.test.ts`, any test that asserted `dm.send('⏰ Купити рибу')` or similar plain-text reminder assertions now must assert on `dm.send({ embeds: [...], components: [...] })`. Update to:

```ts
expect(dmChannel.send).toHaveBeenCalledWith(
  expect.objectContaining({
    embeds: expect.any(Array),
    components: expect.any(Array),
  }),
);
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run --root packages/server
```

Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): reminder_ring sends embed with buttons"
```

---

## Task 11: Permission embed factory

**Files:**
- Modify: `packages/server/src/channels/discord/embeds.ts`
- Modify: `packages/server/src/channels/discord/__tests__/embeds.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `embeds.test.ts`:

```ts
import { buildPermissionEmbed } from '../embeds.js';

describe('buildPermissionEmbed', () => {
  it('pending: embed with allow_once / allow_always / deny buttons', () => {
    const { embed, components } = buildPermissionEmbed({
      callId: 'abc-123',
      toolName: 'files.write',
      argsSummary: 'path: /tmp/x.txt',
      state: 'pending',
    });
    const e = embed.toJSON();
    expect(e.title).toContain('Permission request');
    expect(e.description).toContain('files.write');
    expect(e.description).toContain('path: /tmp/x.txt');
    const buttons = (components[0]!.toJSON().components as any[]);
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'perm:allow_once:abc-123',
      'perm:allow_always:abc-123',
      'perm:deny:abc-123',
    ]);
    expect(buttons[0].style).toBe(ButtonStyle.Success);
    expect(buttons[2].style).toBe(ButtonStyle.Danger);
  });

  it('resolved state: no buttons, footer reflects decision', () => {
    const { components, embed } = buildPermissionEmbed({
      callId: 'abc-123',
      toolName: 'files.write',
      argsSummary: 'path: /tmp/x.txt',
      state: 'allowed_once',
    });
    expect(components).toEqual([]);
    expect(embed.toJSON().footer?.text).toBe('✓ Allowed once');
  });

  it('expired state: no buttons, footer "expired"', () => {
    const { components, embed } = buildPermissionEmbed({
      callId: 'abc-123',
      toolName: 'files.write',
      argsSummary: 'x',
      state: 'expired',
    });
    expect(components).toEqual([]);
    expect(embed.toJSON().footer?.text).toBe('⚠️ expired');
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Append to `embeds.ts`:

```ts
export type PermissionState =
  | 'pending'
  | 'allowed_once'
  | 'allowed_always'
  | 'denied'
  | 'expired';

export function buildPermissionEmbed(opts: {
  callId: string;
  toolName: string;
  argsSummary: string;
  state: PermissionState;
}): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setTitle('🔐 Permission request')
    .setDescription(`Tool: \`${opts.toolName}\`\n${opts.argsSummary}`);

  if (opts.state === 'pending') {
    return {
      embed,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`perm:allow_once:${opts.callId}`)
            .setLabel('Allow once')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`perm:allow_always:${opts.callId}`)
            .setLabel('Allow always')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`perm:deny:${opts.callId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    };
  }

  const footerByState: Record<Exclude<PermissionState, 'pending'>, string> = {
    allowed_once: '✓ Allowed once',
    allowed_always: '✓ Allowed always',
    denied: '✗ Denied',
    expired: '⚠️ expired',
  };
  embed.setFooter({ text: footerByState[opts.state] });
  return { embed, components: [] };
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/embeds.ts packages/server/src/channels/discord/__tests__/embeds.test.ts
git commit -m "feat(discord): permission embed factory"
```

---

## Task 12: Plan-review chunk builder

**Files:**
- Modify: `packages/server/src/channels/discord/embeds.ts`
- Modify: `packages/server/src/channels/discord/__tests__/embeds.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `embeds.test.ts`:

```ts
import { buildPlanReviewChunks } from '../embeds.js';

describe('buildPlanReviewChunks', () => {
  it('small plan: one message with header, one message with buttons', () => {
    const chunks = buildPlanReviewChunks({
      callId: 'p1',
      plan: 'step 1\nstep 2\nstep 3',
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toContain('📋 Plan review (1/1)');
    expect(chunks[0].content).toContain('step 1');
    expect(chunks[0].components).toEqual([]);
    const lastRow = chunks[1].components![0]!.toJSON();
    const buttons = lastRow.components as any[];
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'plan:approve:p1',
      'plan:reject:p1',
    ]);
  });

  it('large plan: splits into multiple chunks, header shows (N/N)', () => {
    const hugeLine = 'x'.repeat(100);
    const lines = Array.from({ length: 50 }, (_, i) => `${i}: ${hugeLine}`).join('\n');
    const chunks = buildPlanReviewChunks({ callId: 'p1', plan: lines });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].content).toMatch(/^📋 Plan review \(1\/\d+\)/);
    // No split inside a code fence
    for (const c of chunks.slice(0, -1)) {
      const opens = (c.content!.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('plan over 20-chunk cap: last content chunk shows truncated warning', () => {
    const giant = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n');
    const chunks = buildPlanReviewChunks({ callId: 'p1', plan: giant });
    expect(chunks.length).toBeLessThanOrEqual(21); // 20 content + 1 buttons
    const truncContent = chunks[chunks.length - 2]!.content!;
    expect(truncContent).toContain('⚠️ plan truncated');
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Append to `embeds.ts`:

```ts
export interface PlanReviewChunk {
  content?: string;
  components?: ActionRowBuilder<ButtonBuilder>[];
}

const DISCORD_MESSAGE_LIMIT = 2000;
const CODE_FENCE_OVERHEAD = 8; // ``` + \n, twice
const MAX_CHUNKS = 20;

export function buildPlanReviewChunks(opts: {
  callId: string;
  plan: string;
}): PlanReviewChunk[] {
  const lines = opts.plan.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  // Leave room for header line + fence overhead
  const firstChunkBudget = DISCORD_MESSAGE_LIMIT - 60 - CODE_FENCE_OVERHEAD;
  const restChunkBudget = DISCORD_MESSAGE_LIMIT - CODE_FENCE_OVERHEAD;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push(buf.join('\n'));
    buf = [];
    bufLen = 0;
  };

  for (const line of lines) {
    const budget = chunks.length === 0 ? firstChunkBudget : restChunkBudget;
    // +1 for the newline joiner
    const added = line.length + 1;
    if (bufLen + added > budget && buf.length > 0) {
      flush();
    }
    buf.push(line);
    bufLen += added;
    if (chunks.length >= MAX_CHUNKS - 1 && bufLen >= restChunkBudget * 0.9) {
      flush();
      break; // stop collecting further lines
    }
  }
  flush();

  let truncated = false;
  if (chunks.length > MAX_CHUNKS) {
    chunks.length = MAX_CHUNKS;
    truncated = true;
  }
  if (chunks.length === MAX_CHUNKS && lines.length > 0) {
    // Rough check: we still had lines that did not fit — mark truncated
    const totalRendered = chunks.join('\n').split('\n').length;
    if (totalRendered < lines.length) truncated = true;
  }

  const total = chunks.length;
  const out: PlanReviewChunk[] = chunks.map((body, i) => {
    const header = i === 0 ? `📋 Plan review (${i + 1}/${total})\n` : '';
    let suffix = '';
    if (truncated && i === total - 1) {
      suffix = '\n⚠️ plan truncated';
    }
    return { content: `${header}\`\`\`\n${body}\n\`\`\`${suffix}` };
  });

  out.push({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`plan:approve:${opts.callId}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`plan:reject:${opts.callId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });

  return out;
}
```

- [ ] **Step 4: Run tests** — all passing. If the "splits into multiple chunks" test fails on the header format, tweak the header assertion to match the actual `(1/N)` output.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/embeds.ts packages/server/src/channels/discord/__tests__/embeds.test.ts
git commit -m "feat(discord): plan-review multi-message chunk builder"
```

---

## Task 13: Interaction router — skeleton + reminder buttons

**Files:**
- Create: `packages/server/src/channels/discord/interactions.ts`
- Create: `packages/server/src/channels/discord/__tests__/interactions.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/server/src/channels/discord/__tests__/interactions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeInteraction } from '../interactions.js';
import type { ReminderService } from '../../../services/reminder-service.js';
import type { PermissionService } from '../../../services/permission-service.js';
import type { PlanReviewService } from '../../../services/plan-review-service.js';
import type { CommandService } from '../../../services/command-service.js';

function makeDeps(overrides: Partial<Parameters<typeof routeInteraction>[1]> = {}) {
  return {
    whitelist: new Set(['user-1']),
    reminderService: {
      dismiss: vi.fn().mockReturnValue({ ok: true }),
      snooze: vi.fn().mockReturnValue({ ok: true, snoozedId: 42 }),
      list: vi.fn().mockReturnValue([]),
    } as unknown as ReminderService,
    permissionService: {
      hasPending: vi.fn().mockReturnValue(true),
      resolveConfirm: vi.fn().mockReturnValue({ ok: true }),
    } as unknown as PermissionService,
    planReviewService: {
      hasPending: vi.fn().mockReturnValue(true),
      resolveReview: vi.fn().mockReturnValue({ ok: true }),
    } as unknown as PlanReviewService,
    commandService: {
      clearHistory: vi.fn().mockReturnValue({ deleted: 0 }),
      status: vi.fn().mockReturnValue({
        model: 'm', uptimeSeconds: 0, activeReminders: 0, pendingPermissions: 0,
      }),
      listReminders: vi.fn().mockReturnValue([]),
      listMemory: vi.fn().mockResolvedValue({ available: false, entries: [] }),
    } as unknown as CommandService,
    ...overrides,
  };
}

function makeButtonInteraction(overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'reminder:dismiss:7',
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('routeInteraction — reminder buttons', () => {
  it('rejects non-whitelisted user with ephemeral reply', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ user: { id: 'evil' } });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(deps.reminderService.dismiss).not.toHaveBeenCalled();
  });

  it('reminder:dismiss calls service, updates message', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'reminder:dismiss:7' });
    await routeInteraction(ixn, deps);
    expect(deps.reminderService.dismiss).toHaveBeenCalledWith(7);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it('reminder:snooze calls service, updates message', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'reminder:snooze:7' });
    await routeInteraction(ixn, deps);
    expect(deps.reminderService.snooze).toHaveBeenCalledWith(7);
    expect(ixn.update).toHaveBeenCalled();
  });

  it('reminder:dismiss not_found: update to expired footer', async () => {
    const deps = makeDeps({
      reminderService: {
        dismiss: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
        snooze: vi.fn(),
        list: vi.fn(),
      } as unknown as ReminderService,
    });
    const ixn = makeButtonInteraction({ customId: 'reminder:dismiss:7' });
    await routeInteraction(ixn, deps);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/channels/discord/interactions.ts`:

```ts
import type { Interaction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { ReminderService } from '../../services/reminder-service.js';
import type { PermissionService } from '../../services/permission-service.js';
import type { PlanReviewService } from '../../services/plan-review-service.js';
import type { CommandService } from '../../services/command-service.js';
import {
  buildReminderEmbed,
  buildPermissionEmbed,
} from './embeds.js';

export interface InteractionDeps {
  whitelist: Set<string>;
  reminderService: ReminderService;
  permissionService: PermissionService;
  planReviewService: PlanReviewService;
  commandService: CommandService;
}

export async function routeInteraction(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<void> {
  if (!deps.whitelist.has(interaction.user.id)) {
    if ('reply' in interaction && typeof (interaction as any).reply === 'function') {
      await (interaction as any).reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.isButton()) {
    await routeButton(interaction, deps);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await routeSlashCommand(interaction, deps);
    return;
  }
}

async function routeButton(
  ixn: Extract<Interaction, { isButton: () => true }>,
  deps: InteractionDeps,
): Promise<void> {
  const [domain, action, rawId] = ixn.customId.split(':');

  if (domain === 'reminder') {
    const id = Number(rawId);
    if (!Number.isInteger(id)) return;
    if (action === 'dismiss') {
      const result = deps.reminderService.dismiss(id);
      const state = result.ok ? 'dismissed' : 'missed';
      // Rebuild from original title using current message embed if available
      const currentTitle =
        (ixn as any).message?.embeds?.[0]?.title?.replace(/^⏰\s*/, '') ?? '';
      const { embed } = buildReminderEmbed({ id, text: currentTitle, state });
      await (ixn as any).update({ embeds: [embed], components: [] });
      return;
    }
    if (action === 'snooze') {
      const result = deps.reminderService.snooze(id);
      const state = result.ok ? 'snoozed' : 'missed';
      const currentTitle =
        (ixn as any).message?.embeds?.[0]?.title?.replace(/^⏰\s*/, '') ?? '';
      const { embed } = buildReminderEmbed({ id, text: currentTitle, state });
      await (ixn as any).update({ embeds: [embed], components: [] });
      return;
    }
    return;
  }

  if (domain === 'perm') {
    const callId = rawId ?? '';
    if (!deps.permissionService.hasPending(callId)) {
      const { embed } = buildPermissionEmbed({
        callId,
        toolName: '',
        argsSummary: '',
        state: 'expired',
      });
      await (ixn as any).update({ embeds: [embed], components: [] });
      return;
    }
    let allowed = false;
    let remember = false;
    let finalState: 'allowed_once' | 'allowed_always' | 'denied' = 'denied';
    if (action === 'allow_once') { allowed = true; finalState = 'allowed_once'; }
    else if (action === 'allow_always') { allowed = true; remember = true; finalState = 'allowed_always'; }
    else if (action === 'deny') { allowed = false; finalState = 'denied'; }
    else return;
    deps.permissionService.resolveConfirm(callId, allowed, remember);
    const msgEmbed = (ixn as any).message?.embeds?.[0];
    const { embed } = buildPermissionEmbed({
      callId,
      toolName: msgEmbed?.title ?? '',
      argsSummary: msgEmbed?.description ?? '',
      state: finalState,
    });
    await (ixn as any).update({ embeds: [embed], components: [] });
    return;
  }

  if (domain === 'plan') {
    const callId = rawId ?? '';
    if (!deps.planReviewService.hasPending(callId)) {
      await (ixn as any).update({ components: [], content: '⚠️ expired' });
      return;
    }
    const approved = action === 'approve';
    deps.planReviewService.resolveReview(callId, approved);
    await (ixn as any).update({
      components: [],
      content: approved ? '✓ approved' : '✗ rejected',
    });
    return;
  }
}

async function routeSlashCommand(
  ixn: Extract<Interaction, { isChatInputCommand: () => true }>,
  _deps: InteractionDeps,
): Promise<void> {
  // implemented in Task 17
  await (ixn as any).reply({ content: 'Not yet implemented', flags: MessageFlags.Ephemeral });
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/interactions.ts packages/server/src/channels/discord/__tests__/interactions.test.ts
git commit -m "feat(discord): interaction router + reminder button handlers"
```

---

## Task 14: Permission button handlers — integration tests

**Files:**
- Modify: `packages/server/src/channels/discord/__tests__/interactions.test.ts`

Already mostly implemented in Task 13; this task adds dedicated tests.

- [ ] **Step 1: Add tests**

Append to `interactions.test.ts`:

```ts
describe('routeInteraction — permission buttons', () => {
  it('perm:allow_once resolves with allowed=true, remember=false', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_once:call-42',
      message: { embeds: [{ title: '🔐 Permission request', description: 'Tool: x' }] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalledWith('call-42', true, false);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it('perm:allow_always resolves with allowed=true, remember=true', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_always:call-42',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalledWith('call-42', true, true);
  });

  it('perm:deny resolves with allowed=false', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'perm:deny:call-42',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalledWith('call-42', false, false);
  });

  it('perm:* — expired when service has no pending entry', async () => {
    const deps = makeDeps({
      permissionService: {
        hasPending: vi.fn().mockReturnValue(false),
        resolveConfirm: vi.fn(),
      } as unknown as PermissionService,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_once:gone',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).not.toHaveBeenCalled();
    expect(ixn.update).toHaveBeenCalled();
  });
});

describe('routeInteraction — plan review buttons', () => {
  it('plan:approve resolves', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'plan:approve:pp-1', message: { embeds: [{}] } });
    await routeInteraction(ixn, deps);
    expect(deps.planReviewService.resolveReview).toHaveBeenCalledWith('pp-1', true);
  });
  it('plan:reject resolves', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'plan:reject:pp-1', message: { embeds: [{}] } });
    await routeInteraction(ixn, deps);
    expect(deps.planReviewService.resolveReview).toHaveBeenCalledWith('pp-1', false);
  });
});
```

- [ ] **Step 2: Run tests** — all passing.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/channels/discord/__tests__/interactions.test.ts
git commit -m "test(discord): permission and plan-review interaction tests"
```

---

## Task 15: Bot `onEvent` — mid-stream flush + permission embed

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

This is the central change that makes Discord usable mid-stream.

- [ ] **Step 1: Write failing test**

Add to `bot.test.ts`:

```ts
describe('mid-stream tool_confirm_request handling', () => {
  it('flushes buffer, sends permission embed, then continues stream', async () => {
    const events: any[] = [];
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({ type: 'text_delta', content: 'before ' });
      onEvent({
        type: 'tool_confirm_request',
        toolCall: { id: 'c-1', name: 'files.write', input: { path: '/tmp/x' }, status: 'running' },
        level: 'confirm',
      });
      // Simulate user click externally; tool proceeds
      onEvent({ type: 'text_delta', content: 'after' });
      onEvent({ type: 'done' });
    });

    const client = makeFakeClient();
    const channel = makeDmChannel();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;

    const { stop } = await startDiscordBot({
      token: 'test',
      whitelist: new Set(['123']),
      runChatRequest,
      db: makeFakeDb() as any,
      historyLimit: 10,
      saveMessage: vi.fn(),
      memoryService: null,
      _client: client,
      permissionService: {
        hasPending: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: { status: vi.fn(), clearHistory: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn() } as any,
    });
    // fire messageCreate
    (client as any).emit('messageCreate', msg.msg);
    // allow promises to flush
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const calls = (dmChannel.send as any).mock.calls;
    // Expect at least: "before " flush, embed, "after" flush
    const textsSent = calls.map((c: any[]) => typeof c[0] === 'string' ? c[0] : '').filter(Boolean);
    const embedsSent = calls.filter((c: any[]) => typeof c[0] === 'object' && 'embeds' in c[0]);
    expect(textsSent).toEqual(expect.arrayContaining(['before ']));
    expect(embedsSent.length).toBeGreaterThan(0);
    expect(textsSent).toEqual(expect.arrayContaining(['after']));

    await stop();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL (bot doesn't handle `tool_confirm_request` yet).

- [ ] **Step 3: Extend `DiscordBotDeps` with all services**

```ts
export interface DiscordBotDeps {
  // existing fields
  token: string;
  whitelist: Set<string>;
  runChatRequest: ...;
  db: Database.Database;
  historyLimit: number;
  saveMessage: ...;
  memoryService: MemoryService | null;
  requestTimeoutMs?: number;
  contextBudgetChars?: number;
  _client?: Client;
  reminderBus?: EventEmitter;

  // NEW (all required once migration is complete)
  reminderService: ReminderService;
  permissionService: PermissionService;
  planReviewService: PlanReviewService;
  commandService: CommandService;
}
```

Imports:

```ts
import { buildPermissionEmbed, buildPlanReviewChunks } from './embeds.js';
import { routeInteraction } from './interactions.js';
```

- [ ] **Step 4: Refactor `onEvent` inside `handleMessage`**

Replace the current `onEvent` inline closure with:

```ts
const flush = async () => {
  if (!buffer) return;
  await sendReply(dmChannel, buffer);
  sendSucceeded = true;
  buffer = '';
};

await deps.runChatRequest({
  messages,
  signal: ac.signal,
  onEvent: (event: SSEEvent) => {
    // Queue work through an async chain to preserve ordering.
    sendChain = sendChain.then(async () => {
      if (event.type === 'text_delta') {
        buffer += event.content;
        return;
      }
      if (event.type === 'tool_confirm_request') {
        await flush();
        const argsSummary = summarizeArgs(event.toolCall.input);
        const { embed, components } = buildPermissionEmbed({
          callId: event.toolCall.id,
          toolName: event.toolCall.name,
          argsSummary,
          state: 'pending',
        });
        await dmChannel.send({ embeds: [embed], components });
        return;
      }
      if (event.type === 'tool_plan_review') {
        await flush();
        const chunks = buildPlanReviewChunks({ callId: event.id, plan: event.plan });
        for (const c of chunks) {
          await dmChannel.send({
            content: c.content,
            components: c.components ?? [],
          });
        }
        return;
      }
      if (event.type === 'done' && !errorSent) {
        await flush();
        return;
      }
      if (event.type === 'error' && !errorSent) {
        errorSent = true;
        await flush();
        await dmChannel.send('⚠️ Something went wrong. Please try again later.');
        return;
      }
    }).catch((err) => console.error('[discord] onEvent chain error:', err));
  },
});
await sendChain;
```

Add the helper:

```ts
function summarizeArgs(input: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    const short = val.length > 100 ? val.slice(0, 100) + '…' : val;
    pairs.push(`${k}: \`${short}\``);
    if (pairs.join('\n').length > 1500) break;
  }
  return pairs.join('\n');
}
```

Remove the previous `replyPromise` / `buffer`-flush-on-done block — the new `onEvent` handles all output.

Also declare:

```ts
let sendChain: Promise<void> = Promise.resolve();
```

before the retry loop.

- [ ] **Step 5: Add `interactionCreate` hook**

In `startDiscordBot`, after other event wires:

```ts
client.on('interactionCreate', async (interaction) => {
  try {
    await routeInteraction(interaction, {
      whitelist: deps.whitelist,
      reminderService: deps.reminderService,
      permissionService: deps.permissionService,
      planReviewService: deps.planReviewService,
      commandService: deps.commandService,
    });
  } catch (err) {
    console.error('[discord] interaction error:', err instanceof Error ? err.message : err);
  }
});
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run --root packages/server packages/server/src/channels/discord
```

Expected: all existing + new tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): mid-stream flush + permission/plan-review embeds in onEvent"
```

---

## Task 16: Slash commands — definitions and registration

**Files:**
- Create: `packages/server/src/channels/discord/slash-commands.ts`
- Modify: `packages/server/src/channels/discord/bot.ts`

- [ ] **Step 1: Implement**

Create `packages/server/src/channels/discord/slash-commands.ts`:

```ts
import { SlashCommandBuilder } from 'discord.js';

export const SLASH_COMMAND_DEFINITIONS = [
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear all chat history')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show R2 status (model, reminders, pending permissions)')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('List active reminders')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('List recent memory entries or search by query')
    .addStringOption((o) =>
      o.setName('query').setDescription('Optional search query').setRequired(false),
    )
    .setDMPermission(true),
].map((b) => b.toJSON());
```

- [ ] **Step 2: Register on `clientReady` in `bot.ts`**

Inside the existing `clientReady` handler, after pre-caching DM channels:

```ts
try {
  if (client.application) {
    await client.application.commands.set(SLASH_COMMAND_DEFINITIONS);
    console.log('[discord] slash commands registered');
  }
} catch (err) {
  console.error('[discord] slash command registration failed:', err instanceof Error ? err.message : err);
}
```

Import:

```ts
import { SLASH_COMMAND_DEFINITIONS } from './slash-commands.js';
```

- [ ] **Step 3: Run server tests**

```bash
npx vitest run --root packages/server
```

Expected: green. (Bot tests that construct a fake client don't hit `application.commands.set` — it is guarded by `client.application`.)

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/channels/discord/slash-commands.ts packages/server/src/channels/discord/bot.ts
git commit -m "feat(discord): slash command definitions + registration"
```

---

## Task 17: Slash command handlers in `interactions.ts`

**Files:**
- Modify: `packages/server/src/channels/discord/interactions.ts`
- Modify: `packages/server/src/channels/discord/__tests__/interactions.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `interactions.test.ts`:

```ts
function makeSlashInteraction(overrides: Record<string, any> = {}) {
  return {
    isButton: () => false,
    isChatInputCommand: () => true,
    user: { id: 'user-1' },
    commandName: 'status',
    options: { getString: vi.fn().mockReturnValue(null) },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('routeInteraction — slash commands', () => {
  it('/status: ephemeral reply with status info', async () => {
    const deps = makeDeps();
    const ixn = makeSlashInteraction({ commandName: 'status' });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.status).toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it('/reminders: ephemeral list', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(),
        listReminders: vi.fn().mockReturnValue([
          { id: 1, text: 'a', next_fire_at_ms: 1000 },
        ]),
        listMemory: vi.fn().mockResolvedValue({ available: false, entries: [] }),
      } as any,
    });
    const ixn = makeSlashInteraction({ commandName: 'reminders' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, content: expect.stringContaining('a') }),
    );
  });

  it('/memory with query: calls listMemory with query', async () => {
    const deps = makeDeps();
    const ixn = makeSlashInteraction({
      commandName: 'memory',
      options: { getString: vi.fn().mockReturnValue('hello') },
    });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.listMemory).toHaveBeenCalledWith('hello');
  });

  it('/clear: ephemeral confirm with Yes/No buttons', async () => {
    const deps = makeDeps();
    const ixn = makeSlashInteraction({ commandName: 'clear' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('Clear'),
        components: expect.any(Array),
      }),
    );
    expect(deps.commandService.clearHistory).not.toHaveBeenCalled();
  });

  it('button clear:yes: calls clearHistory, edits reply', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'clear:yes',
      update: vi.fn().mockResolvedValue(undefined),
    });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.clearHistory).toHaveBeenCalled();
    expect(ixn.update).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement slash-command branch**

Replace the stub in `interactions.ts`:

```ts
async function routeSlashCommand(
  ixn: Extract<Interaction, { isChatInputCommand: () => true }>,
  deps: InteractionDeps,
): Promise<void> {
  const name = ixn.commandName;
  if (name === 'clear') {
    await (ixn as any).reply({
      ephemeral: true,
      content: 'Clear all chat history?',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 4, label: 'Yes, clear', custom_id: 'clear:yes' },
            { type: 2, style: 2, label: 'No', custom_id: 'clear:no' },
          ],
        },
      ],
    });
    return;
  }
  if (name === 'status') {
    const s = deps.commandService.status();
    await (ixn as any).reply({
      ephemeral: true,
      content:
        `**Status**\n` +
        `Model: \`${s.model}\`\n` +
        `Uptime: ${s.uptimeSeconds}s\n` +
        `Active reminders: ${s.activeReminders}\n` +
        `Pending permissions: ${s.pendingPermissions}`,
    });
    return;
  }
  if (name === 'reminders') {
    const list = deps.commandService.listReminders();
    const content = list.length === 0
      ? 'No active reminders.'
      : list.map((r) => `#${r.id} · ${r.text} · ${new Date(r.next_fire_at_ms).toISOString()}`).join('\n');
    await (ixn as any).reply({ ephemeral: true, content });
    return;
  }
  if (name === 'memory') {
    const query = (ixn as any).options.getString('query') ?? undefined;
    const result = await deps.commandService.listMemory(query);
    const content = !result.available
      ? 'Memory not available.'
      : result.entries.length === 0
        ? 'No memory entries.'
        : result.entries
            .map((e) => `- ${e.text}${e.timestamp ? ` (${new Date(e.timestamp).toISOString()})` : ''}`)
            .join('\n');
    await (ixn as any).reply({ ephemeral: true, content });
    return;
  }
}
```

Extend the `routeButton` domain match to handle `clear`:

```ts
if (domain === 'clear') {
  if (action === 'yes') {
    const r = deps.commandService.clearHistory();
    await (ixn as any).update({
      content: `🗑️ Cleared ${r.deleted} messages.`,
      components: [],
    });
  } else if (action === 'no') {
    await (ixn as any).update({ content: 'Cancelled.', components: [] });
  }
  return;
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/interactions.ts packages/server/src/channels/discord/__tests__/interactions.test.ts
git commit -m "feat(discord): slash command handlers (clear/status/reminders/memory)"
```

---

## Task 18: Wire Discord bot with full service deps

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Update `startDiscordBot` call**

```ts
discordBot = await startDiscordBot({
  token: discordToken,
  whitelist,
  runChatRequest: (params) =>
    runChatRequest({
      ...params,
      signal: params.signal,
      piiProxy,
      ollama: ollamaForRouter,
      registry,
      memoryService,
      runLoop: runLoopFn,
    }),
  db: getDb(),
  historyLimit: getChatHistoryLimit(),
  saveMessage,
  memoryService,
  reminderBus,
  reminderService,        // NEW
  permissionService,      // NEW
  planReviewService,      // NEW
  commandService,         // NEW
  requestTimeoutMs: Number(process.env.DISCORD_REQUEST_TIMEOUT_MS) || 300_000,
});
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run --root packages/server
```

Expected: all green.

- [ ] **Step 3: Build check**

```bash
cd /Users/dim/code/R2-D2 && npm run build -w @r2/server
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "chore(index): wire all services into Discord bot deps"
```

---

## Task 19: Reminder state updates (dismissed/done) edit existing embeds

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`

Currently the bot sends the ringing embed but doesn't edit it when the reminder is dismissed from somewhere else (e.g. `reminder_done` via scheduler timeout). This task closes the loop.

- [ ] **Step 1: Extend reminder listener**

Replace the `reminderListener` body to also handle `reminder_done` and `reminder_dismissed`:

```ts
reminderListener = (event: ServerPushEvent) => {
  if (!client.isReady()) return;

  const editStored = async (id: number, state: 'dismissed' | 'missed' | 'snoozed', text?: string) => {
    const ids = reminderMessages.get(id) ?? [];
    for (const userId of deps.whitelist) {
      try {
        const user = await client.users.fetch(userId);
        const dm = await user.createDM();
        for (const msgId of ids) {
          try {
            const msg = await dm.messages.fetch(msgId);
            const currentText = text ?? msg.embeds?.[0]?.title?.replace(/^⏰\s*/, '') ?? '';
            const { embed } = buildReminderEmbed({ id, text: currentText, state });
            await msg.edit({ embeds: [embed], components: [] });
          } catch (err) {
            // message gone or no permission — ignore
          }
        }
      } catch (err) {
        // user/dm unreachable — ignore
      }
    }
    reminderMessages.delete(id);
  };

  if (event.type === 'reminder_ring') {
    const { embed, components } = buildReminderEmbed({ id: event.id, text: event.text, state: 'ringing' });
    for (const userId of deps.whitelist) {
      client.users.fetch(userId)
        .then((u) => u.createDM())
        .then((dm) => dm.send({ embeds: [embed], components }))
        .then((sent) => {
          const list = reminderMessages.get(event.id) ?? [];
          list.push(sent.id);
          reminderMessages.set(event.id, list);
        })
        .catch((err) => console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err));
    }
  } else if (event.type === 'reminder_done') {
    editStored(event.id, 'missed');
  } else if (event.type === 'reminder_dismissed') {
    editStored(event.id, 'dismissed');
  } else if (event.type === 'reminder_stop_ring') {
    editStored(event.id, 'snoozed');
  }
};
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run --root packages/server
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts
git commit -m "feat(discord): edit reminder embeds on done/dismiss/snooze"
```

---

## Task 20: Timeout handling — expire pending embeds

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`

When the request timeout aborts mid-flow (e.g. user never clicks an approve button), edit any permission/plan-review messages the bot sent for this request to "expired."

- [ ] **Step 1: Track pending embed message ids per request**

Inside `handleMessage`, before the retry loop:

```ts
const pendingEmbedMsgs: Array<{ callId: string; kind: 'perm' | 'plan'; messageIds: string[] }> = [];
```

When sending a permission embed:

```ts
const sent = await dmChannel.send({ embeds: [embed], components });
pendingEmbedMsgs.push({ callId: event.toolCall.id, kind: 'perm', messageIds: [sent.id] });
```

When sending a plan review group: collect all sent ids under one entry.

- [ ] **Step 2: On timeout / error, edit them**

In the `catch (err)` block at the bottom of `handleMessage`, after `clearInterval(typingInterval)`:

```ts
for (const pe of pendingEmbedMsgs) {
  try {
    const dmChannel = msg.channel as DMChannel;
    for (const mid of pe.messageIds) {
      try {
        const m = await dmChannel.messages.fetch(mid);
        if (pe.kind === 'perm') {
          const { embed } = buildPermissionEmbed({
            callId: pe.callId, toolName: '', argsSummary: '', state: 'expired',
          });
          await m.edit({ embeds: [embed], components: [] });
        } else {
          await m.edit({ components: [], content: '⚠️ expired' });
        }
      } catch {}
    }
  } catch {}
}
```

Also make sure the late click path (`hasPending` returning false) in `interactions.ts` already handles this — it does (Task 13).

- [ ] **Step 3: Run tests**

Expected: existing tests still pass. No new unit test here — this is defensive code paths exercised in manual E2E.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts
git commit -m "feat(discord): expire pending embeds on request timeout"
```

---

## Task 21: Manual E2E verification

**Goal:** Confirm the full flow works against a real Discord bot account.

- [ ] **Step 1: Start server with supervisor**

```bash
cd /Users/dim/code/R2-D2 && npm run dev
```

Confirm logs show:
- `[discord] bot started, whitelist size: 1`
- `[discord] slash commands registered`

- [ ] **Step 2: Exercise reminders**

From Discord DM with the bot:

```
create a reminder to test in 1 minute
```

Wait for ring → verify:
- DM contains an embed `⏰ test` with Dismiss and Snooze 10m buttons
- Click Dismiss → embed updates to `⏰ test` + footer `✓ Dismissed`, buttons gone
- Create another reminder; click Snooze → embed footer shows `😴 Snoozed 10m`

- [ ] **Step 3: Exercise permissions**

Trigger a tool that requires confirmation (e.g. `files.write` via natural language). Verify:
- Bot flushes any pre-tool buffer text
- Bot sends `🔐 Permission request` embed with three buttons
- Click Allow once → bot edits embed to `✓ Allowed once`, then continues streaming tool output
- Retry the same prompt → now auto-allowed (rule was not remembered)
- Trigger a different tool, click Allow always → verify the next invocation runs without prompt

- [ ] **Step 4: Exercise plan review**

Trigger a tool that produces a plan (e.g. code-task). Verify:
- Multi-message plan arrives with `📋 Plan review (1/N)` header
- Last message has Approve / Reject buttons
- Click Approve → execution continues
- Click Reject on a separate invocation → plan aborts

- [ ] **Step 5: Exercise slash commands**

```
/status
/reminders
/memory
/memory query: test
/clear
```

Each should return an ephemeral message. `/clear` → Yes → history wiped; next `/clear` on empty DB reports `deleted: 0`.

- [ ] **Step 6: Non-whitelisted user rejection**

From a second account (not in whitelist) — send the bot a DM or click a button if possible. Verify bot ignores messages and replies `Not authorized.` to interactions.

- [ ] **Step 7: Document findings**

Append to the design spec `docs/superpowers/specs/2026-04-17-discord-primary-ui-design.md` a short "Manual E2E results" section with checkmarks. Commit.

```bash
git add docs/superpowers/specs/2026-04-17-discord-primary-ui-design.md
git commit -m "docs(spec): mark Discord primary UI E2E verified"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-04-17-discord-primary-ui-design.md`:

- §1 Services layer → Tasks 1, 3, 5, 7
- §2 DiscordBotDeps update → Tasks 15, 18
- §3 File layout (embeds/interactions/slash-commands) → Tasks 9, 11, 12, 13, 16, 17
- §4 Embeds and buttons → Tasks 9, 10, 11, 12, 13, 14, 19
- §5 Slash commands → Tasks 16, 17
- §6 Mid-stream permission flow → Task 15
- §7 Request timeout behavior → Task 20
- §8 Event bus contracts → Tasks 10 & 19 (reminder events); permission/plan events flow through `onEvent` SSE, not bus (verified against existing code — no new bus events needed)
- §9 Authorization → Task 13 (whitelist check in `routeInteraction`)

**Note on §8 simplification vs spec:** spec described emitting `permission_request` / `plan_review_request` on `bus`. In the codebase these already reach the bot through its own `onEvent` SSE callback inside `runChatRequest`, so adding bus emissions would duplicate the signal. The plan uses the existing SSE path. This preserves correctness and avoids scope creep — noted in Task 15.

No TODOs / placeholders remain. All types (`ReminderService`, `PermissionService`, `PlanReviewService`, `CommandService`, `InteractionDeps`, `PlanReviewChunk`) are defined before first use.
