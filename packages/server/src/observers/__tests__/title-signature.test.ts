import { describe, it, expect } from 'vitest';
import { titleSignature } from '../title-signature.js';

describe('titleSignature', () => {
  const cases: Array<[string, string, string | null, string]> = [
    // [description, app, title, expected]

    // --- known domains: substring scan ---
    ['youtube domain', 'Google Chrome', 'Funny cats - YouTube', 'Google Chrome:youtube'],
    ['facebook domain', 'Google Chrome', 'Facebook - Log In or Sign Up', 'Google Chrome:facebook'],
    ['twitch domain', 'Firefox', 'someStreamer - Twitch', 'Firefox:twitch'],
    ['instagram domain', 'Safari', 'Instagram', 'Safari:instagram'],
    ['reddit domain', 'Google Chrome', 'r/programming - Reddit', 'Google Chrome:reddit'],
    ['telegram domain', 'Telegram', 'Telegram (5)', 'Telegram:telegram'],

    // --- generic host extractor ---
    ['generic .com host', 'Google Chrome', 'Dashboard | foo.com', 'Google Chrome:foo'],
    ['generic .io host', 'Google Chrome', 'My App - bar.io', 'Google Chrome:bar'],
    ['generic .tv host beats fallback', 'Firefox', 'Live now on baz.tv', 'Firefox:baz'],

    // --- known domain wins over generic host when both present ---
    ['known domain preferred', 'Google Chrome', 'youtube.com watch', 'Google Chrome:youtube'],

    // --- first-meaningful-word fallback ---
    ['bracketed counter stripped', 'Slack', '(17) general | Acme', 'Slack:general'],
    ['large counter stripped', 'Mail', '(257) Inbox', 'Mail:inbox'],
    ['hash channel prefix stripped', 'Discord', '#☕_общий_чат | Dedus Dev', 'Discord:общий_чат'],
    ['at prefix stripped', 'Twitter', '@someone posted', 'Twitter:someone'],
    ['emoji prefix stripped', 'Notes', '✅ buy milk', 'Notes:buy'],
    ['leading number token skipped', 'Editor', '2026 roadmap', 'Editor:roadmap'],
    ['pure number token skipped to next', 'Editor', '42 99 plan', 'Editor:plan'],

    // --- empty / uninformative → '' ---
    ['null title', 'Google Chrome', null, ''],
    ['empty title', 'Google Chrome', '', ''],
    ['whitespace title', 'Google Chrome', '   ', ''],
    ['only counter', 'Slack', '(17)', ''],
    ['only digits', 'Editor', '2026 42', ''],
    ['only one-char tokens', 'X', 'a b c', ''],
  ];

  for (const [desc, app, title, expected] of cases) {
    it(desc, () => {
      expect(titleSignature(app, title)).toBe(expected);
    });
  }

  it('is deterministic', () => {
    expect(titleSignature('Google Chrome', 'Facebook - feed')).toBe(
      titleSignature('Google Chrome', 'Facebook - feed'),
    );
  });

  it('namespaces by app — same token, different app, different signature', () => {
    expect(titleSignature('Discord', 'general chat')).not.toBe(
      titleSignature('Telegram', 'general chat'),
    );
  });
});
