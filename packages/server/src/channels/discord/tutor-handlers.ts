import type Anthropic from '@anthropic-ai/sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { generateLesson } from '../../tutor/lesson-generator.js';
import type { Lesson } from '../../tutor/lesson-generator.js';
import { gradeMcq, gradeFree } from '../../tutor/grader.js';
import {
  beginPlacement,
  finishPlacement,
  recordPlacementAnswer,
} from '../../tutor/placement.js';
import type {
  PlacementQuestion,
  PlacementState,
} from '../../tutor/placement.js';
import {
  advance,
  currentExercise,
  routingState,
  statusForExercise,
} from '../../tutor/session.js';
import type { LessonPayload } from '../../tutor/session.js';
import type { TutorLesson, TutorStore } from '../../tutor/store.js';
import {
  RECENT_TOPICS_LIMIT,
  WEAK_MASTERY_THRESHOLD,
  truncateLabel,
} from '../../tutor/ui.js';

/** Wiring the tutor Discord surface needs. Absent/`enabled=false` ⇒ the
 *  `/english` command and `tutor:mcq:*` buttons reply "выключено" and no state
 *  is touched, keeping R2 unchanged when the flag is off. */
export interface TutorInteractionDeps {
  enabled: boolean;
  store: TutorStore;
  anthropic: Anthropic;
  model: string;
}

// A fresh signal per LLM call; the interaction lifecycle owns cancellation, so
// we never abort mid-flight — the deps just need a concrete AbortSignal.
function llmDeps(deps: TutorInteractionDeps) {
  return {
    anthropic: deps.anthropic,
    model: deps.model,
    signal: new AbortController().signal,
  };
}

function payloadOf(lesson: TutorLesson): LessonPayload {
  return lesson.payload as LessonPayload;
}

/** Build the option-button row for an MCQ exercise. customId encodes the lesson,
 *  the exercise index (so a stale button is detectable), and the chosen index. */
function buildMcqRow(
  lessonId: number,
  exIdx: number,
  options: string[],
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`tutor:mcq:${lessonId}:${exIdx}:${i}`)
        .setLabel(truncateLabel(opt))
        .setStyle(ButtonStyle.Secondary),
    );
  });
  return row;
}

/** Render one exercise as a message: MCQ → option buttons; free → prompt to
 *  answer in chat (Task 7's message hook routes that reply to the grader). */
function exerciseMessage(
  lesson: TutorLesson,
  exIdx: number,
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const { exercises } = payloadOf(lesson);
  const ex = exercises[exIdx];
  const header = `Упражнение ${exIdx + 1}/${exercises.length}`;
  if (ex && ex.kind === 'mcq') {
    return {
      content: `${header}\n${ex.prompt}`,
      components: [buildMcqRow(lesson.id, exIdx, ex.options)],
    };
  }
  return {
    content: `${header}\n${ex ? ex.prompt : ''}\n\n✍️ Ответь сообщением в чат.`,
    components: [],
  };
}

function formatPlacementQuestion(
  q: PlacementQuestion,
  index: number,
  total: number,
): string {
  const opts = q.options.map((o, i) => `${i + 1}) ${o}`).join('\n');
  return (
    `Вопрос ${index + 1}/${total}:\n${q.prompt}\n${opts}\n\n` +
    '✍️ Ответь номером варианта в чат.'
  );
}

/** Partial score for a lesson closed mid-flight (via `/english stop`):
 *  exercises answered correctly divided by the lesson's *total* exercise count
 *  (not just the ones answered), so stopping early can't be gamed into a
 *  perfect score. Folded into `tutor_progress` via `recordAttempt`. */
function partialScore(lesson: TutorLesson): number {
  const payload = payloadOf(lesson);
  const total = payload.exercises.length;
  if (total === 0) return 0;
  const correct = (payload.results ?? []).filter((r) => r?.correct).length;
  return correct / total;
}

// The message the `/english` handler edits into, and where the MCQ button posts
// its ephemeral feedback + the next exercise. Kept minimal so a fake stands in
// during tests.
interface SlashLike {
  options: { getString(name: string): string | null };
  reply(payload: unknown): Promise<unknown>;
  editReply(payload: unknown): Promise<unknown>;
  deferReply(payload?: unknown): Promise<unknown>;
}

interface ButtonLike {
  reply(payload: unknown): Promise<unknown>;
  followUp(payload: unknown): Promise<unknown>;
}

