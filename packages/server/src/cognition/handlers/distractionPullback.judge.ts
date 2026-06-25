import type Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

/** One entry in the activity timeline fed to the judge (one app+title run). */
export interface TimelineEntry {
  app: string;
  title: string;
  durationMin: number;
}

/** The dwell the user is currently stuck in. */
export interface CurrentDwell {
  app: string;
  title: string;
  dwellMin: number;
}

/**
 * Aggregated past button feedback for the current dwell's title signature.
 * Injected into the judge prompt to bias (not override) the verdict.
 */
export interface FeedbackHint {
  signature: string;
  /** count of past "это по работе" for this signature */
  work: number;
  /** count of past "✅ Закончил" for this signature */
  done: number;
}

export type JudgeVerdict = 'distracted' | 'break' | 'working' | 'unknown';

export interface JudgeResult {
  verdict: JudgeVerdict;
  /** 0..100 */
  confidence: number;
  /** Short RU phrase explaining the verdict. */
  reason: string;
  /** Short RU summary of what the user was working on before the drift. */
  work_summary: string;
}

const MAX_TOKENS = 512;

const SYSTEM_PROMPT = `Ты — наблюдатель внимания R2. По таймлайну активных окон (приложения + заголовки + длительности, самые свежие сверху) и тому, на чём юзер залип прямо сейчас, реши одно из четырёх:
- "distracted" — он провалился в бесконечную ленту и скроллит её, теряя время;
- "break" — это законный отдых: он осознанно выбрал, чем заняться;
- "working" — это на самом деле работа;
- "unknown" — заголовки пустые/неинформативные, и ты не можешь понять, чем занят юзер.

КЛЮЧЕВАЯ граница между "distracted" и "break" — НЕ время суток и НЕ имя приложения, а ФОРМАТ потребления: бесконечная лента против осознанно выбранной вещи.

"distracted" — ТОЛЬКО бесконечные, ленточные форматы, где единица потребления — лента/поток, а не выбранная вещь:
- short-form ленты: YouTube Shorts, Reels, TikTok;
- ленты соцсетей: X/Twitter, Instagram, Facebook, Reddit;
- новостной скролл, бесконечная лента коротких рекомендаций.

"break" — осознанно ВЫБРАННЫЙ досуг: конкретная вещь с началом и концом, в ЛЮБОЙ час:
- музыка: трек, альбом, концерт, плейлист — даже если он перескакивает между ними;
- фильм, сериал, длинное видео; игра; лонгрид, статья.
Перескок между выбранными музыкальными клипами/треками — это всё ещё "break", а НЕ лента.

Различай работу и досуг ВНУТРИ одного приложения по ЗАГОЛОВКАМ, а не по имени приложения: один и тот же Chrome может быть localhost/GitHub (работа), музыкой/фильмом на YouTube (break) или лентой Shorts/соцсети (distracted). Заголовки могут обманывать — YouTube-туториал по его рабочему стеку это работа. Если сомневаешься — НЕ помечай "distracted" (точность важнее, ложные срабатывания дорого стоят).

Если заголовки пустые или неинформативные и ты не можешь понять, чем занят юзер — верни "unknown" (лучше промолчать, чем гадать "distracted").

Отвечай ТОЛЬКО инструментом report_verdict. Текст reason и work_summary — на русском, коротко.`;

const VERDICT_TOOL: Tool = {
  name: 'report_verdict',
  description: 'Сообщить вердикт о внимании юзера по таймлайну активности.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['distracted', 'break', 'working', 'unknown'],
        description:
          'distracted — провал в бесконечную ленту (Shorts/Reels/лента соцсетей/новостной скролл); break — осознанно выбранный досуг (музыка/фильм/игра/лонгрид), в любой час; working — это работа; unknown — заголовки пустые/неинформативные, понять нельзя.',
      },
      confidence: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Уверенность в вердикте, 0..100.',
      },
      reason: {
        type: 'string',
        description: 'Короткая фраза на русском, почему такой вердикт.',
      },
      work_summary: {
        type: 'string',
        description: 'Коротко на русском: на чём юзер работал до дрейфа.',
      },
    },
    required: ['verdict', 'confidence', 'reason', 'work_summary'],
  },
};

