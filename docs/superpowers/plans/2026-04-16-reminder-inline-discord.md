# Reminder Inline Chat Cards + Discord Delivery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace modal reminder popup with inline chat cards (dismiss/snooze buttons, audio), and deliver reminders to Discord DMs.

**Architecture:** Server-side: Discord bot subscribes to `reminderBus` and sends DMs on `reminder_ring`/`reminder_done`. Client-side: `useChat` hook listens to `/api/events` SSE for reminder events and inserts reminder messages into chat stream. New `ReminderCard` component renders inline with dismiss/snooze buttons. Old `ReminderAlarm` popup is deleted.

**Tech Stack:** React, EventSource (SSE), discord.js, vitest

---

### Task 1: Add `reminder` field to shared Message type

**Files:**
- Modify: `packages/shared/src/types.ts:7-16`

- [x] **Step 1: Add ReminderInfo type and extend Message**

In `packages/shared/src/types.ts`, add after `RecalledFact` interface (before `Message`):

```ts
export interface ReminderInfo {
  id: number;
  text: string;
  status: 'ringing' | 'paused' | 'done' | 'dismissed';
}
```

Add `reminder?: ReminderInfo;` to the `Message` interface after `recalledFacts`.

- [x] **Step 2: Verify build**

Run: `npm run -w @r2/shared build`
Expected: clean build

- [x] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add ReminderInfo type to Message"
```

---

### Task 2: Discord bot subscribes to reminderBus

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/index.ts:228-246`
- Test: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [x] **Step 1: Write test for reminder_ring DM delivery**

In `packages/server/src/channels/discord/__tests__/bot.test.ts`, add inside `describe('Discord bot', ...)`:

```ts
import { EventEmitter } from 'node:events';

describe('reminder delivery', () => {
  it('sends DM on reminder_ring to whitelisted users', async () => {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    // Pre-populate a fake DM channel in client.users cache
    const fakeDm = makeDmChannel();
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue({
        createDM: vi.fn().mockResolvedValue(fakeDm),
      }),
    };

    await setup({ _client: client as any, reminderBus });

    // Emit clientReady to trigger DM pre-cache
    client.emit('clientReady');
    await delay(100);

    // Emit reminder_ring
    reminderBus.emit('push', { type: 'reminder_ring', id: 1, text: 'Buy fish' });
    await delay(100);

    expect(fakeDm.send).toHaveBeenCalledWith('⏰ Buy fish');
  });

  it('sends DM on reminder_done', async () => {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    const fakeDm = makeDmChannel();
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue({
        createDM: vi.fn().mockResolvedValue(fakeDm),
      }),
    };

    await setup({ _client: client as any, reminderBus });
    client.emit('clientReady');
    await delay(100);

    reminderBus.emit('push', { type: 'reminder_done', id: 1 });
    await delay(100);

    expect(fakeDm.send).toHaveBeenCalledWith('⏰ пропущено: напоминание #1');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/channels/discord/__tests__/bot.test.ts`
Expected: FAIL — `reminderBus` not in deps

- [x] **Step 3: Add reminderBus to DiscordBotDeps and implement listener**

In `packages/server/src/channels/discord/bot.ts`:

Add to `DiscordBotDeps` interface:
```ts
reminderBus?: EventEmitter;
```

Add import at top:
```ts
import type { EventEmitter } from 'node:events';
import type { ServerPushEvent } from '@r2/shared';
```

Inside `startDiscordBot`, after the `clientReady` listener block (after DM pre-cache loop), add:

```ts
  // Subscribe to reminder events and forward to Discord DMs
  let reminderListener: ((event: ServerPushEvent) => void) | null = null;
  if (deps.reminderBus) {
    const dmChannels = new Map<string, DMChannel>();
    // Cache DM channels from the pre-cache step above
    client.on('clientReady', async () => {
      for (const userId of deps.whitelist) {
        const cached = client.channels.cache.find(
          (ch) => ch.type === ChannelType.DM && (ch as DMChannel).recipientId === userId,
        );
        if (cached) dmChannels.set(userId, cached as DMChannel);
      }
    });

    reminderListener = (event: ServerPushEvent) => {
      if (event.type === 'reminder_ring') {
        for (const dm of dmChannels.values()) {
          dm.send(`⏰ ${event.text}`).catch((err) =>
            console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err),
          );
        }
      } else if (event.type === 'reminder_done') {
        for (const dm of dmChannels.values()) {
          dm.send(`⏰ пропущено: напоминание #${event.id}`).catch((err) =>
            console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err),
          );
        }
      }
    };
    deps.reminderBus.on('push', reminderListener);
  }
```

Update the `stop` return to clean up the listener:
```ts
  return {
    stop: async () => {
      if (reminderListener && deps.reminderBus) {
        deps.reminderBus.off('push', reminderListener);
      }
      await client.destroy();
    },
  };
