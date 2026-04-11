import type { SSEEvent } from '@r2/shared';
import type { Eval } from './store.js';
import { loadEvals } from './store.js';
import { evaluate } from './evaluator.js';

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
}

export interface RunAllResult {
  passed: number;
  failed: number;
  results: EvalResult[];
}

type RunLoopFn = (params: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
}) => Promise<void>;

export async function runSingleEval(
  target: Eval,
  runLoop: RunLoopFn,
  signal?: AbortSignal,
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

  try {
    await runLoop({
      messages: [{ role: 'user', content: target.input }],
      onEvent,
      signal,
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

  const result = await evaluate({
    input: target.input,
    expected: target.expected,
    actualText,
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

async function withLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (index < items.length) {
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
  const evals = await loadEvals();
  if (evals.length === 0) {
    return { passed: 0, failed: 0, results: [] };
  }

  const results: EvalResult[] = new Array(evals.length);
  const concurrency = Math.max(1, options.concurrency);

  await withLimit(evals, concurrency, async (target, i) => {
    options.onProgress?.(`Running eval ${i + 1}/${evals.length}: ${target.id}`);
    results[i] = await runSingleEval(target, runLoop, options.signal);
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return { passed, failed, results };
}
