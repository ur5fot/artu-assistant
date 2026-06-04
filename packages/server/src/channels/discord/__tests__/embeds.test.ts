import { describe, it, expect } from 'vitest';
import { ButtonStyle } from 'discord.js';
import {
  buildReminderEmbed,
  buildPermissionEmbed,
  buildPlanReviewChunks,
  buildPermissionsListReply,
  buildUrgentEmailEmbed,
  buildPendingActionsComponents,
} from '../embeds.js';
import type { EmailPendingRow } from '../../../emails/types.js';
import type { OpenAction } from '../../../topics/store.js';

function mkAction(overrides: Partial<OpenAction> = {}): OpenAction {
  return {
    topicId: 1,
    label: 'GitHub access',
    action: 'confirm GitHub permissions',
    url: null,
    ...overrides,
  };
}

function mkRow(overrides: Partial<EmailPendingRow> = {}): EmailPendingRow {
  return {
    id: 7,
    account_id: 'a',
    message_uid: 1,
    from_addr: 'sender@example.com',
    subject: 'subject',
    snippet: 'snip',
    importance: 5,
    received_at: 1000,
    added_at: 1000,
    delivered_at: null,
    urgent_pinged_at: null,
    ...overrides,
  };
}

describe('buildReminderEmbed', () => {
  it('ringing state: includes title, footer, dismiss and snooze buttons', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'ringing',
    });

    const embedJson = embed.toJSON();
    expect(embedJson.title).toBe('⏰ Buy milk');
    expect(embedJson.footer?.text).toBe('now ringing');

    const row = components[0]!.toJSON();
    const buttons = row.components as any[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].custom_id).toBe('reminder:dismiss:7');
    expect(buttons[0].style).toBe(ButtonStyle.Success);
    expect(buttons[1].custom_id).toBe('reminder:snooze:7');
  });

  it('dismissed state: no buttons, footer shows dismissed', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'dismissed',
    });
    expect(embed.toJSON().footer?.text).toBe('✓ Dismissed');
    expect(components).toEqual([]);
  });

  it('snoozed state: no buttons, footer shows snoozed', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'snoozed',
    });
    expect(embed.toJSON().footer?.text).toBe('😴 Snoozed 10m');
    expect(components).toEqual([]);
  });

  it('missed state: no buttons, footer shows missed', () => {
    const { embed, components } = buildReminderEmbed({
      id: 7,
      text: 'Buy milk',
      state: 'missed',
    });
    expect(embed.toJSON().footer?.text).toBe('⏰ missed');
    expect(components).toEqual([]);
  });
});

describe('buildPermissionEmbed', () => {
  it('pending: embed with allow_once / allow_always / deny buttons', () => {
    const { embed, components } = buildPermissionEmbed({
      callId: 'abc-123',
      toolName: 'files.write',
      argsSummary: 'path: /tmp/x.txt',
      state: 'pending',
    });
    const e = embed.toJSON();
    expect(e.title).toContain('Permission request');
    expect(e.description).toContain('files.write');
    expect(e.description).toContain('path: /tmp/x.txt');
    const buttons = (components[0]!.toJSON().components as any[]);
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'perm:allow_once:abc-123',
      'perm:allow_always:abc-123',
      'perm:deny:abc-123',
    ]);
    expect(buttons[0].style).toBe(ButtonStyle.Success);
    expect(buttons[2].style).toBe(ButtonStyle.Danger);
  });

  it('resolved state: no buttons, footer reflects decision', () => {
    const { components, embed } = buildPermissionEmbed({
      callId: 'abc-123',
      toolName: 'files.write',
      argsSummary: 'path: /tmp/x.txt',
      state: 'allowed_once',
    });
    expect(components).toEqual([]);
    expect(embed.toJSON().footer?.text).toBe('✓ Allowed once');
  });

  it('expired state: no buttons, footer "expired"', () => {
    const { components, embed } = buildPermissionEmbed({
      callId: 'abc-123',
      toolName: 'files.write',
      argsSummary: 'x',
      state: 'expired',
    });
    expect(components).toEqual([]);
    expect(embed.toJSON().footer?.text).toBe('⚠️ expired');
  });
});