/**
 * `/english` — the tutor entrypoint.
 *  - flag off ⇒ "выключено";
 *  - `action=stop` ⇒ close the active lesson / cancel in-progress placement;
 *  - placement not done ⇒ start or resume the placement test;
 *  - active lesson ⇒ re-show the current exercise;
 *  - otherwise ⇒ generate and post a fresh lesson.
 */
export async function handleEnglishSlash(
  ixn: SlashLike,
  tutor: TutorInteractionDeps | undefined,
): Promise<void> {
  if (!tutor || !tutor.enabled) {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: '🎓 Учитель английского выключен.',
    });
    return;
  }

  if (ixn.options.getString('action') === 'stop') {
    await handleStop(ixn, tutor);
    return;
  }

  // Placement + lesson generation call Claude and exceed Discord's 3s ack
  // window — defer first so the follow-up editReply is accepted.
  await ixn.deferReply();

  const profile = tutor.store.getProfile();
  if (!profile || profile.placementState !== 'done') {
    await runPlacementFlow(ixn, tutor);
    return;
  }

  const active = tutor.store.getActiveLesson();
  if (active) {
    const msg = exerciseMessage(active, active.currentEx);
    await ixn.editReply({
      content: `📘 Продолжаем: **${active.topic}**\n\n${msg.content}`,
      components: msg.components,
    });
    return;
  }

  await startNewLesson(ixn, tutor);
}

async function handleStop(
  ixn: SlashLike,
  tutor: TutorInteractionDeps,
): Promise<void> {
  const active = tutor.store.getActiveLesson();
  const profile = tutor.store.getProfile();
  const placementActive = profile?.placementState === 'in_progress';
  if (!active && !placementActive) {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: 'Активного урока нет.',
    });
    return;
  }
  if (active) {
    const score = partialScore(active);
    tutor.store.completeLesson(active.id, score);
    tutor.store.recordAttempt({
      topic: active.topic,
      correct: score >= WEAK_MASTERY_THRESHOLD,
      outcome: score,
    });
  }
  if (placementActive) {
    tutor.store.updateProfile({
      placementState: 'none',
      placementPayload: null,
    });
  }
  await ixn.reply({
    flags: MessageFlags.Ephemeral,
    content: '🛑 Урок остановлен.',
  });
}

async function runPlacementFlow(
  ixn: SlashLike,
  tutor: TutorInteractionDeps,
): Promise<void> {
  // Resume an in-progress placement by re-showing the next unanswered question
  // (no LLM call needed — state is persisted).
  const profile = tutor.store.getProfile();
  if (profile?.placementState === 'in_progress') {
    const state = profile.placementPayload as PlacementState | null;
    if (state && Array.isArray(state.questions)) {
      const idx = (state.answers ?? []).length;
      // All questions answered but state is still in_progress: a prior
      // assessment call failed. Retry it instead of falling through to
      // beginPlacement, which would discard the already-answered questions.
      if (idx >= state.questions.length) {
        try {
          const outcome = await finishPlacement(tutor.store, llmDeps(tutor));
          if ('cancelled' in outcome) {
            await ixn.editReply({ content: 'Плейсмент был остановлен.' });
            return;
          }
          await ixn.editReply({
            content: `🎯 Уровень определён: ${outcome.level}.`,
          });
        } catch {
          await ixn.editReply({
            content: '⚠️ Не смог оценить placement, попробуй ещё раз позже.',
          });
        }
        return;
      }
      const question = state.questions[idx];
      if (question) {
        await ixn.editReply({
          content:
            '📝 Продолжаем placement-тест.\n\n' +
            formatPlacementQuestion(question, idx, state.questions.length),
        });
        return;
      }
    }
  }

  try {
    const step = await beginPlacement(tutor.store, llmDeps(tutor));
    await ixn.editReply({
      content:
        '📝 Определим твой уровень. Ответь на несколько вопросов.\n\n' +
        formatPlacementQuestion(step.question, step.index, step.total),
    });
  } catch {
    await ixn.editReply({
      content: '⚠️ Не смог собрать placement-тест, попробуй позже.',
    });
  }
}

