import type Anthropic from '@anthropic-ai/sdk';
import type { Handler } from '../types.js';
import type { EmailStore } from '../../emails/store.js';
import type { EmailPendingRow } from '../../emails/types.js';
import type { TopicStore, OpenAction } from '../../topics/store.js';
import type { OllamaClient } from '../../ai/ollama.js';
import type { PiiProxy } from '../../pii/proxy.js';
import { parseFromAddress } from '../../emails/address.js';
import { buildActionReopenComponents } from '../../channels/discord/embeds.js';

interface Deps {
  emailStore: EmailStore;
  topicStore: TopicStore;
  anthropic: Anthropic;
  ollama: OllamaClient | null;
  /** Anonymizer applied to the LLM prompt — real or passthrough. Optional so
   *  call sites without PII wiring stay a no-op (matches the urgent/digest
   *  handlers). The match returns only booleans, so no deanonymize is needed. */
  piiProxy?: PiiProxy | null;
  /** How far back to scan email_pending for confirmation emails. */
  lookbackHours?: number;
  /** Short cooldown after a successful auto-close publish so the handler does
   *  not re-run the LLM every tick while other open actions linger. */
  cooldownMs?: number;
}

// How many recent emails to consider as confirmation candidates, and the hard
// cap on (action,email) pairs sent to the LLM. Open actions are few and the
// domain/keyword gate filters most pairs out, so these are generous backstops
// rather than expected limits.
const MAX_EMAILS = 30;
const MAX_CANDIDATES = 20;
const MIN_KEYWORD_LEN = 4;
const SNIPPET_CHARS = 200;

interface Candidate {
  i: number;
  action: OpenAction;
  email: EmailPendingRow;
}

// Conservative by design: the model defaults to NOT-a-match and must see an
// explicit completion signal tied to THIS task. A wrong close is reversible via
// the "↩ Вернуть" button, but a false close still costs trust, so we bias hard
// toward false.
const MATCH_SYSTEM = `Ты сопоставляешь входящие письма с открытыми задачами пользователя.
Для каждой пары (задача, письмо) реши, подтверждает ли письмо, что ИМЕННО эта задача выполнена/закрыта.
match=true ТОЛЬКО если письмо явно сообщает о завершении этой задачи (оплата прошла, доступ выдан, заявка одобрена, изменение применено, подписка оформлена и т.п.).
Во ВСЕХ остальных случаях match=false. По умолчанию false: реклама, напоминание, счёт к оплате, просьба действовать, неоднозначное письмо — всё это false.
Отвечай ТОЛЬКО JSON массивом [{"i":<int>,"match":<bool>}, ...]. Без текста вокруг.`;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Bare host of an action's target_url, lowercased and `www.`-stripped, or null
// when the url is missing/unparseable.
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// Sender domain from a `From:` header (handles `Name <a@host>` via
// parseFromAddress, then takes the part after the last `@`).
function senderDomain(fromAddr: string): string | null {
  const addr = parseFromAddress(fromAddr);
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const dom = addr.slice(at + 1).trim().toLowerCase().replace(/^www\./, '');
  return dom || null;
}

// True when two domains are equal or one is a dot-boundary suffix of the other
// (e.g. `mail.github.com` vs `github.com`). Plain `includes` would over-match
// (`hub.com` ⊂ `github.com`), so the boundary check uses a leading dot.
function domainsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith('.' + b) || b.endsWith('.' + a);
}

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= MIN_KEYWORD_LEN);
}

// Cheap pre-LLM gate: does any meaningful word from the action's label/text
// appear in the email subject? Keeps the LLM call scoped to plausible pairs.
function keywordOverlap(action: OpenAction, subject: string): boolean {
  const subj = subject.toLowerCase();
  const kws = keywords(`${action.label} ${action.action}`);
  return kws.some((k) => subj.includes(k));
}

function buildCandidates(actions: OpenAction[], emails: EmailPendingRow[]): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  for (const action of actions) {
    const aHost = action.url ? hostOf(action.url) : null;
    for (const email of emails) {
      let domMatch = false;
      if (aHost) {
        const d = senderDomain(email.from_addr);
        domMatch = d ? domainsRelated(aHost, d) : false;
      }
      const kwMatch = keywordOverlap(action, email.subject);
      if (domMatch || kwMatch) {
        out.push({ i: i++, action, email });
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
  }
  return out;
}

function buildMatchPrompt(cands: Candidate[]): string {
  const payload = cands.map((c) => ({
    i: c.i,
    task: collapseWs(c.action.action),
    email: {
      from: collapseWs(c.email.from_addr),
      subject: collapseWs(c.email.subject),
      snippet: collapseWs(c.email.snippet).slice(0, SNIPPET_CHARS),
    },
  }));
  return `Сопоставь письма с задачами:\n\n${JSON.stringify(payload, null, 2)}`;
}

function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = candidate.trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON array found');
  return JSON.parse(trimmed.slice(start, end + 1));
}

