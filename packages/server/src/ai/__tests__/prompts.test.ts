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
      const out = getLocalSystemPrompt('web');
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

  describe('email-check routing rule', () => {
    beforeEach(() => {
      mockedGetOverlay.mockReturnValue(null);
    });

    it('getSystemPrompt routes email checks to emails_status', () => {
      const out = getSystemPrompt();
      expect(out).toContain('emails_status');
      expect(out).toContain('awaiting_count');
      expect(out).toContain('accounts_count');
    });

    it('getLocalSystemPrompt routes email checks to emails_status', () => {
      const out = getLocalSystemPrompt('mail');
      expect(out).toContain('emails_status');
      expect(out).toContain('awaiting_count');
      expect(out).toContain('emails_get');
    });

    it('getSystemPrompt routes dismiss + forbids faked external actions', () => {
      const out = getSystemPrompt();
      expect(out).toContain('emails_dismiss');
      expect(out).toContain('вручну');
      expect(out).toContain('не вигадуй');
    });

    it('getLocalSystemPrompt excludes mail mutations and forbids faked external actions', () => {
      const out = getLocalSystemPrompt('mail');
      expect(out).not.toContain('emails_dismiss');
      expect(out).toContain('лише читати');
      expect(out).toContain('Не вигадуй');
    });
  });

  describe('activity routing rule', () => {
    beforeEach(() => {
      mockedGetOverlay.mockReturnValue(null);
    });

    it('getSystemPrompt routes activity questions to activity tool', () => {
      const out = getSystemPrompt();
      expect(out).toContain('activity');
      expect(out).toContain('екранний час');
    });

    it('getLocalSystemPrompt routes activity questions to activity tool', () => {
      const out = getLocalSystemPrompt('activity');
      expect(out).toContain('activity');
      expect(out).toContain("комп'ютером");
    });

    it('getSystemPrompt forbids false "no access" claims', () => {
      const out = getSystemPrompt();
      expect(out).toContain('немає доступу');
      expect(out).toContain('фізично недоступно');
    });

    it('getLocalSystemPrompt forbids false "no access" claims', () => {
      const out = getLocalSystemPrompt('activity');
      expect(out).toContain('немає доступу');
      expect(out).toContain('порожній');
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
      expect(out).toContain('продовжувати попередній діалог');
      expect(out).toContain('врахуй історію');
    });

    it('multi-turn rule survives when overlay is applied', () => {
      // Overlay is appended, not replacing the base — so the rule must
      // still be present. Guards against a regression that swaps append
      // for replace and silently strips BASE_RULES.
      mockedGetOverlay.mockReturnValue('відповідай англійською');
      const claudeOut = getSystemPrompt();
      const ollamaOut = getLocalSystemPrompt();
      expect(claudeOut).toContain('Склей повну команду з історії');
      expect(ollamaOut).toContain('врахуй історію');
    });
  });
});