async function startNewLesson(
  ixn: SlashLike,
  tutor: TutorInteractionDeps,
): Promise<void> {
  const profile = tutor.store.getProfile();
  if (!profile || !profile.level) {
    await ixn.editReply({
      content: '⚠️ Сначала нужно пройти placement (/english).',
    });
    return;
  }

  const progress = tutor.store.listProgress();
  const recentTopics = progress.slice(0, RECENT_TOPICS_LIMIT).map((p) => p.topic);
  const weakTopics = progress
    .filter((p) => p.mastery < WEAK_MASTERY_THRESHOLD)
    .map((p) => p.topic);

  let lesson: Lesson;
  try {
    lesson = await generateLesson(
      { level: profile.level, recentTopics, weakTopics },
      llmDeps(tutor),
    );
  } catch {
    await ixn.editReply({ content: '⚠️ Не смог собрать урок, попробуй позже.' });
    return;
  }

  // generateLesson awaited an LLM call; re-check the daily handler (or another
  // interaction) didn't create a lesson in the meantime before inserting a
  // second one.
  const concurrent = tutor.store.getActiveLesson();
  if (concurrent) {
    const msg = exerciseMessage(concurrent, concurrent.currentEx);
    await ixn.editReply({
      content: `📘 Продолжаем: **${concurrent.topic}**\n\n${msg.content}`,
      components: msg.components,
    });
    return;
  }

  const created = tutor.store.createLesson({
    topic: lesson.topic,
    payload: lesson,
  });
  const withStatus = tutor.store.updateLesson(created.id, {
    status: statusForExercise(lesson.exercises[0]),
  });
  const msg = exerciseMessage(withStatus, 0);
  await ixn.editReply({
    content: `📘 **${lesson.topic}**\n${lesson.explanation}\n\n${msg.content}`,
    components: msg.components,
  });
}

/**
 * `tutor:mcq:<lessonId>:<exIdx>:<choice>` — deterministically grade an MCQ
 * answer, advance the session, post ephemeral feedback + the next exercise (or
 * the final summary). Stale buttons (wrong index / done lesson) are rejected.
 */
export async function handleTutorMcqButton(
  ixn: ButtonLike,
  tutor: TutorInteractionDeps | undefined,
  rawId: string,
): Promise<void> {
  if (!tutor || !tutor.enabled) {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: '🎓 Учитель английского выключен.',
    });
    return;
  }

  const parts = rawId.split(':');
  const lessonId = Number(parts[0]);
  const exIdx = Number(parts[1]);
  const choice = Number(parts[2]);
  if (
    parts.length !== 3 ||
    !Number.isInteger(lessonId) ||
    !Number.isInteger(exIdx) ||
    !Number.isInteger(choice)
  ) {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Некорректная кнопка.',
    });
    return;
  }

  const lesson = tutor.store.getLesson(lessonId);
  if (!lesson || lesson.status === 'done') {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: 'Этот урок больше недоступен.',
    });
    return;
  }
  // Reject a stale button: the lesson has already moved past this exercise (or
  // is awaiting a free answer), so grading it would double-count.
  if (lesson.status !== 'awaiting_mcq' || lesson.currentEx !== exIdx) {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: 'Это упражнение уже пройдено.',
    });
    return;
  }

  const ex = payloadOf(lesson).exercises[exIdx];
  if (!ex || ex.kind !== 'mcq') {
    await ixn.reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Некорректное упражнение.',
    });
    return;
  }

  const { correct } = gradeMcq(ex, choice);
  const result = advance(tutor.store, lesson, { correct });
  const feedback = correct
    ? '✅ Верно!'
    : `❌ Неверно. Правильный ответ: ${ex.options[ex.answer]}`;
  await ixn.reply({ flags: MessageFlags.Ephemeral, content: feedback });

  if (result.done) {
    const pct = Math.round(result.score * 100);
    await ixn.followUp({
      content: `🏁 Урок «${result.lesson.topic}» завершён. Результат: ${pct}%.`,
    });
    return;
  }
  const next = exerciseMessage(result.lesson, result.nextIndex);
  await ixn.followUp({ content: next.content, components: next.components });
}

// The DM channel the free-text hook posts back into. Kept minimal (content +
// optional MCQ button rows) so a fake stands in during tests, and so bot.ts can
// adapt its DMChannel to it without exposing discord.js internals here.
export interface TutorMessageChannel {
  send(payload: {
    content: string;
    components?: ActionRowBuilder<ButtonBuilder>[];
  }): Promise<void>;
}

/** Parse a 1-based option number from a free-text reply. Returns the 0-based
 *  index, or null when the text isn't a valid in-range option number. */
function parseOptionChoice(text: string, optionCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > optionCount) return null;
  return n - 1;
}

