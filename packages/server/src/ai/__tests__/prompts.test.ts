import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db.js', () => ({
  getOverlay: vi.fn(),
}));

import { getOverlay } from '../../db.js';
import { getSystemPrompt, getLocalSystemPrompt } from '../prompts.js';

const mockedGetOverlay = vi.mocked(getOverlay);

describe('prompts overlay integration', () => {
  beforeEach(() => {
    mockedGetOverlay.mockReset();
  });

  describe('getSystemPrompt (claude)', () => {
    it('appends overlay block when overlay is non-empty', () => {
      mockedGetOverlay.mockImplementation((m) => (m === 'claude' ? 'відповідай коротко' : null));
      const out = getSystemPrompt();
      expect(out).toContain('## Додаткові інструкції');
      expect(out).toContain('відповідай коротко');
      expect(out).toContain('Правила:');
    });

    it('omits overlay block when getOverlay returns null', () => {
      mockedGetOverlay.mockReturnValue(null);
      const out = getSystemPrompt();
      expect(out).not.toContain('## Додаткові інструкції');
      expect(out).toContain('Правила:');
    });

    it('omits overlay block when getOverlay returns empty string', () => {
      mockedGetOverlay.mockReturnValue('');
      const out = getSystemPrompt();
      expect(out).not.toContain('## Додаткові інструкції');
    });

    it('omits overlay block when getOverlay returns whitespace only', () => {
      mockedGetOverlay.mockReturnValue('   \n  ');
      const out = getSystemPrompt();
      expect(out).not.toContain('## Додаткові інструкції');
    });

    it('uses claude model key', () => {
      mockedGetOverlay.mockReturnValue(null);
      getSystemPrompt();
      expect(mockedGetOverlay).toHaveBeenCalledWith('claude');
    });
  });

  describe('getLocalSystemPrompt (ollama)', () => {
    it('appends overlay block when overlay is non-empty', () => {
      mockedGetOverlay.mockImplementation((m) => (m === 'ollama' ? 'англійською' : null));
      const out = getLocalSystemPrompt([{ name: 'web_search', description: 'search' }]);
      expect(out).toContain('## Додаткові інструкції');
      expect(out).toContain('англійською');
      expect(out).toContain('web_search');
    });

    it('omits overlay block when null', () => {
      mockedGetOverlay.mockReturnValue(null);
      const out = getLocalSystemPrompt();
      expect(out).not.toContain('## Додаткові інструкції');
    });

    it('uses ollama model key', () => {
      mockedGetOverlay.mockReturnValue(null);
      getLocalSystemPrompt();
      expect(mockedGetOverlay).toHaveBeenCalledWith('ollama');
    });
  });

  describe('multi-turn coalescing rule', () => {
    beforeEach(() => {
      mockedGetOverlay.mockReturnValue(null);
    });

    it('getSystemPrompt contains multi-turn rule marker', () => {
      const out = getSystemPrompt();
      expect(out).toContain('Склей повну команду з історії');
      expect(out).toContain('коротко (1-3 слова)');
    });

    it('getLocalSystemPrompt contains multi-turn rule marker', () => {
      const out = getLocalSystemPrompt();
      expect(out).toContain('Склей повну команду з історії');
      expect(out).toContain('коротко (1-3 слова)');
    });
  });
});
