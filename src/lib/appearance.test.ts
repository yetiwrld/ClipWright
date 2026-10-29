import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAppearance, getAccentPalette } from './appearance';

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((channel) => parseInt(channel, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('appearance preferences', () => {
  it('keeps the interface scale fitted to the viewport instead of zooming the document root', () => {
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        removeProperty: (name: string) => properties.delete(name),
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;
    for (const scale of [90, 100, 110, 125] as const) {
      applyAppearance(root, 'dark', 'orange', scale);
      expect(root.dataset.uiScale).toBe(String(scale));
      expect(properties.get('--ui-scale')).toBe(String(scale / 100));
      expect(properties.has('zoom')).toBe(false);
    }
  });

  it('uses accent tokens for the timeline and selected navigation instead of fixed orange styling', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
    expect(styles).toContain('rgba(var(--accent-rgb), .32)');
    expect(styles).toContain('var(--accent-border)');
    expect(styles).toContain('calc(100vw / var(--ui-scale, 1))');
    expect(styles).toContain('@container app-shell');
    expect(styles).toContain('prefers-reduced-motion: reduce');
    expect(styles).not.toMatch(/rgba\(\s*255\s*,\s*116\s*,\s*24/);
    expect(styles).not.toContain('#ffe1ce');
  });

  it('provides theme-aware colors for all accent choices with readable primary-button text', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const accent of ['orange', 'blue', 'violet'] as const) {
        const palette = getAccentPalette(theme, accent);
        expect(palette.rgb).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
        expect(contrast(palette.accent, palette.ink)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
