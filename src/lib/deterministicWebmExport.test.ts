import { describe, expect, it, vi } from 'vitest';
import { areExportFrameCountsExact, createSequenceExportPlan, frameCountForEndTime, runExactFramePipeline } from './deterministicWebmExport';

describe('deterministic sequence export plan', () => {
  it('plans exact 30 fps and 60 fps sequences from sequence frame counts', () => {
    const at30 = createSequenceExportPlan(90, { numerator: 30, denominator: 1 });
    const at60 = createSequenceExportPlan(180, { numerator: 60, denominator: 1 });
    expect(at30.durationSeconds).toBe(3);
    expect(at30.timestampMicroseconds(89)).toBe(Math.round(89 * 1_000_000 / 30));
    expect(at30.timestampSeconds(89)).toBe(at30.timestampMicroseconds(89) / 1_000_000);
    expect(at60.durationSeconds).toBe(3);
    expect(at60.timestampMicroseconds(179)).toBe(Math.round(179 * 1_000_000 / 60));
  });

  it('rounds a non-frame-aligned endpoint up using the timeline end-exclusive convention', () => {
    expect(frameCountForEndTime(22.21, { numerator: 30, denominator: 1 })).toBe(667);
    expect(frameCountForEndTime(10, { numerator: 30, denominator: 1 })).toBe(300);
    expect(createSequenceExportPlan(667, { numerator: 30, denominator: 1 }).durationSeconds).toBeCloseTo(22.2333333333, 10);
  });

  it('derives fractional-rate timestamps and durations from rounded integer frame boundaries', () => {
    const frameRate = { numerator: 30_000, denominator: 1_001 };
    const plan = createSequenceExportPlan(30_000, frameRate);
    expect(plan.frameRate).toEqual(frameRate);
    expect(plan.timestampMicroseconds(1)).toBe(Math.round(1_001 * 1_000_000 / 30_000));
    expect(plan.timestampMicroseconds(29_999)).toBe(Math.round(29_999 * 1_001 * 1_000_000 / 30_000));
    expect(plan.timestampSeconds(29_999)).toBe(plan.timestampMicroseconds(29_999) / 1_000_000);
    expect(plan.durationSeconds).toBe(30_000 * (1_001 / 30_000));
    expect(plan.frameDurationAt(0)).toBe((plan.timestampMicroseconds(1) - plan.timestampMicroseconds(0)) / 1_000_000);
    expect(plan.frameDurationAt(1)).toBe((plan.timestampMicroseconds(2) - plan.timestampMicroseconds(1)) / 1_000_000);
    expect(plan.frameDurationAt(0) + plan.frameDurationAt(1)).toBe(plan.timestampSeconds(2));
  });

  it('keeps all supported integer and fractional rates monotonic for at least 60 seconds', () => {
    const rates = [
      { numerator: 24, denominator: 1 }, { numerator: 25, denominator: 1 },
      { numerator: 30, denominator: 1 }, { numerator: 50, denominator: 1 },
      { numerator: 60, denominator: 1 }, { numerator: 24_000, denominator: 1_001 },
      { numerator: 30_000, denominator: 1_001 }, { numerator: 60_000, denominator: 1_001 },
    ];
    for (const frameRate of rates) {
      const frameCount = Math.ceil(60 * frameRate.numerator / frameRate.denominator);
      const plan = createSequenceExportPlan(frameCount, frameRate);
      expect(plan.frameRate).toEqual(frameRate);
      expect(plan.durationSeconds).toBeGreaterThanOrEqual(60);
      expect(plan.timestampMicroseconds(0)).toBe(0);
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        expect(plan.timestampMicroseconds(frameIndex)).toBe(Math.round(frameIndex * frameRate.denominator * 1_000_000 / frameRate.numerator));
        expect(plan.frameDurationAt(frameIndex)).toBeGreaterThan(0);
        if (frameIndex > 0) expect(plan.timestampMicroseconds(frameIndex)).toBeGreaterThan(plan.timestampMicroseconds(frameIndex - 1));
      }
    }
  });

  it('uses one endpoint rule immediately before, at, and after a rational frame boundary', () => {
    const frameRate = { numerator: 30_000, denominator: 1_001 };
    const boundary = 10 * frameRate.denominator / frameRate.numerator;
    expect(frameCountForEndTime(boundary - 1e-8, frameRate)).toBe(10);
    expect(frameCountForEndTime(boundary, frameRate)).toBe(10);
    expect(frameCountForEndTime(boundary + 1e-8, frameRate)).toBe(11);
  });
});

