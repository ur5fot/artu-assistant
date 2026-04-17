import { describe, it, expect } from 'vitest';
import { buildToolCallEmbed, buildDiffAttachment, SILENT_TOOLS } from '../tool-embeds.js';
import type { ToolCall } from '@r2/shared';

function mkTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'file_write',
    input: { path: '/tmp/x.txt' },
    status: 'running',
    ...overrides,
  };
}

describe('SILENT_TOOLS', () => {
  it('contains memory_search and memory_save', () => {
    expect(SILENT_TOOLS).toContain('memory_search');
    expect(SILENT_TOOLS).toContain('memory_save');
  });
});

describe('buildToolCallEmbed — running', () => {
  it('returns null for silent tools', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool({ name: 'memory_search' }),
    });
    expect(result).toBeNull();
  });

  it('running embed has 🔧 icon and name', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool(),
    });
    expect(result).not.toBeNull();
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 file_write');
    expect(e.description).toBe('running…');
    // Discord color is an integer; running is gray
    expect(typeof e.color).toBe('number');
  });
});

describe('buildToolCallEmbed — progress', () => {
  it('progress state: title 🔧, description is progress text', () => {
    const result = buildToolCallEmbed({
      state: 'progress',
      toolCall: mkTool(),
      progress: 'writing bytes 512/1024',
    });
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 file_write');
    expect(e.description).toBe('writing bytes 512/1024');
  });

  it('progress: truncates description at 3800 chars', () => {
    const long = 'x'.repeat(5000);
    const result = buildToolCallEmbed({
      state: 'progress',
      toolCall: mkTool(),
      progress: long,
    });
    expect(result!.toJSON().description!.length).toBeLessThanOrEqual(3800);
  });
});

describe('buildToolCallEmbed — done', () => {
  it('done state: green, ✅ icon, result display content', () => {
    const result = buildToolCallEmbed({
      state: 'done',
      toolCall: mkTool({
        status: 'done',
        result: { success: true, display: { type: 'text', content: 'wrote 100 bytes' } },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('✅ file_write');
    expect(e.description).toBe('wrote 100 bytes');
    expect(e.color).toBe(0x22c55e);
  });

  it('done with no display: description is fallback "done"', () => {
    const result = buildToolCallEmbed({
      state: 'done',
      toolCall: mkTool({ status: 'done', result: { success: true } }),
    });
    expect(result!.toJSON().description).toBe('done');
  });
});

describe('buildToolCallEmbed — error', () => {
  it('error state: red, ❌, error text in description', () => {
    const result = buildToolCallEmbed({
      state: 'error',
      toolCall: mkTool({
        status: 'error',
        result: { success: false, error: 'permission denied' },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('❌ file_write');
    expect(e.description).toBe('permission denied');
    expect(e.color).toBe(0xef4444);
  });
});

describe('buildToolCallEmbed — code_task special', () => {
  it('running code_task: description is Task line', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool({
        name: 'code_task',
        input: { task: 'refactor auth' },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 code_task');
    expect(e.description).toContain('refactor auth');
  });

  it('done code_task: fields for Task, Commit, Files', () => {
    const result = buildToolCallEmbed({
      state: 'done',
      toolCall: mkTool({
        name: 'code_task',
        input: { task: 'refactor auth' },
        result: {
          success: true,
          data: {
            commit: 'abc1234567',
            mode: 'ralphex',
            files: [
              { path: 'src/a.ts', added: 5, removed: 1 },
              { path: 'src/b.ts', added: 2, removed: 0 },
            ],
            durationMs: 192000,
          },
        },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('✅ code_task');
    const fieldNames = (e.fields ?? []).map((f: any) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(['Task', 'Commit', 'Files']));
    const filesField = (e.fields ?? []).find((f: any) => f.name === 'Files');
    expect(filesField?.value).toContain('src/a.ts');
    expect(filesField?.value).toContain('+5');
    expect(filesField?.value).toContain('-1');
  });
});

describe('buildDiffAttachment', () => {
  const smallDiff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n';

  it('returns attachment with commit-prefixed name when commit present', () => {
    const result = buildDiffAttachment({
      callId: 'x',
      fullDiff: smallDiff,
      commit: 'abcdef1234567890',
    });
    expect(result).not.toBeNull();
    expect((result as any).name).toBe('code_task_abcdef1.diff');
    expect((result as any).attachment).toBeInstanceOf(Buffer);
    expect(((result as any).attachment as Buffer).toString('utf-8')).toBe(smallDiff);
  });

  it('falls back to callId when no commit', () => {
    const result = buildDiffAttachment({ callId: 'call-77', fullDiff: smallDiff });
    expect((result as any).name).toBe('code_task_call-77.diff');
  });

  it('returns null when fullDiff empty', () => {
    expect(buildDiffAttachment({ callId: 'x', fullDiff: '' })).toBeNull();
  });

  it('returns { oversize: true } when diff > 24 MB', () => {
    const huge = 'x'.repeat(25 * 1024 * 1024);
    const result = buildDiffAttachment({ callId: 'x', fullDiff: huge });
    expect(result).toEqual({ oversize: true });
  });
});
