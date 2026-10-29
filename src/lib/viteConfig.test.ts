// @vitest-environment node
import { describe, expect, it } from 'vitest';
import defaultConfig, { developmentHeaders } from '../../vite.config';
import lanConfig from '../../vite.lan.config';

describe('Vite development exposure defaults', () => {
  it('binds normal dev and preview servers to loopback with a restricted HMR CSP', () => {
    expect(defaultConfig.server?.host).toBe('127.0.0.1');
    expect(defaultConfig.server?.allowedHosts).not.toBe(true);
    expect(defaultConfig.preview?.host).toBe('127.0.0.1');
    const policy = developmentHeaders['Content-Security-Policy'];
    expect(policy).toContain('ws://127.0.0.1:5173');
    expect(policy).toContain('ws://127.0.0.1:5174');
    expect(policy).not.toMatch(/\bwss:\s*(?:;|,|$)/);
  });

  it('keeps the hosted preview opt-in and limited to its explicit host suffix', () => {
    expect(lanConfig.server?.host).toBe('0.0.0.0');
    expect(lanConfig.server?.allowedHosts).toContain('.e2b.app');
  });
});
