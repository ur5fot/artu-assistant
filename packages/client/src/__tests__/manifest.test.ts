import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('PWA manifest', () => {
  const manifestPath = resolve(__dirname, '..', '..', 'public', 'manifest.webmanifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  it('has required top-level fields', () => {
    expect(manifest.name).toBe('R2');
    expect(manifest.short_name).toBe('R2');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('includes 192 and 512 icons plus a maskable variant', () => {
    const icons = manifest.icons as Array<{ sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});