```

NOTE: the actual DM channel caching approach above is simplified. The pre-cache in `clientReady` already calls `user.createDM()` which populates `client.channels.cache`. The simplest approach is to iterate `deps.whitelist` and fetch from cache:

```ts
reminderListener = (event: ServerPushEvent) => {
  if (event.type !== 'reminder_ring' && event.type !== 'reminder_done') return;
  const text = event.type === 'reminder_ring'
    ? `⏰ ${event.text}`
    : `⏰ пропущено: напоминание #${event.id}`;
  for (const userId of deps.whitelist) {
    const user = client.users.cache.get(userId);
    if (!user) continue;
    user.createDM().then((dm) => dm.send(text)).catch((err) =>
      console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err),
    );
  }
};
deps.reminderBus.on('push', reminderListener);
```

- [x] **Step 4: Pass reminderBus in index.ts**

In `packages/server/src/index.ts`, add `reminderBus` to the `startDiscordBot` deps object (~line 228):

```ts
import { reminderBus } from './reminders/bus.js';
// ... (already imported)

discordBot = await startDiscordBot({
  // ... existing fields ...
  reminderBus,
});
```

- [x] **Step 5: Run test to verify it passes**

Run: `cd packages/server && npx vitest run src/channels/discord/__tests__/bot.test.ts`
Expected: PASS

- [x] **Step 6: Run full server tests**

Run: `cd packages/server && npm test`
Expected: all pass

- [x] **Step 7: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts packages/server/src/index.ts
git commit -m "feat(discord): deliver reminders via DM on reminder_ring/done"
```

---

### Task 3: Create ReminderCard component

**Files:**
- Create: `packages/client/src/components/ReminderCard.tsx`

- [x] **Step 1: Create the component**

Create `packages/client/src/components/ReminderCard.tsx`:

