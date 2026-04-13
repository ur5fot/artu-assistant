import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTool } from '../src/index.js';

function makeDeps() {
  return {
    getOverlay: vi.fn().mockReturnValue(null),
    setOverlay: vi.fn(),
    clearOverlay: vi.fn(),
  };
}

function getTools(deps = makeDeps()) {
  const tools = createTool(deps);
  const claude = tools.find((t) => t.name === 'prompt_overlay_claude')!;
  const ollama = tools.find((t) => t.name === 'prompt_overlay_ollama')!;
  return { tools, claude, ollama, deps };
}

describe('tool-prompt-overlay', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('creates two tools with kyrillic slash-command names', () => {
    const { tools, claude, ollama } = getTools(deps);
    expect(tools).toHaveLength(2);
    expect(claude.command?.name).toBe('клод-промпт');
    expect(ollama.command?.name).toBe('лама-промпт');
    expect(claude.permissionLevel).toBe('confirm');
    expect(claude.provider).toBe('all');
  });

  it('saves text via setOverlay and returns "збережено"', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({ text: 'відповідай коротко' });
    expect(res.success).toBe(true);
    expect(deps.setOverlay).toHaveBeenCalledWith('claude', 'відповідай коротко');
    expect(res.display?.content).toBe('збережено');
  });

  it('trims whitespace before saving', async () => {
    const { ollama } = getTools(deps);
    await ollama.handler({ text: '   hi   ' });
    expect(deps.setOverlay).toHaveBeenCalledWith('ollama', 'hi');
  });

  it('show=true returns current overlay', async () => {
    deps.getOverlay.mockReturnValue('already set');
    const { claude } = getTools(deps);
    const res = await claude.handler({ show: true });
    expect(res.success).toBe(true);
    expect(deps.getOverlay).toHaveBeenCalledWith('claude');
    expect(res.display?.content).toBe('already set');
  });

  it('show=true returns "порожньо" when no overlay', async () => {
    deps.getOverlay.mockReturnValue(null);
    const { claude } = getTools(deps);
    const res = await claude.handler({ show: true });
    expect(res.success).toBe(true);
    expect(res.display?.content).toBe('порожньо');
  });

  it('show=true returns "порожньо" when overlay is whitespace', async () => {
    deps.getOverlay.mockReturnValue('   ');
    const { ollama } = getTools(deps);
    const res = await ollama.handler({ show: true });
    expect(res.display?.content).toBe('порожньо');
  });

  it('reset=true calls clearOverlay and returns "скинуто"', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({ reset: true });
    expect(res.success).toBe(true);
    expect(deps.clearOverlay).toHaveBeenCalledWith('claude');
    expect(res.display?.content).toBe('скинуто');
  });

  it('rejects show + reset combination', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({ show: true, reset: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/--показати.*--скинути/);
    expect(deps.getOverlay).not.toHaveBeenCalled();
    expect(deps.clearOverlay).not.toHaveBeenCalled();
  });

  it('rejects show + text combination', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({ show: true, text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/--показати.*текст/);
  });

  it('rejects reset + text combination', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({ reset: true, text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/--скинути.*текст/);
  });

  it('returns usage error when nothing is provided', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/usage/);
    expect(deps.setOverlay).not.toHaveBeenCalled();
    expect(deps.clearOverlay).not.toHaveBeenCalled();
  });

  it('returns usage error when text is only whitespace', async () => {
    const { claude } = getTools(deps);
    const res = await claude.handler({ text: '   ' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/usage/);
    expect(deps.setOverlay).not.toHaveBeenCalled();
  });

  it('propagates error from setOverlay (e.g. length limit)', async () => {
    deps.setOverlay.mockImplementation(() => {
      throw new Error('prompt overlay too long (max 10000 chars)');
    });
    const { claude } = getTools(deps);
    const res = await claude.handler({ text: 'x'.repeat(20_000) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too long/);
  });

  it('claude and ollama tools operate on independent models', async () => {
    const { claude, ollama } = getTools(deps);
    await claude.handler({ text: 'a' });
    await ollama.handler({ text: 'b' });
    expect(deps.setOverlay).toHaveBeenNthCalledWith(1, 'claude', 'a');
    expect(deps.setOverlay).toHaveBeenNthCalledWith(2, 'ollama', 'b');
  });
});