/**
 * Pure prompt builder — turns the activity timeline + current dwell into the
 * system + user strings handed to the judge. Deterministic and testable.
 */
export function buildJudgePrompt(
  timeline: TimelineEntry[],
  current: CurrentDwell,
  hint?: FeedbackHint,
): { system: string; user: string } {
  const lines = timeline.map(
    (e) => `- ${e.app} · «${e.title}» — ${e.durationMin} мин`,
  );
  const timelineBlock = lines.length > 0 ? lines.join('\n') : '(пусто)';
  const currentLine = `${current.app} · «${current.title}» — уже ${current.dwellMin} мин`;

  const feedbackBlock = buildFeedbackBlock(hint);

  const user = `Таймлайн активных окон (самые свежие сверху):
${timelineBlock}

Сейчас юзер залип здесь:
${currentLine}
${feedbackBlock}
Оцени и ответь инструментом report_verdict.`;

  return { system: SYSTEM_PROMPT, user };
}

/**
 * Renders the optional feedback section appended to the user message. Empty
 * string when there is no hint (today's behavior). Thresholds:
 * `work>=2` → hard bias to "working"; `work==1` → soft; `done>=1` → informative.
 */
function buildFeedbackBlock(hint?: FeedbackHint): string {
  if (!hint || (hint.work <= 0 && hint.done <= 0)) return '';
  const sig = hint.signature;
  const lines: string[] = [];
  if (hint.work >= 2) {
    lines.push(
      `По сигнатуре \`${sig}\` юзер уже ${hint.work}× помечал это как работу. НЕ ставь "distracted" — верни "working", если только заголовок прямо сейчас не явная бесконечная лента (Shorts/Reels/соцлента).`,
    );
  } else if (hint.work === 1) {
    lines.push(`По сигнатуре \`${sig}\` юзер 1× сказал, что это работа — учитывай это.`);
  }
  if (hint.done >= 1) {
    lines.push(
      `По сигнатуре \`${sig}\` юзер обычно сам доделывает и уходит — не торопись пинговать.`,
    );
  }
  if (lines.length === 0) return '';
  return `\nЧто известно из прошлой обратной связи:\n${lines.join('\n')}\n`;
}

export interface JudgeDeps {
  anthropic: Anthropic;
  model: string;
  signal: AbortSignal;
}

function isValidVerdict(v: unknown): v is JudgeVerdict {
  return v === 'distracted' || v === 'break' || v === 'working' || v === 'unknown';
}

/**
 * One LLM call with a forced `report_verdict` tool. Returns the validated
 * structure, or throws if the model failed to produce a valid tool call (the
 * handler maps the throw to verdict='error', never publishes — see spec §3/§Error).
 */
export async function judgeDistraction(
  deps: JudgeDeps,
  timeline: TimelineEntry[],
  current: CurrentDwell,
  hint?: FeedbackHint,
): Promise<JudgeResult> {
  const { anthropic, model, signal } = deps;
  const { system, user } = buildJudgePrompt(timeline, current, hint);

  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: VERDICT_TOOL.name },
    },
    { signal },
  );

  const content = msg.content as any[];
  const toolUse = content.find((b) => b.type === 'tool_use' && b.name === VERDICT_TOOL.name);
  if (!toolUse) {
    throw new Error('judge returned no report_verdict tool_use');
  }

  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  if (!isValidVerdict(input.verdict)) {
    throw new Error(`judge returned invalid verdict: ${String(input.verdict)}`);
  }
  const confidenceRaw = Number(input.confidence);
  if (!Number.isFinite(confidenceRaw)) {
    throw new Error(`judge returned invalid confidence: ${String(input.confidence)}`);
  }
  const confidence = Math.max(0, Math.min(100, Math.round(confidenceRaw)));

  return {
    verdict: input.verdict,
    confidence,
    reason: typeof input.reason === 'string' ? input.reason : '',
    work_summary: typeof input.work_summary === 'string' ? input.work_summary : '',
  };
}
