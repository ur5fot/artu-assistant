import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PlanReviewResponse } from '@r2/shared';

export type { PlanReviewResponse };

export interface RalphexRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  requestPlanReview: (plan: string) => Promise<PlanReviewResponse>;
  signal?: AbortSignal;
}

export function buildPlanContent(task: string, context?: string): string {
  return `# R2 Auto Task

**Goal:** ${task}

**Context:** ${context ?? 'none'}

---

## Task 1: Implement the task

- [ ] **Step 1: Analyze the codebase**

Read relevant files to understand existing patterns.

- [ ] **Step 2: Make the required changes**

Implement the task. Keep changes minimal and focused.

- [ ] **Step 3: Run tests if they exist**

Run: \`npx vitest run\` in the relevant package.

- [ ] **Step 4: Stage changes**

Run: \`git add -A\`
(Do not commit — the harness will commit staged changes.)
`;
}

export async function runRalphex(params: RalphexRunParams): Promise<void> {
  const draftPlan = buildPlanContent(params.task, params.context);

  const review = await params.requestPlanReview(draftPlan);
  if (!review.approved) {
    throw new Error('Plan rejected by user');
  }
  // Treat an empty/whitespace editedPlan as "user did not edit", falling back
  // to the draft instead of writing an empty plan file to disk.
  const edited = review.editedPlan;
  const finalPlan = edited && edited.trim().length > 0 ? edited : draftPlan;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-task-'));
  const planPath = path.join(tmpDir, 'plan.md');
  fs.writeFileSync(planPath, finalPlan, { mode: 0o600 });

  const maxIterations = process.env.R2_RALPHEX_MAX_ITERATIONS || '20';

  // Escalation window for a non-responsive child. If SIGTERM doesn't cause
  // the child to exit within this many ms, we follow up with SIGKILL so an
  // abort request can't hang the whole tool call.
  const KILL_ESCALATION_MS = 5000;

  try {
    await new Promise<void>((resolve, reject) => {
      // Pre-spawn abort guard: if the caller already aborted before we got
      // here, don't start the child process at all. Without this the child
      // could outlive the request because the abort event fired before the
      // listener below was registered.
      if (params.signal?.aborted) {
        reject(new Error('ralphex run aborted before start'));
        return;
      }

      const child = spawn('ralphex', ['--max-iterations', maxIterations, planPath], {
        cwd: params.workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      let killTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        try { child.kill('SIGTERM'); } catch {}
        // If the child ignores SIGTERM (stuck in native code, trapped signal,
        // etc.), escalate to SIGKILL so the Promise can settle via 'exit'.
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_MS);
        killTimer.unref();
      };

      // Narrow race: the signal may have flipped to aborted between the
      // pre-spawn check and now. If so, trigger the kill path immediately
      // instead of waiting for a 'abort' event that will never fire.
      if (params.signal?.aborted) {
        onAbort();
      } else {
        params.signal?.addEventListener('abort', onAbort, { once: true });
      }

      // Cap the pending-line buffer so a pathological child that streams
      // megabytes without a newline can't grow the buffer unbounded. If the
      // limit is exceeded we flush the prefix as a synthetic line and drop
      // the rest until the next newline arrives.
      const MAX_PENDING_LINE = 16 * 1024;
      let stdoutBuffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) params.onProgress(trimmed.slice(0, 120));
        }
        if (stdoutBuffer.length > MAX_PENDING_LINE) {
          const trimmed = stdoutBuffer.slice(0, MAX_PENDING_LINE).trim();
          if (trimmed.length > 0) params.onProgress(trimmed.slice(0, 120));
          stdoutBuffer = '';
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text.length > 0) params.onProgress(text.slice(0, 120));
      });

      child.on('exit', (code) => {
        if (killTimer) clearTimeout(killTimer);
        params.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`ralphex exited with code ${code}`));
      });

      child.on('error', (err) => {
        if (killTimer) clearTimeout(killTimer);
        params.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
