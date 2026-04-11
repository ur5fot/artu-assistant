import type { SSEEvent, PlanReviewResponse } from '@r2/shared';
import type { Eval } from './store.js';
import { loadEvals } from './store.js';
import { evaluate } from './evaluator.js';
import type { RunLoopFn } from '../tools/base.js';
import type { PendingConfirms, ConfirmResponse } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';

export interface EvalResult {
  evalId: string;
  input: string;
  passed: boolean;
  reason: string;
  actualText: string;
  actualToolCalls: string[];
}

export interface RunAllOptions {
  concurrency: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  // Optional: when provided, eval input/expected/actualText are anonymized
  // before being sent to the evaluator LLM, preventing PII leakage through
  // the deanonymized text_delta path.
  piiProxy?: PiiProxy;
}

export interface RunAllResult {
  passed: number;
  failed: number;
  results: EvalResult[];
}

// Auto-deny Maps for eval runs: when runToolLoop registers a confirm or
// plan-review handler, resolve it immediately as denied. Without this,
// an eval that invokes a confirm-level tool (code_task, code_deploy,
// eval_add, eval_run) would deadlock — there is no UI listening for
// confirmation events during an automated eval gate.
class AutoDenyConfirms extends Map<string, (r: ConfirmResponse) => void> {
  override set(key: string, fn: (r: ConfirmResponse) => void): this {
    fn({ allowed: false, remember: false });
    return this;
  }
}

class AutoDenyPlanReviews extends Map<string, (r: PlanReviewResponse) => void> {
  override set(key: string, fn: (r: PlanReviewResponse) => void): this {
    fn({ approved: false });
    return this;
  }
}

export async function runSingleEval(
  target: Eval,
  runLoop: RunLoopFn,
  signal?: AbortSignal,
  piiProxy?: PiiProxy,
): Promise<EvalResult> {
  let actualText = '';
  const actualToolCalls: string[] = [];

  const onEvent = (event: SSEEvent) => {
    if (event.type === 'text_delta') {
      actualText += event.content;
    } else if (event.type === 'tool_call_start') {
      actualToolCalls.push(event.toolCall.name);
    }
  };

  const pendingConfirms: PendingConfirms = new AutoDenyConfirms();
  const pendingPlanReviews: PendingPlanReviews = new AutoDenyPlanReviews();

  try {
    await runLoop({
      messages: [{ role: 'user', content: target.input }],
      onEvent,
      signal,
      pendingConfirms,
      pendingPlanReviews,
    });
  } catch (err) {
    return {
      evalId: target.id,
      input: target.input,
      passed: false,
      reason: `run error: ${err instanceof Error ? err.message : 'unknown'}`,
      actualText,
      actualToolCalls,
    };
  }

  const abortedResult = (): EvalResult => ({
    evalId: target.id,
    input: target.input,
    passed: false,
    reason: 'aborted',
    actualText,
    actualToolCalls,
  });

  if (signal?.aborted) return abortedResult();

  // If a PII proxy is provided, anonymize all text that will be sent to the
  // evaluator LLM. runLoop already deanonymized text_delta for display, so
  // actualText contains real PII; we re-anonymize through the same proxy so
  // entity tokens stay consistent across input/expected/actualText.
  let evalInput = target.input;
  let evalExpected = target.expected;
  let evalActual = actualText;
  if (piiProxy) {
    evalInput = (await piiProxy.anonymize(target.input)).text;
    if (signal?.aborted) return abortedResult();
    evalExpected = (await piiProxy.anonymize(target.expected)).text;
    if (signal?.aborted) return abortedResult();
    evalActual = (await piiProxy.anonymize(actualText)).text;
    if (signal?.aborted) return abortedResult();
  }

  const result = await evaluate({
    input: evalInput,
    expected: evalExpected,
    actualText: evalActual,
    actualToolCalls,
    toolUseExpected: target.toolUseExpected,
  });

  return {
    evalId: target.id,
    input: target.input,
    passed: result.passed,
    reason: result.reason,
    actualText,
    actualToolCalls,
  };
}

async function withLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let index = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (index < items.length) {
        if (signal?.aborted) return;
        const current = index++;
        await fn(items[current], current);
      }
    })());
  }
  await Promise.all(workers);
}

export async function runAllEvals(
  runLoop: RunLoopFn,
  options: RunAllOptions,
): Promise<RunAllResult> {
  if (options.signal?.aborted) {
    throw new Error('eval run aborted');
  }

  const evals = await loadEvals();

  if (options.signal?.aborted) {
    throw new Error('eval run aborted');
  }

  if (evals.length === 0) {
    return { passed: 0, failed: 0, results: [] };
  }

  const results: EvalResult[] = new Array(evals.length);
  const concurrency =
    Number.isFinite(options.concurrency) && options.concurrency >= 1
      ? Math.floor(options.concurrency)
      : 1;

  await withLimit(
    evals,
    concurrency,
    async (target, i) => {
      if (options.signal?.aborted) return;
      options.onProgress?.(`Running eval ${i + 1}/${evals.length}: ${target.id}`);
      results[i] = await runSingleEval(target, runLoop, options.signal, options.piiProxy);
    },
    options.signal,
  );

  // If the run was aborted, surface it as a hard failure so callers (e.g.
  // code_deploy pre-merge gate) cannot be unblocked by a partial/empty run.
  if (options.signal?.aborted) {
    throw new Error('eval run aborted');
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return { passed, failed, results };
}
