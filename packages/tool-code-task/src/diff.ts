export interface FileStats {
  path: string;
  added: number;
  removed: number;
}

export function parseDiffStats(numstat: string): FileStats[] {
  return numstat
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 3) return null;
      const [addStr, remStr, ...pathParts] = parts;
      const added = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
      const removed = remStr === '-' ? 0 : parseInt(remStr, 10) || 0;
      return { path: pathParts.join('\t'), added, removed };
    })
    .filter((x): x is FileStats => x !== null);
}

export function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  kept.push(`... (${remaining} more lines truncated, click "Show full diff")`);
  return kept.join('\n');
}

export function summarizeDiff(files: FileStats[], commit: string): string {
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);
  const commitShort = commit ? commit.slice(0, 7) : 'no-commit';
  return `${files.length} files changed, +${totalAdded} -${totalRemoved}. Commit: ${commitShort}`;
}
