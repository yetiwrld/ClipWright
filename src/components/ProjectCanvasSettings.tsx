import { aspectRatioOf } from '../lib/aspectRatio';
import type { Sequence } from '../lib/projectDocument';

type ProjectCanvasSettingsProps = {
  sequence: Sequence;
  onApply: (width: number, height: number, fit: NonNullable<Sequence['canvasFit']>, background: string) => void;
  idPrefix?: string;
};

const CANVAS_PRESETS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '4:5': { width: 1080, height: 1350 },
  '5:4': { width: 1350, height: 1080 },
  '21:9': { width: 2520, height: 1080 },
};

export default function ProjectCanvasSettings({ sequence, onApply, idPrefix = 'property-canvas' }: ProjectCanvasSettingsProps) {
  const fit = sequence.canvasFit ?? 'fit';
  const background = sequence.canvasBackground ?? '#000000';
  const ratio = aspectRatioOf(sequence.width, sequence.height);
  return <section className="property-section project-canvas-settings" aria-labelledby={`${idPrefix}-title`}>
    <span className="panel-kicker">PROJECT CANVAS</span>
    <strong id={`${idPrefix}-title`}>{sequence.width} × {sequence.height} px · {ratio}</strong>
    <label className="canvas-setting-label" htmlFor={`${idPrefix}-aspect-preset`}>Aspect ratio preset</label>
    <select id={`${idPrefix}-aspect-preset`} className="select-input" value={CANVAS_PRESETS[ratio] ? ratio : 'custom'} onChange={(event) => {
      const preset = CANVAS_PRESETS[event.target.value];
      if (preset) onApply(preset.width, preset.height, fit, background);
    }}>
      <option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option><option value="1:1">Square · 1:1</option>
      <option value="4:3">Classic · 4:3</option><option value="3:4">Portrait · 3:4</option><option value="4:5">Social · 4:5</option>
      <option value="5:4">Classic · 5:4</option><option value="21:9">Ultrawide · 21:9</option><option value="custom">Custom dimensions</option>
    </select>
    <form key={`${sequence.id}:${sequence.width}x${sequence.height}:${fit}:${background}`} className="canvas-settings-form" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      onApply(Number(data.get('width')), Number(data.get('height')), String(data.get('fit')) as NonNullable<Sequence['canvasFit']>, String(data.get('background')));
    }}>
      <div className="canvas-dimension-row"><div><label htmlFor={`${idPrefix}-width`}>Width</label><input id={`${idPrefix}-width`} name="width" type="number" min="16" max="16384" step="1" defaultValue={sequence.width} required /></div><span aria-hidden="true">×</span><div><label htmlFor={`${idPrefix}-height`}>Height</label><input id={`${idPrefix}-height`} name="height" type="number" min="16" max="16384" step="1" defaultValue={sequence.height} required /></div></div>
      <label className="canvas-setting-label" htmlFor={`${idPrefix}-fit`}>Source composition</label>
      <select id={`${idPrefix}-fit`} name="fit" className="select-input" defaultValue={fit}><option value="fit">Fit · preserve full image</option><option value="fill">Fill · crop edges</option><option value="stretch">Stretch · distort to canvas</option></select>
      <label className="canvas-setting-label" htmlFor={`${idPrefix}-background`}>Canvas background</label><input id={`${idPrefix}-background`} name="background" type="color" defaultValue={background} />
      <button className="button button-secondary button-small" type="submit">Apply canvas settings</button>
    </form>
    <small>These saved dimensions and composition are shared by the preview and both export formats. H.264/AVC requires even pixel dimensions; no automatic resizing is applied.</small>
  </section>;
}
