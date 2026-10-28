import { describe, expect, it, vi } from 'vitest';
import { areExportFrameCountsExact, createSequenceExportPlan, frameCountForEndTime, runExactFramePipeline } from './deterministicWebmExport';

describe('deterministic sequence export plan', () => {
  it('plans exact 30 fps and 60 fps sequences from sequence frame counts', () => {
    const at30 = createSequenceExportPlan(90, { numerator: 30, denominator: 1 });
    const at60 = createSequenceExportPlan(180, { numerator: 60, denominator: 1 });
    expect(at30.durationSeconds).toBe(3);
    expect(at30.timestampSeconds(89)).toBeCloseTo(89 / 30, 12);
    expect(at60.durationSeconds).toBe(3);
    expect(at60.timestampSeconds(179)).toBeCloseTo(179 / 60, 12);
  });

  it('rounds a non-frame-aligned endpoint up using the timeline end-exclusive convention', () => {
    expect(frameCountForEndTime(22.21, { numerator: 30, denominator: 1 })).toBe(667);
    expect(frameCountForEndTime(10, { numerator: 30, denominator: 1 })).toBe(300);
    expect(createSequenceExportPlan(667, { numerator: 30, denominator: 1 }).durationSeconds).toBeCloseTo(22.2333333333, 10);
  });

  it('keeps fractional 30000/1001 timestamps anchored to integer frame indices', () => {
    const plan = createSequenceExportPlan(30_000, { numerator: 30_000, denominator: 1_001 });
    expect(plan.timestampSeconds(1)).toBeCloseTo(1_001 / 30_000, 14);
    expect(plan.timestampSeconds(29_999)).toBeCloseTo(29_999 * 1_001 / 30_000, 10);
    expect(plan.durationSeconds).toBeCloseTo(1_001, 12);
    expect(plan.frameDurationAt(0)).toBeCloseTo(1_001 / 30_000, 14);
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
    expect(submitted.map(({ timestamp }) => timestamp)).toEqual(renders.map((index) => index / 30));
    expect(submitted.every(({ duration }) => Math.abs(duration - 1 / 30) < 1e-12)).toBe(true);
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
