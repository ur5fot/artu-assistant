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

const MATCH_FORMAT: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      i: { type: 'integer', minimum: 0 },
      match: { type: 'boolean' },
    },
    required: ['i', 'match'],
    additionalProperties: false,
  },
};

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
    // The user already reopened this action after a wrong auto-close — never
    // re-close it from email evidence; only the manual ✓ Готово may close it.
    if (action.autoCloseBlocked) continue;
    const aHost = action.url ? hostOf(action.url) : null;
    for (const email of emails) {
      // A confirmation can only postdate the task. An email that arrived before
      // the topic even started is about something else (e.g. last month's
      // recurring bank notice) — skip it to avoid a false close.
      if (email.received_at < action.startedAt) continue;
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

// Returns the set of candidate indices the model marked match=true, or null
// when the reply is malformed (not a JSON array). A malformed reply is a
// provider failure, NOT a "no matches" verdict: the caller falls back to the
// other provider and never caches it, so one bad Ollama formatting can't
// suppress a candidate set until a new email/action appears (mirrors the
// scorer's normalize→null→fallback contract). A valid empty array `[]` is a
// real "no matches" verdict and returns an empty set (cacheable).
function parseMatches(raw: string, allowedIndices: ReadonlySet<number>, strictJson = false): Set<number> | null {
  let parsed: unknown;
  try {
    parsed = strictJson ? JSON.parse(raw.trim()) : extractJsonArray(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const confirmed = new Set<number>();
  for (const item of parsed) {
    if (!item || !Number.isInteger(item.i) || typeof item.match !== 'boolean') return null;
    if (!allowedIndices.has(item.i)) return null;
    if (item.match) confirmed.add(item.i);
  }
  return confirmed;
}

async function callOllama(ollama: OllamaClient, prompt: string, signal: AbortSignal): Promise<string> {
  const r = await ollama.chat({
    messages: [{ role: 'user', content: prompt }],
    system: MATCH_SYSTEM,
    signal,
    format: MATCH_FORMAT,
    temperature: 0,
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

// Resolves to the confirmed-match set, or null when no provider returned a
// parseable verdict (transient failure → caller skips without caching, so it
// retries next tick instead of suppressing the candidate set).
async function confirmMatches(
  cands: Candidate[],
  deps: Deps,
  signal: AbortSignal,
): Promise<Set<number> | null> {
  const rawPrompt = buildMatchPrompt(cands);
  const prompt = deps.piiProxy ? (await deps.piiProxy.anonymize(rawPrompt)).text : rawPrompt;
  const allowedIndices = new Set(cands.map((candidate) => candidate.i));
  const useOllama = deps.ollama && (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
  if (useOllama) {
    try {
      const matches = parseMatches(await callOllama(deps.ollama!, prompt, signal), allowedIndices, true);
      if (matches) return matches;
      console.warn('[emailActionMatch] Ollama reply malformed, falling back to Claude');
    } catch (err) {
      console.warn(
        '[emailActionMatch] Ollama call failed, falling back to Claude:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return parseMatches(await callClaude(deps.anthropic, prompt, signal), allowedIndices);
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

// Stable fingerprint of a candidate set (open actions × recent emails). Used to
// skip a redundant LLM re-scoring when nothing changed since the last no-match
// verdict — the heartbeat fires every 60s, but an unchanged set always yields
// the same answer, so re-asking the model is pure waste.
function candidateSignature(cands: Candidate[]): string {
  return cands.map((c) => `${c.action.topicId}:${c.email.id}`).join('|');
}

export function createEmailActionMatchHandler(deps: Deps): Handler {
  const lookbackHours = deps.lookbackHours ?? 72;
  const cooldownMs = deps.cooldownMs ?? 6 * 3600_000;
  // The candidate set last sent to the LLM that came back with no confirmed
  // match. While the open actions and in-window emails are unchanged, re-running
  // the model every tick can only repeat that "no" — so we short-circuit. Any
  // new email or new/closed action changes the signature and re-opens scoring.
  let lastNoMatchSig: string | null = null;
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

        // Same actions + same emails as the last no-match → the LLM would only
        // repeat itself. Skip the call until something actually changes.
        const sig = candidateSignature(candidates);
        if (sig === lastNoMatchSig) return { skip: true, reason: 'candidate set unchanged' };

        const confirmed = await confirmMatches(candidates, deps, ctx.signal);
        // No provider returned a parseable verdict — treat as transient and
        // retry next tick. Crucially we do NOT cache this set (lastNoMatchSig),
        // so a malformed reply can't suppress scoring until the set changes.
        if (confirmed === null) return { skip: true, reason: 'no parseable LLM verdict' };

        // Collapse to one close per topic (an action can match several emails);
        // keep the first confirming email for the notice.
        const closedByTopic = new Map<number, { action: OpenAction; email: EmailPendingRow }>();
        for (const c of candidates) {
          if (confirmed.has(c.i) && !closedByTopic.has(c.action.topicId)) {
            closedByTopic.set(c.action.topicId, { action: c.action, email: c.email });
          }
        }
        if (closedByTopic.size === 0) {
          // Remember this exact set so the next ticks don't re-ask the model
          // about emails it already rejected. Cleared implicitly once the set
          // changes (new email / new action). Not set on the match path: there
          // the closed actions leave the set, so the signature changes anyway.
          lastNoMatchSig = sig;
          return { skip: true, reason: 'no confirmed matches' };
        }

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