// Returns the set of candidate indices the model marked match=true. A
// malformed/uncovered reply yields an empty set — conservative: nothing
// auto-closes, the user still has the ✓ Готово button.
function parseMatches(raw: string): Set<number> {
  const confirmed = new Set<number>();
  let parsed: unknown;
  try {
    parsed = extractJsonArray(raw);
  } catch {
    return confirmed;
  }
  if (!Array.isArray(parsed)) return confirmed;
  for (const item of parsed) {
    if (item && typeof item.i === 'number' && item.match === true) {
      confirmed.add(item.i);
    }
  }
  return confirmed;
}

async function callOllama(ollama: OllamaClient, prompt: string, signal: AbortSignal): Promise<string> {
  const r = await ollama.chat({
    messages: [{ role: 'user', content: prompt }],
    system: MATCH_SYSTEM,
    signal,
  });
  return r.text;
}

async function callClaude(anthropic: Anthropic, prompt: string, signal: AbortSignal): Promise<string> {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: 512,
      system: MATCH_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    },
    { signal },
  );
  const block = (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  return block?.text ?? '';
}

async function confirmMatches(cands: Candidate[], deps: Deps, signal: AbortSignal): Promise<Set<number>> {
  const rawPrompt = buildMatchPrompt(cands);
  const prompt = deps.piiProxy ? (await deps.piiProxy.anonymize(rawPrompt)).text : rawPrompt;
  const useOllama = deps.ollama && (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
  let raw: string;
  if (useOllama) {
    try {
      raw = await callOllama(deps.ollama!, prompt, signal);
    } catch (err) {
      console.warn(
        '[emailActionMatch] Ollama call failed, falling back to Claude:',
        err instanceof Error ? err.message : err,
      );
      raw = await callClaude(deps.anthropic, prompt, signal);
    }
  } else {
    raw = await callClaude(deps.anthropic, prompt, signal);
  }
  return parseMatches(raw);
}

function formatNotice(closed: Array<{ action: OpenAction; email: EmailPendingRow }>): string {
  const lines = closed.map(({ action, email }) => {
    const sender = collapseWs(parseFromAddress(email.from_addr));
    return `• «${collapseWs(action.action)}» — подтверждение от ${sender}`;
  });
  const head =
    closed.length === 1
      ? '✅ Закрыл задачу — пришло подтверждение письмом:'
      : `✅ Закрыл ${closed.length} задач — пришли подтверждения письмом:`;
  return `${head}\n${lines.join('\n')}\n\nЕсли поторопился — верни кнопкой ↩`;
}

export function createEmailActionMatchHandler(deps: Deps): Handler {
  const lookbackHours = deps.lookbackHours ?? 72;
  const cooldownMs = deps.cooldownMs ?? 6 * 3600_000;
  return {
    name: 'emailActionMatch',
    trigger(state) {
      // Cheap gate: nothing to match against → skip without any LLM call.
      if (deps.topicStore.getOpenActions().length === 0) return false;
      // Cooldown only after a successful publish (mirrors emailDigest): skips
      // and errors must stay retry-able so a transient LLM/Discord failure does
      // not silence auto-close for the full window.
      const publishedRecently =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        state.now - state.lastFiredAt < cooldownMs;
      if (publishedRecently) return false;
      return true;
    },
    async run(ctx) {
      try {
        const actions = deps.topicStore.getOpenActions();
        if (actions.length === 0) return { skip: true, reason: 'no open actions' };
        const recent = deps.emailStore.fetchInWindow(lookbackHours, MAX_EMAILS, ctx.firedAt);
        if (recent.length === 0) return { skip: true, reason: 'no recent emails' };

        const candidates = buildCandidates(actions, recent);
        if (candidates.length === 0) return { skip: true, reason: 'no candidate pairs' };

        const confirmed = await confirmMatches(candidates, deps, ctx.signal);

        // Collapse to one close per topic (an action can match several emails);
        // keep the first confirming email for the notice.
        const closedByTopic = new Map<number, { action: OpenAction; email: EmailPendingRow }>();
        for (const c of candidates) {
          if (confirmed.has(c.i) && !closedByTopic.has(c.action.topicId)) {
            closedByTopic.set(c.action.topicId, { action: c.action, email: c.email });
          }
        }
        if (closedByTopic.size === 0) return { skip: true, reason: 'no confirmed matches' };

        const closed = [...closedByTopic.values()];
        const now = ctx.firedAt;
        return {
          publish: true,
          content: formatNotice(closed),
          components: buildActionReopenComponents(closed.map((c) => c.action)),
          // Dismiss only after the DM lands. If the publish fails the actions
          // stay open and the next tick retries — otherwise a Discord outage
          // would silently close them with no notice and no reopen button.
          onPublished: () => {
            for (const { action } of closed) deps.topicStore.dismissAction(action.topicId, now);
          },
        };
      } catch (err) {
        return { error: true, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
