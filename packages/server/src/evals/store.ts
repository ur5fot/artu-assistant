import fs from 'node:fs';
import path from 'node:path';

export interface Eval {
  id: string;
  input: string;
  expected: string;
  toolUseExpected: string[] | null;
  createdAt: string;
}

function getEvalsPath(): string {
  return process.env.EVALS_PATH || path.resolve(process.cwd(), 'data', 'evals.json');
}

export async function loadEvals(): Promise<Eval[]> {
  const filePath = getEvalsPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse evals file at ${filePath}: ${err instanceof Error ? err.message : 'invalid JSON'}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Failed to parse evals file at ${filePath}: expected array`);
  }
  return parsed as Eval[];
}

export async function saveEval(newEval: Eval): Promise<void> {
  const filePath = getEvalsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const list = await loadEvals();
  list.push(newEval);

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2));
  fs.renameSync(tmpPath, filePath);
}
