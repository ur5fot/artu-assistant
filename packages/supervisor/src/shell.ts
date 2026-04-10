import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

export async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, shell: false, maxBuffer: MAX_BUFFER });
  return stdout.toString().trim();
}

export async function tryRun(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; code: number }> {
  try {
    const stdout = await run(cmd, args, cwd);
    return { ok: true, stdout, code: 0 };
  } catch (err: any) {
    return { ok: false, stdout: '', code: err?.code ?? 1 };
  }
}
