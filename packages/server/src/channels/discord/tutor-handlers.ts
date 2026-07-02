import type Anthropic from '@anthropic-ai/sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { generateLesson } from '../../tutor/lesson-generator.js';
import type { Lesson } from '../../tutor/lesson-generator.js';
import { gradeMcq } from '../../tutor/grader.js';
import { beginPlacement } from '../../tutor/placement.js';
import type {
  PlacementQuestion,
  PlacementState,
} from '../../tutor/placement.js';
import { advance, statusForExercise } from '../../tutor/session.js';
import type { LessonPayload } from '../../tutor/session.js';
import type { TutorLesson, TutorStore } from '../../tutor/store.js';

/** Wiring the tutor Discord surface needs. Absent/`enabled=false` ⇒ the
 *  `/english` command and `tutor:mcq:*` buttons reply "выключено" and no state
 *  is touched, keeping R2 unchanged when the flag is off. */
export interface TutorInteractionDeps {
  enabled: boolean;
  store: TutorStore;
  anthropic: Anthropic;
  model: string;
}

// Discord button labels are capped at 80 chars and must be non-empty.
const BUTTON_LABEL_MAX = 80;
// Mastery below this counts a topic as "weak" — fed back to the generator so the
// next lesson reinforces it. Mirrors session.ts PASS_THRESHOLD.
const WEAK_MASTERY_THRESHOLD = 0.5;
// How many recent topics to steer the generator away from repeating.
const RECENT_TOPICS_LIMIT = 5;

function truncateLabel(s: string): string {
  const t = s.trim() || '—';
  return t.length > BUTTON_LABEL_MAX ? t.slice(0, BUTTON_LABEL_MAX - 1) + '…' : t;
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

/** Partial score for a lesson closed mid-flight (via `/english stop`): fraction
 *  of exercises answered correctly so far, so mastery isn't wiped to 0. */
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
  if (active) tutor.store.completeLesson(active.id, partialScore(active));
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
    if (step.done) {
      // beginPlacement always returns the first question; this branch is
      // unreachable but keeps the type exhaustive.
      await ixn.editReply({ content: `Уровень определён: ${step.level}.` });
      return;
    }
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