describe('buildPlanReviewChunks', () => {
  it('small plan: one message with header, one message with buttons', () => {
    const chunks = buildPlanReviewChunks({
      callId: 'p1',
      plan: 'step 1\nstep 2\nstep 3',
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toContain('📋 Plan review (1/1)');
    expect(chunks[0].content).toContain('step 1');
    expect(chunks[0].components).toEqual([]);
    const lastRow = chunks[1].components![0]!.toJSON();
    const buttons = lastRow.components as any[];
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'plan:approve:p1',
      'plan:reject:p1',
    ]);
  });

  it('large plan: splits into multiple chunks, header shows (N/N)', () => {
    const hugeLine = 'x'.repeat(100);
    const lines = Array.from({ length: 50 }, (_, i) => `${i}: ${hugeLine}`).join('\n');
    const chunks = buildPlanReviewChunks({ callId: 'p1', plan: lines });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].content).toMatch(/^📋 Plan review \(1\/\d+\)/);
    // No split inside a code fence
    for (const c of chunks.slice(0, -1)) {
      const opens = (c.content!.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('plan over 20-chunk cap: last content chunk shows truncated warning', () => {
    const giant = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n');
    const chunks = buildPlanReviewChunks({ callId: 'p1', plan: giant });
    expect(chunks.length).toBeLessThanOrEqual(21); // 20 content + 1 buttons
    const truncContent = chunks[chunks.length - 2]!.content!;
    expect(truncContent).toContain('⚠️ plan truncated');
  });
});

describe('buildPermissionsListReply', () => {
  it('empty list: content is "No saved permission rules." and no components', () => {
    const reply = buildPermissionsListReply([]);
    expect(reply.content).toBe('No saved permission rules.');
    expect(reply.components).toEqual([]);
    expect(reply.embeds).toEqual([]);
  });

  it('rules list: embed + one button row per rule', () => {
    const reply = buildPermissionsListReply([
      { toolName: 'files_write', allowed: true },
      { toolName: 'code_deploy', allowed: false },
    ]);
    expect(reply.content).toBe('');
    expect(reply.embeds).toHaveLength(1);
    const embedJson = reply.embeds![0]!.toJSON();
    expect(embedJson.title).toBe('📋 Saved permission rules');
    expect(embedJson.description).toContain('files_write');
    expect(embedJson.description).toContain('code_deploy');
    // denied markers
    expect(embedJson.description).toContain('❌');
    expect(embedJson.description).toContain('✅');
    expect(reply.components).toHaveLength(2);
    const customIds = reply.components!.flatMap((row: any) =>
      (row.toJSON().components as any[]).map((c) => c.custom_id),
    );
    expect(customIds).toEqual([
      'perm_rule:revoke:files_write',
      'perm_rule:revoke:code_deploy',
    ]);
  });

  it('more than 5 rules: only 5 button rows, embed footer notes truncation', () => {
    const rules = Array.from({ length: 8 }, (_, i) => ({
      toolName: `tool_${i}`,
      allowed: true,
    }));
    const reply = buildPermissionsListReply(rules);
    expect(reply.components).toHaveLength(5);
    const embedJson = reply.embeds![0]!.toJSON();
    expect(embedJson.footer?.text).toContain('Showing 5 of 8');
  });
});

describe('buildUrgentEmailEmbed', () => {
  it('returns plain data: title, fields (from/subject/snippet), draft+sender+subject buttons', () => {
    const { embed, components } = buildUrgentEmailEmbed(
      mkRow({
        id: 42,
        from_addr: 'boss@acme.com',
        subject: 'Server down',
        snippet: 'Prod is on fire',
      }),
    );
    expect(embed.title).toBe('🚨 Urgent email');
    expect(embed.fields).toEqual([
      { name: 'From', value: 'boss@acme.com' },
      { name: 'Subject', value: 'Server down' },
      { name: 'Snippet', value: 'Prod is on fire' },
    ]);
    expect(components).toHaveLength(1);
    expect(components[0]!.type).toBe('row');
    expect(components[0]!.buttons).toHaveLength(3);
    expect(components[0]!.buttons[0]!).toEqual({
      customId: 'email_draft:start:42',
      label: 'Draft reply',
      style: 'primary',
    });
    expect(components[0]!.buttons[1]!).toEqual({
      customId: 'email_suppress:sender_start:42',
      label: '🙈 Sender',
      style: 'secondary',
    });
    expect(components[0]!.buttons[2]!).toEqual({
      customId: 'email_suppress:subject_start:42',
      label: '🙈 Subject',
      style: 'secondary',
    });
  });

  it('button customId encodes the email_pending row id', () => {
    const { components } = buildUrgentEmailEmbed(mkRow({ id: 1337 }));
    expect(components[0]!.buttons[0]!.customId).toBe('email_draft:start:1337');
    expect(components[0]!.buttons[1]!.customId).toBe('email_suppress:sender_start:1337');
    expect(components[0]!.buttons[2]!.customId).toBe('email_suppress:subject_start:1337');
  });

  it('collapses internal whitespace in from/subject/snippet', () => {
    const { embed } = buildUrgentEmailEmbed(
      mkRow({
        from_addr: 'Boss\nBoss\t<boss@acme.com>',
        subject: 'line1\nline2\t  end',
        snippet: '  one\n\ntwo\rthree  ',
      }),
    );
    const fields = embed.fields!;
    expect(fields.find((f) => f.name === 'From')!.value).toBe('Boss Boss <boss@acme.com>');
    expect(fields.find((f) => f.name === 'Subject')!.value).toBe('line1 line2 end');
    expect(fields.find((f) => f.name === 'Snippet')!.value).toBe('one two three');
  });

  it('truncates snippet > 200 chars with ellipsis', () => {
    const long = 'a'.repeat(250);
    const { embed } = buildUrgentEmailEmbed(mkRow({ snippet: long }));
    const snippet = embed.fields!.find((f) => f.name === 'Snippet')!.value;
    expect(snippet.length).toBe(200);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('omits Snippet field when snippet is empty', () => {
    const { embed } = buildUrgentEmailEmbed(mkRow({ snippet: '' }));
    expect(embed.fields!.find((f) => f.name === 'Snippet')).toBeUndefined();
    expect(embed.fields!.map((f) => f.name)).toEqual(['From', 'Subject']);
  });

  it('falls back to "(no subject)" when subject is empty', () => {
    const { embed } = buildUrgentEmailEmbed(mkRow({ subject: '' }));
    expect(embed.fields!.find((f) => f.name === 'Subject')!.value).toBe('(no subject)');
  });
});

describe('buildPendingActionsComponents', () => {
  it('returns no components when there are no open actions', () => {
    expect(buildPendingActionsComponents([])).toEqual([]);
  });

  it('builds one success "✓ Готово" button per action with followup:done customId', () => {
    const components = buildPendingActionsComponents([
      mkAction({ topicId: 14, action: 'confirm GitHub permissions' }),
      mkAction({ topicId: 22, action: 'pay invoice' }),
    ]);
    expect(components).toHaveLength(1);
    const row = components[0];
    expect(row.type).toBe('row');
    expect(row.buttons).toHaveLength(2);
    expect(row.buttons[0]).toEqual({
      customId: 'followup:done:14',
      label: '✓ confirm GitHub permissions',
      style: 'success',
    });
    expect(row.buttons[1].customId).toBe('followup:done:22');
    expect(row.buttons[1].label).toBe('✓ pay invoice');
  });

  it('caps at 5 buttons even when more actions are open', () => {
    const actions = Array.from({ length: 8 }, (_, i) => mkAction({ topicId: i + 1 }));
    const components = buildPendingActionsComponents(actions);
    expect(components[0].buttons).toHaveLength(5);
    expect(components[0].buttons.map((b) => b.customId)).toEqual([
      'followup:done:1',
      'followup:done:2',
      'followup:done:3',
      'followup:done:4',
      'followup:done:5',
    ]);
  });

  it('keeps the button label within Discord\'s 80-char cap', () => {
    const long = 'x'.repeat(200);
    const [row] = buildPendingActionsComponents([mkAction({ action: long })]);
    expect(row.buttons[0].label.length).toBeLessThanOrEqual(80);
    expect(row.buttons[0].label.endsWith('…')).toBe(true);
  });
});
