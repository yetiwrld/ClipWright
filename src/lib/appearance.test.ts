import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAppearance, getAccentPalette } from './appearance';

const styles = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((channel) => parseInt(channel, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function themeTokens(theme: 'dark' | 'light') {
  const match = theme === 'dark'
    ? tokens.match(/:root\s*\{([^}]*)\}/)
    : tokens.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/);
  if (!match) throw new Error(`Missing ${theme} theme tokens`);
  const values = Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[\da-fA-F]{6})\s*;/g)].map((entry) => [entry[1], entry[2] as string]));
  return (name: string) => {
    const value = values[name];
    if (!value) throw new Error(`Missing --${name} for ${theme} theme`);
    return value;
  };
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
    expect(styles).toContain('rgba(var(--accent-rgb), .32)');
    expect(styles).toContain('var(--accent-border)');
    expect(styles).toContain('calc(100vw / var(--ui-scale, 1))');
    expect(styles).toContain('@container app-shell');
    expect(styles).toContain('prefers-reduced-motion: reduce');
    expect(styles).not.toMatch(/rgba\(\s*255\s*,\s*116\s*,\s*24/);
    expect(styles).not.toContain('#ffe1ce');
  });

  it('keeps semantic text readable on every solid application surface in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const value = themeTokens(theme);
      const surfaces = ['bg-app', 'bg-rail', 'bg-panel', 'bg-elevated', 'bg-hover', 'bg-input'].map(value);
      for (const name of ['text-primary', 'text-secondary', 'text-muted']) {
        for (const surface of surfaces) expect(contrast(value(name), surface), `${theme} --${name}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of surfaces) expect(contrast(value('text-disabled'), surface), `${theme} disabled text`).toBeGreaterThanOrEqual(3);
      for (const status of ['success', 'warning', 'error', 'info']) {
        for (const surface of surfaces) expect(contrast(value(status), surface), `${theme} --${status}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of surfaces) expect(contrast(value('focus'), surface), `${theme} focus ring`).toBeGreaterThanOrEqual(3);
    }
  });

  it('uses readable minimum sizes for labels and controls throughout the application', () => {
    expect(tokens).toContain('--font-xs: 12px');
    expect(tokens).toContain('--font-sm: 13px');
    expect(tokens).toContain('--font-md: 14px');
    expect(tokens).toContain('--font-base: 15px');
    expect(tokens).toContain('--font-weight-regular: 400');
    expect(tokens).toContain('--font-weight-medium: 500');
    expect(tokens).toContain('--font-weight-semibold: 600');
    expect(tokens).toContain('--font-weight-bold: 700');
    expect(tokens).toContain('--font-weight-extrabold: 800');
    expect(tokens).toContain('--line-height-tight: 1.2');
    expect(tokens).toContain('--line-height-ui: 1.35');
    expect(tokens).toContain('--line-height-normal: 1.5');
    expect(tokens).toContain('--line-height-reading: 1.55');
    expect(styles).not.toMatch(/font-weight:\s*\d+/);
    expect(styles).not.toMatch(/line-height:\s*1\.\d+/);
    expect(styles).not.toMatch(/font-size:\s*(?:0|[1-9]|1[01])(?:\.\d+)?px\b/);
    expect(styles).not.toMatch(/font:\s*(?:0|[1-9]|1[01])(?:\.\d+)?px\b/);
  });

  it('provides theme-aware colors for all accent choices with readable primary-button text', () => {
    for (const theme of ['dark', 'light'] as const) {
      const value = themeTokens(theme);
      const surfaces = ['bg-app', 'bg-rail', 'bg-panel', 'bg-elevated', 'bg-hover', 'bg-input'].map(value);
      for (const accent of ['orange', 'blue', 'violet'] as const) {
        const palette = getAccentPalette(theme, accent);
        expect(palette.rgb).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
        expect(contrast(palette.accent, palette.ink)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.hover, palette.ink), `${theme} ${accent} hover button`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(value('text-primary'), palette.selected), `${theme} ${accent} selected surface`).toBeGreaterThanOrEqual(4.5);
        for (const surface of surfaces) expect(contrast(palette.accent, surface), `${theme} ${accent} accent`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
