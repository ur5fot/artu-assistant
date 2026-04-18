import { describe, it, expect } from 'vitest';
import { ButtonStyle } from 'discord.js';
import {
  buildReminderEmbed,
  buildPermissionEmbed,
  buildPlanReviewChunks,
  buildPermissionsListReply,
} from '../embeds.js';

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