async function routePlacementAnswer(
  text: string,
  tutor: TutorInteractionDeps,
  channel: TutorMessageChannel,
): Promise<void> {
  const state = tutor.store.getProfile()?.placementPayload as
    | PlacementState
    | null;
  if (!state || !Array.isArray(state.questions)) return;
  const idx = (state.answers ?? []).length;

  // All questions answered but state is still in_progress: a prior
  // assessment call failed. Any further message retries it (recovering the
  // "попробуй ответить ещё раз" promised below) instead of silently
  // no-opping on a nonexistent next question.
  if (idx >= state.questions.length) {
    try {
      const outcome = await finishPlacement(tutor.store, llmDeps(tutor));
      if ('cancelled' in outcome) return;
      await channel.send({
        content:
          `🎯 Уровень определён: **${outcome.level}**.\n` +
          'Напиши /english, чтобы начать первый урок.',
      });
    } catch {
      await channel.send({
        content: '⚠️ Не смог оценить placement, попробуй ответить ещё раз.',
      });
    }
    return;
  }

  const question = state.questions[idx];
  if (!question) return;

  const choice = parseOptionChoice(text, question.options.length);
  if (choice === null) {
    await channel.send({
      content: `Ответь номером варианта (1–${question.options.length}).`,
    });
    return;
  }

  let step;
  try {
    step = await recordPlacementAnswer(tutor.store, choice, llmDeps(tutor));
  } catch {
    // LLM assessment failed on the final answer — the choice stays persisted,
    // so the user can re-answer/resend to retry. State is not corrupted.
    await channel.send({
      content: '⚠️ Не смог оценить placement, попробуй ответить ещё раз.',
    });
    return;
  }

  if (step.done) {
    if ('cancelled' in step) return;
    await channel.send({
      content:
        `🎯 Уровень определён: **${step.level}**.\n` +
        'Напиши /english, чтобы начать первый урок.',
    });
    return;
  }
  await channel.send({
    content: formatPlacementQuestion(step.question, step.index, step.total),
  });
}

async function routeFreeAnswer(
  text: string,
  lesson: TutorLesson,
  tutor: TutorInteractionDeps,
  channel: TutorMessageChannel,
): Promise<void> {
  const ex = currentExercise(lesson);
  if (!ex || ex.kind !== 'free') return; // defensive: status said awaiting_free

  let result;
  try {
    result = await gradeFree(ex, text, llmDeps(tutor));
  } catch {
    // Grader failed — never fabricate a verdict. `current_ex` stays put so the
    // user can simply answer again.
    await channel.send({
      content: '⚠️ Не смог проверить ответ, попробуй ещё раз.',
    });
    return;
  }

  const mark =
    result.verdict === 'correct' ? '✅' : result.verdict === 'partial' ? '🟡' : '❌';
  await channel.send({ content: `${mark} ${result.feedback}` });

  // gradeFree awaits an LLM call; re-check the lesson wasn't stopped/advanced
  // in the meantime (e.g. `/english stop`, an interaction never serialized
  // against this hook) before writing — advance() trusts its lesson argument,
  // so grading a stale snapshot would clobber a concurrent stop/completion.
  const fresh = tutor.store.getLesson(lesson.id);
  if (!fresh || fresh.status !== 'awaiting_free' || fresh.currentEx !== lesson.currentEx) {
    return;
  }

  const advanced = advance(tutor.store, fresh, {
    correct: result.verdict === 'correct',
  });
  if (advanced.done) {
    const pct = Math.round(advanced.score * 100);
    await channel.send({
      content: `🏁 Урок «${advanced.lesson.topic}» завершён. Результат: ${pct}%.`,
    });
    return;
  }
  const next = exerciseMessage(advanced.lesson, advanced.nextIndex);
  await channel.send({ content: next.content, components: next.components });
}

/**
 * Free-text chat hook: when a placement is in progress or a lesson awaits a
 * free answer, an incoming plain DM is that answer — route it to the placement/
 * free grader instead of the general assistant. Returns `true` when it handled
 * the message (caller must not fall through to the assistant), `false` when no
 * tutor state is active (normal chat). Slash commands and buttons are Discord
 * interactions and never reach this path, so they always bypass.
 */
export async function routeTutorMessage(
  text: string,
  tutor: TutorInteractionDeps | undefined,
  channel: TutorMessageChannel,
): Promise<boolean> {
  if (!tutor || !tutor.enabled) return false;
  const routing = routingState(tutor.store);
  if (routing.kind === 'none') return false;
  if (routing.kind === 'placement') {
    await routePlacementAnswer(text, tutor, channel);
    return true;
  }
  await routeFreeAnswer(text, routing.lesson, tutor, channel);
  return true;
}