```tsx
import type { ReminderInfo } from '@r2/shared';

interface Props {
  reminder: ReminderInfo;
  onDismiss: (id: number) => void;
  onSnooze: (id: number) => void;
}

const borderColors: Record<ReminderInfo['status'], string> = {
  ringing: '#DC2626',
  paused: '#D97706',
  done: '#888',
  dismissed: '#888',
};

export function ReminderCard({ reminder, onDismiss, onSnooze }: Props) {
  const isActive = reminder.status === 'ringing' || reminder.status === 'paused';

  return (
    <div style={{
      background: '#f8f8f8',
      border: '1px solid #e5e5e5',
      borderLeft: `4px solid ${borderColors[reminder.status]}`,
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
      maxWidth: '80%',
      fontSize: 13,
    }}>
      <div style={{
        fontWeight: 600,
        marginBottom: isActive ? 8 : 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span style={reminder.status === 'ringing' ? {
          animation: 'pulse 1s ease-in-out infinite',
        } : undefined}>⏰</span>
        {reminder.text}
        {reminder.status === 'paused' && (
          <span style={{ fontSize: 11, color: '#D97706', fontWeight: 400 }}>(пауза)</span>
        )}
        {reminder.status === 'done' && (
          <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>(пропущено)</span>
        )}
        {reminder.status === 'dismissed' && (
          <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>(выключено)</span>
        )}
      </div>
      {isActive && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onDismiss(reminder.id)}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid #ccc',
              background: '#fff', cursor: 'pointer', fontSize: 12,
            }}
          >
            ✓ Выключить
          </button>
          <button
            onClick={() => onSnooze(reminder.id)}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid #ccc',
              background: '#fff', cursor: 'pointer', fontSize: 12,
            }}
          >
            😴 Через 10 мин
          </button>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Commit**

```bash
git add packages/client/src/components/ReminderCard.tsx
git commit -m "feat(client): add ReminderCard component with dismiss/snooze"
```

---

### Task 4: Wire ReminderCard into MessageBubble

**Files:**
- Modify: `packages/client/src/components/MessageBubble.tsx`

- [x] **Step 1: Add ReminderCard rendering**

In `packages/client/src/components/MessageBubble.tsx`:

Add import:
```ts
import { ReminderCard } from './ReminderCard';
```

Update Props interface — add:
```ts
onDismissReminder?: (id: number) => void;
onSnoozeReminder?: (id: number) => void;
```

In the JSX, right before the `{message.content && (` block, add:
```tsx
{message.reminder && (
  <ReminderCard
    reminder={message.reminder}
    onDismiss={onDismissReminder ?? (() => {})}
    onSnooze={onSnoozeReminder ?? (() => {})}
  />
)}
```

- [x] **Step 2: Update Chat.tsx to pass handlers**

Find `packages/client/src/components/Chat.tsx` and pass `onDismissReminder` and `onSnoozeReminder` from useChat to MessageBubble. (Implementation depends on what Chat.tsx looks like — the handlers will come from the useChat hook in Task 5.)

- [x] **Step 3: Commit**

```bash
git add packages/client/src/components/MessageBubble.tsx packages/client/src/components/Chat.tsx
git commit -m "feat(client): render ReminderCard inline in MessageBubble"
```

---

### Task 5: Add reminder event listener and audio to useChat

**Files:**
- Modify: `packages/client/src/hooks/useChat.ts`

- [x] **Step 1: Add reminder EventSource listener and handlers**

In `packages/client/src/hooks/useChat.ts`:

Add imports:
```ts
import { createAlarmAudio, type AlarmAudio } from '../lib/alarm-audio';
import type { ServerPushEvent, ReminderInfo } from '@r2/shared';
```

Inside `useChat()`, add audio ref:
```ts
const alarmRef = useRef<AlarmAudio | null>(null);
if (alarmRef.current === null) {
  alarmRef.current = createAlarmAudio();
}
const alarm = alarmRef.current;
```

Add a new `useEffect` for reminder SSE events (after the history-loading useEffect):
```ts
useEffect(() => {
  const src = new EventSource('/api/events');
  const onMessage = (ev: MessageEvent) => {
    let data: ServerPushEvent;
    try { data = JSON.parse(ev.data); } catch { return; }

    if (data.type === 'reminder_ring') {
      alarm.startLoop();
      const reminderId = `reminder-${data.id}`;
      setMessages((prev) => {
        const existing = prev.find((m) => m.id === reminderId);
        if (existing) {
          return prev.map((m) =>
            m.id === reminderId
              ? { ...m, reminder: { id: data.id, text: data.text, status: 'ringing' as const } }
              : m,
          );
        }
        return [
          ...prev,
          {
            id: reminderId,
            role: 'assistant' as const,
            content: '',
            timestamp: Date.now(),
            reminder: { id: data.id, text: data.text, status: 'ringing' as const },
          },
        ];
      });
    } else if (data.type === 'reminder_stop_ring') {
      alarm.stopLoop();
      setMessages((prev) =>
        prev.map((m) =>
          m.reminder?.id === data.id
            ? { ...m, reminder: { ...m.reminder!, status: 'paused' as const } }
            : m,
        ),
      );
    } else if (data.type === 'reminder_done') {
      alarm.stopLoop();
      setMessages((prev) =>
        prev.map((m) =>
          m.reminder?.id === data.id
            ? { ...m, reminder: { ...m.reminder!, status: 'done' as const } }
            : m,
        ),
      );
    }
  };
  src.addEventListener('message', onMessage);
  return () => {
    src.close();
    alarm.stopLoop();
  };
}, [alarm]);
```

Add dismiss and snooze callbacks:
```ts
const dismissReminder = useCallback(async (id: number) => {
  try {
    const res = await fetch('/api/reminder/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return;
  } catch { return; }
  alarm.stopLoop();
  setMessages((prev) =>
    prev.map((m) =>
      m.reminder?.id === id
        ? { ...m, reminder: { ...m.reminder!, status: 'dismissed' as const } }
        : m,
    ),
  );
}, [alarm]);

const snoozeReminder = useCallback(async (id: number) => {
  try {
    const res = await fetch('/api/reminder/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return;
  } catch { return; }
  alarm.stopLoop();
  setMessages((prev) =>
    prev.map((m) =>
      m.reminder?.id === id
        ? { ...m, reminder: { ...m.reminder!, status: 'dismissed' as const } }
        : m,
    ),
  );
}, [alarm]);
```

Add `dismissReminder` and `snoozeReminder` to the return object.

- [x] **Step 2: Verify build**

Run: `cd packages/client && npx tsc --noEmit`
Expected: clean

- [x] **Step 3: Commit**

```bash
git add packages/client/src/hooks/useChat.ts
git commit -m "feat(client): listen to reminder SSE events, play audio, manage lifecycle"
```

---

### Task 6: Delete ReminderAlarm popup

**Files:**
- Delete: `packages/client/src/components/ReminderAlarm.tsx`
- Delete: `packages/client/src/components/__tests__/ReminderAlarm.test.tsx`
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Remove from App.tsx**

In `packages/client/src/App.tsx`, remove the import line:
```ts
import { ReminderAlarm } from './components/ReminderAlarm';
```

Remove the usage in JSX:
```tsx
<ReminderAlarm />
```

- [ ] **Step 2: Delete the files**

```bash
rm packages/client/src/components/ReminderAlarm.tsx
rm packages/client/src/components/__tests__/ReminderAlarm.test.tsx
```

- [ ] **Step 3: Verify build**

Run: `cd packages/client && npx tsc --noEmit`
Expected: clean (no broken imports)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(client): remove ReminderAlarm popup, replaced by inline cards"
```

---

### Task 7: Full test suite + E2E verification

**Files:**
- All

- [ ] **Step 1: Run full server tests**

Run: `cd packages/server && npm test`
Expected: all pass

- [ ] **Step 2: Run full client build**

Run: `cd packages/client && npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Manual E2E test**

1. Start `npm run dev`
2. In web chat, tell R2: "напомни через 1 минуту тест"
3. Wait ~1 min. Verify:
   - Inline card appears in chat with ⏰ and alarm sound
   - Dismiss/snooze buttons work
   - No popup appears
4. In Discord DM, verify `⏰ тест` message arrives
5. Test snooze — verify alarm repeats after 10 min

- [ ] **Step 4: Commit and merge**

```bash
git checkout dev && git merge master --no-edit
git merge feature/reminder-inline-discord --no-ff -m "merge: reminder inline cards + discord delivery (dev)"
git checkout master && git merge dev --no-ff -m "merge: reminder inline cards + discord delivery"
git branch -d feature/reminder-inline-discord
```
