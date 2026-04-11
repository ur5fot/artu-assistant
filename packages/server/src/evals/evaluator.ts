import Anthropic from '@anthropic-ai/sdk';

export interface EvaluatorInput {
  input: string;
  expected: string;
  actualText: string;
  actualToolCalls: string[];
  toolUseExpected: string[] | null;
}

export interface EvaluatorResult {
  passed: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You evaluate AI assistant responses. Given a user input, expected behavior, what the assistant actually said, and which tools it called, decide if the response meets the expectation.

Rules:
- "expected" is a natural language description of correct behavior.
- "actualText" is the assistant's final text response (may be empty if it only used tools).
- "actualToolCalls" lists tool names the assistant invoked during the conversation.
- If "toolUseExpected" is not empty, ALL those tools MUST be in actualToolCalls. Missing any = fail.
- Be lenient on phrasing, strict on facts and required tools.
- If facts are wrong, fail.
- If required tools were not called, fail.

Reply ONLY with valid JSON: {"passed": true|false, "reason": "short explanation"}`;

export async function evaluate(input: EvaluatorInput): Promise<EvaluatorResult> {
  let client: Anthropic;
  try {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (err) {
    return { passed: false, reason: `evaluator API error: ${err instanceof Error ? err.message : 'init failed'}` };
  }

  const model = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

  const userContent = [
    `Input: ${input.input}`,
    `Expected: ${input.expected}`,
    `Actual text: ${input.actualText || '(empty)'}`,
    `Actual tools: ${input.actualToolCalls.length > 0 ? input.actualToolCalls.join(', ') : '(none)'}`,
    `Expected tools: ${input.toolUseExpected && input.toolUseExpected.length > 0 ? input.toolUseExpected.join(', ') : 'any'}`,
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    return {
      passed: false,
      reason: `evaluator API error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  const textBlock = response.content.find((b: any) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { passed: false, reason: 'evaluator returned no text' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { passed: false, reason: 'evaluator returned invalid JSON' };
  }

  if (typeof parsed.passed !== 'boolean' || typeof parsed.reason !== 'string') {
    return { passed: false, reason: 'evaluator returned incomplete result' };
  }

  return { passed: parsed.passed, reason: parsed.reason };
}
