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

export type JudgeVerdict = 'distracted' | 'break' | 'working';

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

const SYSTEM_PROMPT = `Ты — наблюдатель внимания R2. По таймлайну активных окон (приложения + заголовки + длительности, самые свежие сверху) и тому, на чём юзер залип прямо сейчас, реши одно из трёх:
- "distracted" — он дрейфанул из рабочего ритма в отвлечение и завис там;
- "break" — это законный, осмысленный перерыв;
- "working" — это на самом деле работа.

Различай работу и досуг ВНУТРИ одного приложения по ЗАГОЛОВКАМ, а не по имени приложения: один и тот же Chrome может быть localhost/GitHub (работа) или лентой YouTube (отвлечение). Заголовки могут обманывать — YouTube-туториал по его рабочему стеку это работа, а не залипание. Если сомневаешься — НЕ помечай "distracted" (точность важнее, ложные срабатывания дорого стоят).

Отвечай ТОЛЬКО инструментом report_verdict. Текст reason и work_summary — на русском, коротко.`;

const VERDICT_TOOL: Tool = {
  name: 'report_verdict',
  description: 'Сообщить вердикт о внимании юзера по таймлайну активности.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['distracted', 'break', 'working'],
        description: 'distracted — дрейф в отвлечение; break — законный перерыв; working — это работа.',
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
): { system: string; user: string } {
  const lines = timeline.map(
    (e) => `- ${e.app} · «${e.title}» — ${e.durationMin} мин`,
  );
  const timelineBlock = lines.length > 0 ? lines.join('\n') : '(пусто)';
  const currentLine = `${current.app} · «${current.title}» — уже ${current.dwellMin} мин`;

  const user = `Таймлайн активных окон (самые свежие сверху):
${timelineBlock}

Сейчас юзер залип здесь:
${currentLine}

Оцени и ответь инструментом report_verdict.`;

  return { system: SYSTEM_PROMPT, user };
}

export interface JudgeDeps {
  anthropic: Anthropic;
  model: string;
  signal: AbortSignal;
}

function isValidVerdict(v: unknown): v is JudgeVerdict {
  return v === 'distracted' || v === 'break' || v === 'working';
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
): Promise<JudgeResult> {
  const { anthropic, model, signal } = deps;
  const { system, user } = buildJudgePrompt(timeline, current);

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