describe('frame-index export loop', () => {
  it('requires requested, rendered, submitted, encoded, and parsed file counts to match exactly', () => {
    expect(areExportFrameCountsExact(30, { requested: 30, rendered: 30, submitted: 30, encoded: 30, outputFile: 30 })).toBe(true);
    for (const stage of ['requested', 'rendered', 'submitted', 'encoded', 'outputFile'] as const) {
      const counts = { requested: 30, rendered: 30, submitted: 30, encoded: 30, outputFile: 30 };
      counts[stage] = 29;
      expect(areExportFrameCountsExact(30, counts)).toBe(false);
    }
  });
  it('renders and submits every frame in order despite slow rendering and encoder backpressure', async () => {
    const plan = createSequenceExportPlan(12, { numerator: 30, denominator: 1 });
    const renders: number[] = [];
    const submitted: Array<{ index: number; timestamp: number; duration: number }> = [];
    let renderInFlight = 0;
    let maxRenderInFlight = 0;
    let submitInFlight = 0;
    const counts = await runExactFramePipeline(
      plan,
      async (index) => {
        renderInFlight += 1;
        maxRenderInFlight = Math.max(maxRenderInFlight, renderInFlight);
        await new Promise((resolve) => setTimeout(resolve, 3));
        renders.push(index);
        renderInFlight -= 1;
      },
      async (index, timestamp, duration) => {
        submitInFlight += 1;
        expect(submitInFlight).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 2));
        submitted.push({ index, timestamp, duration });
        submitInFlight -= 1;
      },
    );
    expect(renders).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(submitted.map(({ index }) => index)).toEqual(renders);
    expect(submitted.map(({ timestamp }) => timestamp)).toEqual(renders.map((index) => plan.timestampSeconds(index)));
    expect(submitted.map(({ duration }) => duration)).toEqual(renders.map((index) => plan.frameDurationAt(index)));
    expect(maxRenderInFlight).toBe(1);
    expect(counts).toEqual({ requested: 12, rendered: 12, submitted: 12 });
  });

  it('is independent of high-refresh callback bursts and emits no frame after finalization', async () => {
    const plan = createSequenceExportPlan(4, { numerator: 30, denominator: 1 });
    const rapidCallbacks = Array.from({ length: 30 }, (_, index) => index);
    const captured: number[] = [];
    // The renderer is invoked by the sequence-index loop, never by these display callbacks.
    const render = vi.fn(async (index: number) => { captured.push(index); });
    for (const _callback of rapidCallbacks) void _callback;
    await runExactFramePipeline(plan, render, async () => undefined);
    expect(render).toHaveBeenCalledTimes(4);
    expect(captured).toEqual([0, 1, 2, 3]);
  });

  it('aborts cleanly without submitting an unrendered or extra frame', async () => {
    const controller = new AbortController();
    const plan = createSequenceExportPlan(5, { numerator: 30, denominator: 1 });
    const rendered: number[] = [];
    const submitted: number[] = [];
    await expect(runExactFramePipeline(
      plan,
      async (index) => { rendered.push(index); if (index === 1) controller.abort(); },
      async (index) => { submitted.push(index); },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(rendered).toEqual([0, 1]);
    expect(submitted).toEqual([0]);
  });
});
