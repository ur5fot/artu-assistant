import { describe, it, expect } from 'vitest';
import { shouldEscalate } from '../escalation-check.js';

describe('shouldEscalate', () => {
  it('escalates on empty text', () => {
    const result = shouldEscalate('');
    expect(result.escalate).toBe(true);
    expect(result.reason).toMatch(/empty/);
  });

  it('escalates on whitespace-only text', () => {
    expect(shouldEscalate('   \n\t').escalate).toBe(true);
  });

  it('escalates on English tool-need phrases', () => {
    expect(shouldEscalate('I need to use web search for this').escalate).toBe(true);
    expect(shouldEscalate('I cannot answer without a tool').escalate).toBe(true);
    expect(shouldEscalate("I can't do that without code access").escalate).toBe(true);
    expect(shouldEscalate('Let me search for that').escalate).toBe(true);
    expect(shouldEscalate('Let me look up the current weather').escalate).toBe(true);
  });

  it('escalates on Russian tool-need phrases', () => {
    expect(shouldEscalate('я не могу без доступа к поиску').escalate).toBe(true);
    expect(shouldEscalate('мне нужно использовать инструмент').escalate).toBe(true);
    expect(shouldEscalate('я должен воспользоваться поиском').escalate).toBe(true);
  });

  it('escalates on bracketed tool markers', () => {
    expect(shouldEscalate('[need search]').escalate).toBe(true);
    expect(shouldEscalate('[need code]').escalate).toBe(true);
    expect(shouldEscalate('[need file]').escalate).toBe(true);
  });

  it('does not escalate on plain factual answer', () => {
    expect(shouldEscalate('The answer is 4.').escalate).toBe(false);
    expect(shouldEscalate('Hello, how can I help you today?').escalate).toBe(false);
  });

  it('does not escalate on Russian factual answer', () => {
    expect(shouldEscalate('Два плюс два равно четыре.').escalate).toBe(false);
    expect(shouldEscalate('Привет, чем могу помочь?').escalate).toBe(false);
  });

  it('does not escalate on long explanatory answer', () => {
    const long = 'JavaScript is a programming language primarily used for web development. '.repeat(5);
    expect(shouldEscalate(long).escalate).toBe(false);
  });
});
