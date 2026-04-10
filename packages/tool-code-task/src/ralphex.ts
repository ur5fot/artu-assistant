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

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ralphex', ['--max-iterations', maxIterations, planPath], {
        cwd: params.workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      const onAbort = () => child.kill('SIGTERM');
      params.signal?.addEventListener('abort', onAbort, { once: true });

      let stdoutBuffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) params.onProgress(trimmed.slice(0, 120));
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text.length > 0) params.onProgress(text.slice(0, 120));
      });

      child.on('exit', (code) => {
        params.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`ralphex exited with code ${code}`));
      });

      child.on('error', (err) => {
        params.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
