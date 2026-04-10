import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';

export const codeDeployTool: ToolDefinition = {
  name: 'code_deploy',
  description: 'Deploy changes from dev branch to master. Merges dev into master and pushes. Use after code_task is complete and user has reviewed the changes. Always requires confirmation.',
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

    onProgress('Merging dev into master...');

    try {
      const res = await fetch(`http://localhost:${port}/api/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: ctx?.signal,
      });

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        // ignore JSON parse errors; data stays empty
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
        },
        display: {
          type: 'text',
          content: `✓ ${data.message}\n\nSupervisor will restart the worker within 60 seconds.`,
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

export default codeDeployTool;
