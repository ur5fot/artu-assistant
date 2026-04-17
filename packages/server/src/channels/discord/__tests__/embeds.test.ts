import { describe, it, expect } from 'vitest';
import { ButtonStyle } from 'discord.js';
import { buildReminderEmbed, buildPermissionEmbed } from '../embeds.js';

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
