import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';
import type { ToolDeps } from '@r2/server/tools/base.js';
import { runAllEvals } from '@r2/server/evals/runner.js';
import type { EvalResult } from '@r2/server/evals/runner.js';

function formatSummary(input: { passed: number; failed: number; results: EvalResult[] }): string {
  const header = `Evals: ${input.passed} passed, ${input.failed} failed`;
  const failures = input.results
    .filter((r) => !r.passed)
    .map((r) => `  ✗ ${r.evalId}: ${r.reason}`);
  return failures.length > 0 ? `${header}\n${failures.join('\n')}` : header;
}

export function createTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'eval_run',
    description: 'Run all behavior evals against the current R2. Returns pass/fail summary with details. Use when user asks to check regressions or before deploying.',
    permissionLevel: 'confirm',
    provider: 'claude' as const,
    command: {
      name: 'тести',
      description: 'Запустити всі поведінкові тести',
    },
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async handler(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
      const onProgress = ctx?.onProgress ?? (() => {});
      onProgress('Loading evals...');

      try {
        const { passed, failed, results } = await runAllEvals(deps.runLoop, {
          concurrency: parseInt(process.env.EVAL_CONCURRENCY || '3', 10),
          onProgress,
          signal: ctx?.signal,
          piiProxy: deps.piiProxy,
        });

        return {
          success: failed === 0,
          data: { passed, failed, results },
          display: {
            type: 'text',
            content: formatSummary({ passed, failed, results }),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'eval run failed',
        };
      }
    },
  };
}
