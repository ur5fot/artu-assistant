import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';
import type { ToolDeps } from '@r2/server/tools/base.js';
import { runAllEvals, type EvalResult } from '@r2/server/evals/runner.js';

export function createTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'code_deploy',
    description: 'Deploy changes from dev branch to master. Runs pre-merge evals, then merges dev into master and pushes. Use after code_task is complete and user has reviewed the changes. Always requires confirmation.',
    permissionLevel: 'confirm',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },

    preCheck: async () => ({
      destructive: true,
      reason: 'deploys to production master branch',
    }),

    async handler(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
      const onProgress = ctx?.onProgress ?? (() => {});
      const port = process.env.PORT || '3001';

      onProgress('Running pre-merge evals...');

      let evalsResult;
      try {
        evalsResult = await runAllEvals(deps.runLoop, {
          concurrency: parseInt(process.env.EVAL_CONCURRENCY || '3', 10),
          onProgress,
          signal: ctx?.signal,
          piiProxy: deps.piiProxy,
        });
      } catch (err) {
        return {
          success: false,
          error: `Eval run failed: ${err instanceof Error ? err.message : 'unknown'}`,
        };
      }

      if (evalsResult.failed > 0) {
        const failedList = evalsResult.results
          .filter((r: EvalResult) => !r.passed)
          .map((r: EvalResult) => `  - ${r.evalId}: ${r.reason}`)
          .join('\n');
        return {
          success: false,
          error: `Merge blocked: ${evalsResult.failed} evals failed\n${failedList}`,
          data: evalsResult,
        };
      }

      onProgress(`${evalsResult.passed} evals passed, merging...`);

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        let data: any = {};
        try {
          data = await res.json();
        } catch {
          // ignore
        }

        if (res.status === 409 && Array.isArray(data.conflicts) && data.conflicts.length > 0) {
          return {
            success: false,
            error: `Merge conflicts in: ${data.conflicts.join(', ')}`,
          };
        }

        if (!res.ok) {
          return {
            success: false,
            error: data.error || `Merge failed with status ${res.status}`,
          };
        }

        onProgress(`Deployed ${String(data.commit || '').slice(0, 7)}`);

        return {
          success: true,
          data: {
            commit: data.commit,
            filesChanged: data.filesChanged,
            summary: data.message,
            evalsPassed: evalsResult.passed,
          },
          display: {
            type: 'text',
            content: `✓ ${data.message}\n\n${evalsResult.passed} evals passed.\nSupervisor will restart the worker within 60 seconds.`,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'deploy request failed',
        };
      }
    },
  };
}
