import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createProject, PROJECTS_KEY, writeProjects } from './lib/projects';
import { createProjectDocument, PROJECT_DOCUMENTS_KEY, serializeProjectDocument, writeProjectDocuments } from './lib/projectDocument';
import type { ProjectDocument } from './lib/projectDocument';
import * as browserMedia from './lib/browserMedia';

beforeEach(() => {
  window.localStorage.clear();
  let uuid = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `project-test-id-${++uuid}` });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  delete (window as Window & { clipwright?: unknown }).clipwright;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installExportMocks() {
  class FakeTrack {
    stop = vi.fn();
    requestFrame = vi.fn();
    constructor(public kind: 'audio' | 'video') {}
  }
  class FakeStream {
    tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) { this.tracks = [...tracks]; }
    addTrack(track: FakeTrack) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  }
  class FakeRecorder {
    static isTypeSupported = vi.fn(() => true);
    static lastInstance: FakeRecorder | null = null;
    static lastOptions: MediaRecorderOptions | undefined;
    state: RecordingState = 'inactive';
    mimeType = 'video/webm;codecs=vp8,opus';
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    constructor(_stream: FakeStream, options?: MediaRecorderOptions) { FakeRecorder.lastInstance = this; FakeRecorder.lastOptions = options; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['webm bytes']) } as BlobEvent);
      this.onstop?.(new Event('stop'));
    }
  }
  class FakeAudioContext {
    static gainNodes: { gain: { value: number }; connect: ReturnType<typeof vi.fn> }[] = [];
    static pannerNodes: { pan: { value: number }; connect: ReturnType<typeof vi.fn> }[] = [];
    state = 'running';
    destination = {};
    createMediaStreamDestination() { return { stream: new FakeStream([new FakeTrack('audio')]) }; }
    createMediaElementSource() { return { connect: vi.fn() }; }
    createGain() { const node = { gain: { value: 1 }, connect: vi.fn() }; FakeAudioContext.gainNodes.push(node); return node; }
    createStereoPanner() { const node = { pan: { value: 0 }, connect: vi.fn() }; FakeAudioContext.pannerNodes.push(node); return node; }
    decodeAudioData() { return Promise.resolve({ duration: 10, numberOfChannels: 1, getChannelData: () => new Float32Array([0.1, -0.6, 0.25, 0.8]) } as unknown as AudioBuffer); }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  FakeAudioContext.gainNodes = [];
  FakeAudioContext.pannerNodes = [];
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  const canvasTrack = new FakeTrack('video');
  const captureCanvas = vi.fn((_frameRate: number) => new FakeStream([canvasTrack]));
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: captureCanvas });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const createObjectURL = vi.fn(() => 'blob:clipwright-export');
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
  let downloadedName = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadedName = this.download; });
  return {
    canvasTrack, captureCanvas, callbacks, createObjectURL,
    get recorderOptions() { return FakeRecorder.lastOptions; },
    get audioGainValues() { return FakeAudioContext.gainNodes.map((node) => node.gain.value); },
    get audioPanValues() { return FakeAudioContext.pannerNodes.map((node) => node.pan.value); },
    failRecording: () => FakeRecorder.lastInstance?.onerror?.(new Event('error')),
    get downloadedName() { return downloadedName; },
  };
}

describe('ClipWright foundation UI', () => {
  it('creates and persists a project before opening the editor workspace', async () => {
    const { container } = render(<App />);
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe('#main-content');
    expect(container.querySelector('#main-content')).toBeTruthy();
    window.localStorage.setItem('clipwright.workspace.timeline-height', '296');
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Interview cut' } });
    fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: '9:16' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByText('Interview cut')).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem(PROJECTS_KEY)).toContain('Interview cut'));
    expect(window.localStorage.getItem('clipwright.onboarding.completed.v1')).toBe('true');
    expect(window.localStorage.getItem(PROJECTS_KEY)).toContain('9:16');
    await waitFor(() => expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).toContain('"schemaVersion":2'));
    const savedDocuments = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(savedDocuments[0].sequences[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(savedDocuments[0].sequences[0].tracks).toHaveLength(2);
    expect(screen.getByText(/1080 × 1920 px · 9:16/)).toBeTruthy();
    expect(screen.getByText('Add media to the timeline to preview')).toBeTruthy();
    expect([...container.querySelectorAll('.editor-layout > *')].map((element) => element.className)).toEqual([
      'editor-main-row',
      'timeline-resize-handle',
      'timeline-panel',
    ]);
    expect([...container.querySelectorAll('.editor-main-row > *')].map((element) => element.className)).toEqual([
      'editor-media-panel',
      'panel-resize-handle',
      'editor-center',
      'panel-resize-handle',
      'properties-panel',
    ]);
    expect([...container.querySelectorAll('.editor-center > *')].map((element) => element.className)).toEqual([
      'preview-stage',
      'preview-controls',
    ]);
    expect(container.querySelector('.content-area-editor')).toBeTruthy();
    const propertiesBody = container.querySelector('.properties-body');
    expect(propertiesBody?.parentElement).toBe(container.querySelector('.properties-panel'));
    expect(propertiesBody?.previousElementSibling?.textContent).toBe('Properties');
    expect(container.querySelector('.timeline-panel')?.parentElement).toBe(container.querySelector('.editor-layout'));
    const timelineResizer = screen.getByRole('separator', { name: 'Resize preview and timeline' });
    const initialPreviewPercent = Number(timelineResizer.getAttribute('aria-valuetext')?.match(/\d+/)?.[0]);
    expect(initialPreviewPercent).toBeGreaterThanOrEqual(58);
    expect(initialPreviewPercent).toBeLessThanOrEqual(62);
    expect(window.localStorage.getItem('clipwright.workspace.timeline-layout-v2')).toBe('true');
    expect(container.querySelector('.editor-project-bar')).toBeNull();
    expect(container.querySelector('.workspace-head')).toBeNull();
    expect(container.querySelector('.subtle-back')).toBeNull();
    expect(container.querySelector('.editor-meta-badges')?.textContent).toContain('9:16');
    expect(container.querySelector('.editor-meta-badges')?.textContent).toContain('30 fps');
    expect(container.querySelector('.editor-meta-badges')?.textContent).toContain('Saved');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const exportResolution = screen.getByRole('combobox', { name: 'Resolution' }) as HTMLSelectElement;
    expect(exportResolution.value).toBe('sequence');
    expect(exportResolution.options[1].textContent).toContain('720p (720 × 1280)');
    fireEvent.change(exportResolution, { target: { value: '360p' } });
    expect(exportResolution.value).toBe('360p');
    expect(container.querySelectorAll('.timeline-note')).toHaveLength(0);
    expect([...container.querySelectorAll('.timeline-grid > *')].map((element) => element.className)).toEqual([
      'timeline-corner',
      'timeline-ruler-viewport',
      'timeline-track-header-column',
      'timeline-track-area',
    ]);
    const timelineScroller = container.querySelector('.timeline-track-area') as HTMLDivElement;
    const trackHeaders = container.querySelector('.timeline-track-header-rows') as HTMLDivElement;
    fireEvent.scroll(timelineScroller, { target: { scrollTop: 42, scrollLeft: 50 } });
    expect(trackHeaders.style.transform).toBe('translateY(-42px)');
    expect(container.querySelector('.timeline-grid')?.getAttribute('style')).toBeNull();
    expect(container.querySelector('.timeline-ruler-viewport')?.getAttribute('aria-label')).toBe('Timeline ruler');
    expect(screen.getByText('00:00:00:00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute Video 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock Video 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Video 1' }));
    expect(container.querySelector('.timeline-track-header-rows .track-row')?.classList.contains('is-track-hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Show Video 1' })).toBeTruthy();
    await waitFor(() => {
      const trackDoc = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0];
      expect(trackDoc.sequences[0].tracks[0]).toMatchObject({ muted: true, locked: true, hidden: true });
    });
    expect(container.querySelector('.timeline-track-header-rows .audio-track .track-header')?.getAttribute('title')?.toLowerCase()).toContain('adjust gain and pan');
    const startingTimelineHeight = Number(timelineResizer.getAttribute('aria-valuenow'));
    fireEvent.keyDown(timelineResizer, { key: 'ArrowDown' });
    expect(Number(timelineResizer.getAttribute('aria-valuenow'))).toBe(startingTimelineHeight - 16);
    expect(window.localStorage.getItem('clipwright.workspace.timeline-height')).toBe(String(startingTimelineHeight - 16));
    const timelineZoom = screen.getByRole('slider', { name: 'Timeline zoom level' });
    fireEvent.change(timelineZoom, { target: { value: '100' } });
    expect(timelineZoom.getAttribute('max')).toBe('100');
    expect(Number(window.localStorage.getItem('clipwright.workspace.timeline-px-per-second'))).toBeGreaterThan(0);
    const majorTicks = [...container.querySelectorAll<HTMLElement>('.timeline-tick.is-major')].map((tick) => Number.parseFloat(tick.style.left));
    expect(majorTicks.length).toBeGreaterThan(1);
    expect(majorTicks.slice(1).every((position, index) => position - majorTicks[index] >= 80)).toBe(true);
    expect(container.querySelector('.timeline-tick.is-minor em')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fit project in timeline' }));
    expect(screen.getByText('100%')).toBeTruthy();
    expect(Number(window.localStorage.getItem('clipwright.workspace.timeline-px-per-second'))).toBeGreaterThan(0);

    const shell = container.querySelector('.app-shell') as HTMLDivElement;
    expect(shell.classList.contains('is-editor-nav-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse media panel' }));
    expect(container.querySelector('.editor-main-row')?.classList.contains('media-panel-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Expand media panel' }));
    expect(container.querySelector('.editor-main-row')?.classList.contains('media-panel-collapsed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
    expect(shell.classList.contains('is-editor-nav-collapsed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(shell.classList.contains('is-editor-nav-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enter focus mode' }));
    expect(shell.classList.contains('is-editor-focus')).toBe(true);
    expect(screen.getByRole('button', { name: 'Exit focus mode' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus mode' }));
    expect(shell.classList.contains('is-editor-focus')).toBe(false);
  });

  it('routes the missing-image banner relink action to the image picker', async () => {
    const project = createProject('Offline still image', '16:9', 30, new Date('2025-01-01T00:00:00.000Z'));
    const projectDocument = createProjectDocument(project, '0.1.0');
    const videoTrack = projectDocument.sequences[0].tracks.find((track) => track.kind === 'video')!;
    projectDocument.assets.push({
      id: 'offline-image-asset', name: 'still.png', sourcePath: 'Media/still.png', pathKind: 'project-relative', kind: 'image',
      streams: {}, imageDimensions: { width: 1600, height: 900 },
    });
    videoTrack.clips.push({ id: 'offline-image-clip', sourceId: 'offline-image-asset', trackId: videoTrack.id, start: 0, trimIn: 0, trimOut: 5 });
    projectDocument.sequences[0].durationFrames = 150;
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [projectDocument]);
    const selectedInputs: string[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      selectedInputs.push(this.getAttribute('aria-label') ?? '');
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: `Open ${project.name}` }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Relink still.png' }));

    expect(selectedInputs).toContain('Choose a local image file');
    expect(selectedInputs).not.toContain('Choose a local video file');
  });

  it('relinks an offline still image in place and keeps the timeline clip attached to the same asset', async () => {
    const project = createProject('Relink still image', '16:9', 30, new Date('2025-01-01T00:00:00.000Z'));
    const projectDocument = createProjectDocument(project, '0.1.0');
    const videoTrack = projectDocument.sequences[0].tracks.find((track) => track.kind === 'video')!;
    projectDocument.assets.push({
      id: 'stable-image-asset', name: 'original.png', sourcePath: 'Media/original.png', pathKind: 'project-relative', kind: 'image',
      streams: {}, fileSizeBytes: 100, fingerprint: 'a'.repeat(64), imageDimensions: { width: 640, height: 360 },
    });
    videoTrack.clips.push({ id: 'stable-image-clip', sourceId: 'stable-image-asset', trackId: videoTrack.id, start: 0, trimIn: 0, trimOut: 5 });
    projectDocument.sequences[0].durationFrames = 150;
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [projectDocument]);
    const bitmap = { width: 1280, height: 720, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:relinked-still'), revokeObjectURL: vi.fn() });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const library = {
      initialize: vi.fn(async () => ({ root: '/local/clipwright', directories: {}, projects: [], issues: [] })),
      saveProject: vi.fn(async (_payload: { contents: string }) => ({ changed: true, recoveryId: null, documentId: project.id, contentHash: 'hash', projectId: project.id })),
      resolveMedia: vi.fn(async () => []),
      importFile: vi.fn(async (_file: File, payload: { projectId: string; assetId: string; mode: string }) => ({
        ...payload, mode: 'managed', name: 'replacement.png', sourcePath: 'Media/replacement.png', pathKind: 'project-relative',
        fileSizeBytes: 200, fingerprint: 'b'.repeat(64), mediaUrl: 'clipwright-media://replacement',
      })),
    };
    Object.defineProperty(window, 'clipwright', { configurable: true, value: { library } });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: `Open ${project.name}` }));
    fireEvent.click(await screen.findByRole('button', { name: /^Relink$/ }));
    const replacement = new File(['replacement image bytes'], 'replacement.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose a local image file'), { target: { files: [replacement] } });

    expect(await screen.findByRole('img', { name: 'Timeline image: replacement.png' })).toBeTruthy();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('original.png'));
    expect(library.importFile).toHaveBeenCalledWith(replacement, { projectId: project.id, assetId: 'stable-image-asset', mode: 'managed' });
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]').find((entry: ProjectDocument) => entry.id === project.id);
      expect(saved.assets).toHaveLength(1);
      expect(saved.assets[0]).toMatchObject({ id: 'stable-image-asset', name: 'replacement.png', fingerprint: 'b'.repeat(64), imageDimensions: { width: 1280, height: 720 } });
      expect(saved.sequences[0].tracks[0].clips[0]).toMatchObject({ id: 'stable-image-clip', sourceId: 'stable-image-asset', trimOut: 5 });
    });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).not.toContain('blob:');
  });

  it('rejects undecodable still images and releases the temporary object URL', async () => {
    const project = createProject('Invalid still image', '16:9', 30, new Date('2025-01-01T00:00:00.000Z'));
    const projectDocument = createProjectDocument(project, '0.1.0');
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [projectDocument]);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed'); }));
    const createObjectURL = vi.fn(() => 'blob:invalid-still');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: `Open ${project.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Import a local image' }));
    fireEvent.change(screen.getByLabelText('Choose a local image file'), { target: { files: [new File(['not an image'], 'broken.png', { type: 'image/png' })] } });

    expect((await screen.findByRole('alert')).textContent).toContain('cannot decode the selected image');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:invalid-still');
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].assets).toHaveLength(0));
  });

  it('imports, previews, places, and duration-edits a still image without embedding its bytes', async () => {
    const project = createProject('Image timeline test', '16:9', 30, new Date('2025-01-01T00:00:00.000Z'));
    const document = createProjectDocument(project, '0.1.0');
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [document]);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1600, height: 900, close: vi.fn() } as unknown as ImageBitmap)));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: `Open ${project.name}` }));
    expect(await screen.findByRole('slider', { name: 'Timeline zoom level' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import a local image' }));
    const imageFile = new File(['local image bytes'], 'still.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose a local image file'), { target: { files: [imageFile] } });
    expect(await screen.findByText('still.png')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add at playhead' }));
    expect(await screen.findByRole('img', { name: 'Timeline image: still.png' })).toBeTruthy();

    const duration = screen.getByLabelText('Clip duration (seconds)');
    fireEvent.change(duration, { target: { value: '3.5' } });
    expect((duration as HTMLInputElement).value).toBe('3.5');
    fireEvent.click(screen.getByRole('button', { name: 'Set duration' }));
    expect(await screen.findByText('Updated still-image duration.')).toBeTruthy();
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0];
      expect(saved.sequences[0].tracks[0].clips[0]).toMatchObject({ sourceId: saved.assets[0].id, trimIn: 0, trimOut: 3.5 });
    });
    fireEvent.change(screen.getByLabelText('Seek timeline'), { target: { value: '3.5' } });
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Timeline image: still.png' })).toBeNull());
    fireEvent.change(screen.getByLabelText('Seek timeline'), { target: { value: '2' } });
    expect(await screen.findByRole('img', { name: 'Timeline image: still.png' })).toBeTruthy();
    expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).not.toContain('blob:');
  });

  it('autosaves only the document that changed in the desktop library', async () => {
    const projects = ['Autosave one', 'Autosave two', 'Autosave three'].map((name) => createProject(name, '16:9', 30, new Date('2025-01-01T00:00:00.000Z')));
    const documents = projects.map((project) => createProjectDocument(project, '0.1.0'));
    writeProjects(window.localStorage, projects);
    writeProjectDocuments(window.localStorage, documents);
    window.localStorage.setItem('clipwright.preferences.v1', JSON.stringify({ storage: { autosaveIntervalSeconds: 1 } }));
    const library = {
      initialize: vi.fn(async () => ({ root: '/local/clipwright', directories: {}, projects: [], issues: [] })),
      saveProject: vi.fn(async (_request: { contents: string }) => ({ changed: true, recoveryId: null, documentId: 'autosave', contentHash: 'hash', projectId: 'autosave' })),
      resolveMedia: vi.fn(async (_projectId: string) => []),
    };
    Object.defineProperty(window, 'clipwright', { configurable: true, value: { library } });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: `Open ${projects[0].name}` }));
    expect(await screen.findByRole('slider', { name: 'Timeline zoom level' })).toBeTruthy();
    await waitFor(() => expect(library.resolveMedia).toHaveBeenCalledWith(projects[0].id));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1200)));
    library.saveProject.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Mute Video 1' }));
    await waitFor(() => expect(library.saveProject).toHaveBeenCalled());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1200)));
    expect(library.saveProject).toHaveBeenCalledTimes(1);
    expect(JSON.parse(library.saveProject.mock.calls[0][0].contents).id).toBe(projects[0].id);
    const browserDocuments = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    const changedDocument = browserDocuments.find((document: { id: string }) => document.id === projects[0].id);
    expect(changedDocument.sequences[0].tracks.find((track: { name: string }) => track.name === 'Video 1').muted).toBe(true);
  });

  it('creates custom canvases and persists exact dimensions, composition, and background settings', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Custom frame' } });
    fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Canvas width (px)'), { target: { value: '234' } });
    fireEvent.change(screen.getByLabelText('Canvas height (px)'), { target: { value: '146' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    await screen.findByText('Custom frame');
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
      expect(stored[0].sequences[0]).toMatchObject({ width: 234, height: 146 });
    });

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '320' } });
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '180' } });
    fireEvent.change(screen.getByLabelText('Source composition'), { target: { value: 'fill' } });
    fireEvent.change(screen.getByLabelText('Canvas background'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply canvas settings' }));
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
      expect(stored[0].sequences[0]).toMatchObject({ width: 320, height: 180, canvasFit: 'fill', canvasBackground: '#123456' });
    });
  });

  it('renders imported audio clips as selectable, editable timeline blocks', async () => {
    const project = createProject('Audio timeline fixture', '16:9', 30, new Date('2025-01-01T00:00:00.000Z'));
    const document = createProjectDocument(project, '0.1.0', (entity) => `${entity}-fixture-id`);
    document.assets.push({
      id: 'audio-asset-fixture-id',
      name: 'Long ambient soundscape.wav',
      sourcePath: 'Long ambient soundscape.wav',
      pathKind: 'project-relative',
      kind: 'audio',
      streams: { audio: { timeBase: { numerator: 1, denominator: 48000 }, durationTicks: 480000, sampleRate: 48000, channels: 2 } },
    });
    document.sequences[0].durationFrames = 330;
    document.sequences[0].tracks[1].clips.push({
      id: 'audio-clip-fixture-id',
      sourceId: 'audio-asset-fixture-id',
      trackId: document.sequences[0].tracks[1].id,
      start: 1,
      trimIn: 0,
      trimOut: 10,
    });
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [document]);
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: `Open ${project.name}` }));
    const audioClip = await screen.findByRole('button', { name: 'Select Long ambient soundscape.wav clip' });
    expect(audioClip.getAttribute('title')).toContain('Long ambient soundscape.wav');
    expect(audioClip.closest('.timeline-clip')?.classList.contains('is-audio-clip')).toBe(true);
    const trimStart = screen.getByRole('slider', { name: 'Trim start of Long ambient soundscape.wav' });
    const trimEnd = screen.getByRole('slider', { name: 'Trim end of Long ambient soundscape.wav' });
    expect(Number(trimStart.getAttribute('aria-valuemax'))).toBeCloseTo(10 - 1 / 30, 5);
    expect(Number(trimEnd.getAttribute('aria-valuemin'))).toBeCloseTo(1 / 30, 5);
    expect(trimStart.getAttribute('aria-valuetext')).toBe('Source in 00:00:00.000');
    trimStart.focus();
    fireEvent.keyDown(trimStart, { key: 'End' });
    await waitFor(() => expect(trimStart.getAttribute('aria-valuetext')).toBe('Source in 00:00:09.966'));
    fireEvent.keyDown(trimStart, { key: 'Home' });
    await waitFor(() => expect(trimStart.getAttribute('aria-valuetext')).toBe('Source in 00:00:00.000'));
    trimEnd.focus();
    fireEvent.keyDown(trimEnd, { key: 'PageDown' });
    await waitFor(() => expect(trimEnd.getAttribute('aria-valuetext')).toBe('Source out 00:00:09.000'));
    fireEvent.keyDown(trimEnd, { key: 'PageUp' });
    await waitFor(() => expect(trimEnd.getAttribute('aria-valuetext')).toBe('Source out 00:00:10.000'));
    expect(container.querySelector('.empty-audio')).toBeNull();
    fireEvent.click(audioClip);
    expect(audioClip.getAttribute('aria-pressed')).toBe('true');
    audioClip.focus();
    fireEvent.keyDown(audioClip, { key: 'ContextMenu' });
    const clipActions = screen.getByRole('group', { name: 'Selected clip actions' });
    const copyAction = screen.getByRole('button', { name: 'Copy' });
    expect(clipActions.contains(window.document.activeElement)).toBe(true);
    expect(window.document.activeElement).toBe(copyAction);
    fireEvent.keyDown(copyAction, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Selected clip actions' })).toBeNull();
    expect(window.document.activeElement).toBe(audioClip);
    const clipSpaceKey = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    audioClip.dispatchEvent(clipSpaceKey);
    expect(clipSpaceKey.defaultPrevented).toBe(false);
    expect(screen.getByRole('button', { name: 'Play timeline' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Delete selected clips' }) as HTMLButtonElement).disabled).toBe(false);
    const soloAudio = screen.getByRole('button', { name: 'Solo Audio 1' });
    fireEvent.click(soloAudio);
    expect(screen.getByRole('button', { name: 'Unsolo Audio 1' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[1].solo).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Unsolo Audio 1' }));
    expect(screen.getByRole('button', { name: 'Solo Audio 1' }).getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[1].solo).toBe(false));
    const gainControl = screen.getByRole('slider', { name: 'Audio 1 gain' }) as HTMLInputElement;
    fireEvent.change(gainControl, { target: { value: '1.5' } });
    expect(screen.getByText('150%')).toBeTruthy();
    fireEvent.keyUp(gainControl, { key: 'ArrowRight' });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[1].gain).toBe(1.5));
    const panControl = screen.getByRole('slider', { name: 'Audio 1 pan' }) as HTMLInputElement;
    fireEvent.change(panControl, { target: { value: '-0.35' } });
    fireEvent.blur(panControl);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[1].pan).toBe(-0.35));
  });

  it('imports, previews, relinks, and edits a browser-session video on the timeline', async () => {
    const firstRender = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Local source test' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const createObjectURL = vi.fn().mockReturnValueOnce('blob:clipwright-local-video').mockReturnValueOnce('blob:clipwright-relinked-video');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperties(this, {
        duration: { configurable: true, value: 8.125 },
        videoWidth: { configurable: true, value: 1280 },
        videoHeight: { configurable: true, value: 720 },
      });
      window.setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
    });
    vi.spyOn(browserMedia, 'probeBrowserVideoAudio').mockResolvedValue({
      durationSeconds: 8.125,
      durationTicks: 8_125_000,
      timeBase: { numerator: 1, denominator: 1_000_000 },
      sampleRate: 48_000,
      channels: 2,
    });
    const file = new File(['local test bytes'], 'sample.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('Choose a local video file'), { target: { files: [file] } });

    expect(await screen.findByText(/Session-only video · sample\.mp4 · 1280 × 720 · 8\.13 s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play timeline' }).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).toContain('browser-session'));
    const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(saved[0].assets[0]).toMatchObject({
      name: 'sample.mp4',
      sourcePath: 'sample.mp4',
      pathKind: 'browser-session',
      kind: 'video',
      fileSizeBytes: file.size,
      streams: {
        video: { timeBase: { numerator: 1, denominator: 1_000_000 }, durationTicks: 8_125_000, width: 1280, height: 720, metadataSource: 'browser' },
        audio: { timeBase: { numerator: 1, denominator: 1_000_000 }, durationTicks: 8_125_000, sampleRate: 48_000, channels: 2 },
      },
    });
    expect(JSON.stringify(saved)).not.toContain('blob:clipwright-local-video');
    expect(createObjectURL).toHaveBeenCalledWith(file);

    firstRender.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:clipwright-local-video');
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Local source test' }));
    expect(await screen.findByText(/Session only · Relink required/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Relink' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Relink' }));
    const relinkedFile = new File(['local test bytes'], 'sample-relinked.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('Choose a local video file'), { target: { files: [relinkedFile] } });
    expect(await screen.findByText(/Session-only video · sample-relinked\.mp4 · 1280 × 720 · 8\.13 s/)).toBeTruthy();
    const relinkedDocument = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(relinkedDocument[0].assets).toHaveLength(1);
    expect(relinkedDocument[0].assets[0].sourcePath).toBe('sample-relinked.mp4');

    fireEvent.click(screen.getByRole('button', { name: 'Add at playhead' }));
    const timelineClip = await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip' });
    const relinkedPreview = screen.getByLabelText('sample-relinked.mp4 source preview') as HTMLVideoElement;
    expect(relinkedPreview.src).toBe('blob:clipwright-relinked-video');
    Object.defineProperty(relinkedPreview, 'readyState', { configurable: true, get: () => 1 });
    fireEvent.loadedMetadata(relinkedPreview);
    fireEvent.loadedData(relinkedPreview);
    fireEvent.click(timelineClip);
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:00:00');
    Object.defineProperty(relinkedPreview, 'currentTime', { configurable: true, writable: true, value: 1 });
    fireEvent.timeUpdate(relinkedPreview);
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:00:00');
    expect((container.querySelector('.timeline-playhead') as HTMLDivElement).style.transform).toContain('translateX(');
    const timelineCanvas = container.querySelector('.timeline-canvas') as HTMLDivElement;
    const pixelsPerFrame = parseFloat((timelineClip.closest('.timeline-clip') as HTMLDivElement).style.width) / 243;
    vi.spyOn(timelineCanvas, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect);
    const playheadHandle = screen.getByRole('slider', { name: 'Timeline playhead' });
    fireEvent.pointerDown(playheadHandle, { pointerId: 4, button: 0, clientX: 30 * pixelsPerFrame });
    fireEvent.pointerMove(playheadHandle, { pointerId: 4, button: 0, clientX: 90 * pixelsPerFrame });
    fireEvent.pointerUp(playheadHandle, { pointerId: 4, button: 0, clientX: 90 * pixelsPerFrame });
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:03:00');
    expect(relinkedPreview.currentTime).toBeCloseTo(3, 1);
    fireEvent.keyDown(playheadHandle, { key: 'ArrowRight' });
    expect(playheadHandle.getAttribute('aria-valuenow')).toBe('91');
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:03:01');
    expect(relinkedPreview.currentTime).toBeCloseTo(3 + 1 / 30, 3);
    const ruler = container.querySelector('.timeline-ruler-viewport') as HTMLDivElement;
    fireEvent.pointerDown(ruler, { pointerId: 5, button: 0, clientX: 60 * pixelsPerFrame });
    fireEvent.pointerMove(ruler, { pointerId: 5, button: 0, clientX: 120 * pixelsPerFrame });
    fireEvent.pointerUp(ruler, { pointerId: 5, button: 0, clientX: 120 * pixelsPerFrame });
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:04:00');
    expect(relinkedPreview.currentTime).toBeCloseTo(4, 1);
    fireEvent.click(screen.getByRole('region', { name: 'Timeline tracks' }), { clientX: Math.round(60 * pixelsPerFrame) });
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:04:00');
    expect(relinkedPreview.currentTime).toBeCloseTo(4, 1);
    const playMedia = vi.mocked(HTMLMediaElement.prototype.play);
    playMedia.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Play timeline' }));
    expect(playMedia).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause timeline playback' }));
    let edited = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(edited[0].sequences[0].durationFrames).toBe(243);
    expect(edited[0].sequences[0].tracks[0].clips[0]).toMatchObject({ start: 0, trimIn: 0, trimOut: 8.1 });

    fireEvent.click(screen.getByRole('button', { name: 'Undo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Redo timeline change' }));
    const restoredClip = await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip' });
    fireEvent.click(restoredClip);

    fireEvent.change(screen.getByLabelText('Timeline start frame'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Source out (seconds)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply trim' }));
    await waitFor(() => {
      const current = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0];
      expect(current.durationFrames).toBe(140);
      expect(current.tracks[0].clips[0]).toMatchObject({ start: 20 / 30, trimIn: 0, trimOut: 4 });
    });
    expect(Number((screen.getByRole('slider', { name: 'Seek timeline' }) as HTMLInputElement).max)).toBeCloseTo(140 / 30, 2);
    Object.defineProperty(relinkedPreview, 'currentTime', { configurable: true, writable: true, value: 4 });
    fireEvent.timeUpdate(relinkedPreview);
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:00:00');
    fireEvent.click(screen.getByRole('button', { name: 'Undo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips[0].trimOut).toBe(8.1));
    fireEvent.click(screen.getByRole('button', { name: 'Redo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips[0].trimOut).toBe(4));

    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.click(screen.getByRole('button', { name: 'Add at playhead' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected clips' }));
    edited = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(edited[0].sequences[0].durationFrames).toBe(140);
    expect(edited[0].sequences[0].tracks[0].clips).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Undo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Redo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Select sample-relinked.mp4 clip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected clips' }));
    edited = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(edited[0].sequences[0].durationFrames).toBe(0);
    expect(edited[0].sequences[0].tracks[0].clips).toEqual([]);
  });

  it('uses the RAF timeline clock through gaps and stops at the all-track duration', async () => {
    const project = createProject('Master clock test', '16:9', 30);
    const document = createProjectDocument(project);
    const track = document.sequences[0].tracks[0];
    document.assets.push({
      id: 'clock-source', name: 'timeline-source.mp4', sourcePath: 'media/timeline-source.mp4', pathKind: 'project-relative', kind: 'video',
      streams: { video: { timeBase: { numerator: 1, denominator: 1000 }, durationTicks: 5000, width: 1920, height: 1080 } },
    });
    track.clips.push({ id: 'clock-clip', sourceId: 'clock-source', trackId: track.id, start: 2, trimIn: 1, trimOut: 3 });
    document.sequences[0].durationFrames = 120;
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [document]);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: `Open ${project.name}` }));

    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play timeline' }));
    expect(requestFrame).toHaveBeenCalled();
    const firstTick = callbacks.shift();
    expect(firstTick).toBeTruthy();
    act(() => firstTick?.(100));
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:00:03');
    expect(screen.getByText('No clip under the playhead')).toBeTruthy();

    const secondTick = callbacks.shift();
    act(() => secondTick?.(1000));
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:01:00');
    const thirdTick = callbacks.shift();
    act(() => thirdTick?.(2100));
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:02:03');
    expect(screen.getByText('Relink “timeline-source.mp4” to preview this clip')).toBeTruthy();

    const finalTick = callbacks.shift();
    act(() => finalTick?.(5000));
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:04:00');
    expect(screen.getByRole('button', { name: 'Play timeline' }).hasAttribute('disabled')).toBe(false);
    expect((screen.getByRole('slider', { name: 'Seek timeline' }) as HTMLInputElement).max).toBe('4');
  });

  it('blocks export while media is missing and never uses browser callback-paced capture', async () => {
    const project = createProject('WebCodecs gate test', '16:9', 30);
    const document = createProjectDocument(project);
    const track = document.sequences[0].tracks[0];
    document.assets.push({
      id: 'export-source', name: 'offline-source.mp4', sourcePath: 'media/offline-source.mp4', pathKind: 'project-relative', kind: 'video',
      streams: { video: { timeBase: { numerator: 1, denominator: 1000 }, durationTicks: 3000, width: 1920, height: 1080 } },
    });
    track.clips.push({ id: 'export-clip', sourceId: 'export-source', trackId: track.id, start: 0, trimIn: 0, trimOut: 3 });
    document.sequences[0].durationFrames = 90;
    writeProjects(window.localStorage, [project]);
    writeProjectDocuments(window.localStorage, [document]);
    vi.stubGlobal('VideoEncoder', undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const recorderConstructor = vi.fn();
    vi.stubGlobal('MediaRecorder', recorderConstructor);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: `Open ${project.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export WEBM' }));

    expect(screen.getByRole('alert').textContent).toContain('1 missing media file');
    expect(screen.getByRole('alert').textContent).toMatch(/export is disabled/i);
    expect(recorderConstructor).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export WEBM' }).hasAttribute('disabled')).toBe(true);
  });

  it('imports, previews, and draws a session-only waveform for audio timeline clips', async () => {
    const audioMixMocks = installExportMocks();
    const fetchSource = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) });
    vi.stubGlobal('fetch', fetchSource);
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Audio playback test' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const createObjectURL = vi.fn().mockReturnValue('blob:clipwright-local-audio');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'duration', { configurable: true, value: 10 });
      window.setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
    });
    const audio = new File(['audio bytes'], 'voice.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText('Choose a local audio file'), { target: { files: [audio] } });

    expect(await screen.findByText('Session-only audio · voice.wav · 10.00 s.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add at playhead' }));
    const timelineAudio = await screen.findByLabelText('Timeline audio: voice.wav') as HTMLAudioElement;
    expect(timelineAudio.src).toBe('blob:clipwright-local-audio');
    const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(saved[0].assets[0]).toMatchObject({ kind: 'audio', name: 'voice.wav', streams: { audio: { durationTicks: 10_000_000, timeBase: { numerator: 1, denominator: 1_000_000 } } } });
    expect(saved[0].sequences[0].tracks[1].clips[0]).toMatchObject({ sourceId: saved[0].assets[0].id, start: 0, trimIn: 0, trimOut: 10 });
    const audioClip = screen.getByRole('button', { name: 'Select voice.wav clip' });
    fireEvent.click(audioClip);
    fireEvent.click(screen.getByRole('button', { name: 'Generate waveform' }));
    await waitFor(() => expect(container.querySelectorAll('.audio-waveform rect').length).toBeGreaterThan(0));
    expect(fetchSource).toHaveBeenCalledWith('blob:clipwright-local-audio');
    expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).not.toContain('waveform');
    const gainControl = screen.getByRole('slider', { name: 'Audio 1 gain' });
    fireEvent.change(gainControl, { target: { value: '1.25' } });
    fireEvent.blur(gainControl);
    const panControl = screen.getByRole('slider', { name: 'Audio 1 pan' });
    fireEvent.change(panControl, { target: { value: '0.5' } });
    fireEvent.blur(panControl);
    await waitFor(() => {
      const editedTrack = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[1];
      expect(editedTrack).toMatchObject({ gain: 1.25, pan: 0.5 });
    });

    Object.defineProperty(timelineAudio, 'readyState', { configurable: true, get: () => 1 });
    Object.defineProperty(timelineAudio, 'currentTime', { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(timelineAudio);
    fireEvent.change(screen.getByRole('slider', { name: 'Seek timeline' }), { target: { value: '2' } });
    expect(timelineAudio.currentTime).toBeCloseTo(2, 3);
    const audioPlay = vi.spyOn(HTMLAudioElement.prototype, 'play').mockResolvedValue(undefined);
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play timeline' }));
    expect(audioPlay).toHaveBeenCalled();
    expect(audioMixMocks.audioPanValues).toContain(0.5);
    expect(audioMixMocks.audioGainValues).toContain(1);
    const playbackTick = callbacks.shift();
    act(() => playbackTick?.(1000));
    expect(screen.getByLabelText(/^Playhead at/).textContent).toBe('00:00:03:00');
    expect(timelineAudio.currentTime).toBeCloseTo(3, 3);
    expect((screen.getByRole('button', { name: 'Mute preview audio' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pause timeline playback' }));
  });

  it('downloads the validated project document without embedding media', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Export test' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:project-test');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    let downloadedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadedName = this.download; });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('button', { name: /more actions for export test/i }));
    fireEvent.click(screen.getByRole('button', { name: /download \.cwproject/i }));

    expect(downloadedName).toBe('Export test.cwproject');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    const blob = createObjectURL.mock.calls[1][0] as Blob;
    const serialized = await blob.text();
    expect(serialized).toContain('"schemaVersion": 2');
    expect(serialized).toContain('"tracks"');
    expect(serialized).not.toContain('media bytes');
  });

  it('opens a validated project file and preserves exact sequence settings', async () => {
    const source = createProject('Imported interview', '16:9', 30);
    const document = createProjectDocument(source);
    document.sequences[0].width = 1440;
    document.sequences[0].height = 1080;
    document.sequences[0].frameRate = { numerator: 30000, denominator: 1001 };
    const contents = serializeProjectDocument(document);
    const file = new File([contents], 'interview.cwproject', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => contents });
    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { files: [file] } });

    expect(await screen.findByText('Imported interview')).toBeTruthy();
    expect(screen.getByText('4:3')).toBeTruthy();
    expect(screen.getByText('29.97 fps')).toBeTruthy();
    const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(saved[0].sequences[0].frameRate).toEqual({ numerator: 30000, denominator: 1001 });
    expect(saved[0].sequences[0].width).toBe(1440);
  });

  it('opens a managed desktop project, saves through its opaque handle, and lists recovery points', async () => {
    const project = createProject('Managed desktop edit', '16:9', 30);
    const document = createProjectDocument(project);
    const contents = serializeProjectDocument(document);
    const earlierDocument = { ...document, metadata: { ...document.metadata, name: 'Earlier managed version' } };
    const earlierContents = serializeProjectDocument(earlierDocument);
    const point: ClipWrightRecoveryPoint = { id: '1767225600000-12345678-1234-4234-8234-123456789abc.cwproject', modifiedAt: '2026-01-01T00:00:00.000Z', sizeBytes: earlierContents.length };
    const desktopFiles = {
      open: vi.fn().mockResolvedValue({ canceled: false, handle: 'session-handle', fileName: 'Managed desktop edit.cwproject', contents, documentId: document.id }),
      saveAs: vi.fn(),
      save: vi.fn().mockResolvedValue({ changed: false, recoveryId: null, documentId: document.id, fileName: 'Managed desktop edit.cwproject' }),
      listRecoveryPoints: vi.fn().mockResolvedValue([point]),
      readRecoveryPoint: vi.fn().mockResolvedValue(earlierContents),
    };
    const confirmRestore = vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(window, 'clipwright', { configurable: true, value: { projectFiles: desktopFiles } });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open project file' }));
    expect(desktopFiles.open).toHaveBeenCalledOnce();
    expect(await screen.findByText('Managed desktop edit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(desktopFiles.save).toHaveBeenCalledWith({ handle: 'session-handle', contents }));

    fireEvent.click(screen.getByRole('button', { name: 'Project recovery' }));
    expect(await screen.findByRole('dialog', { name: 'Restore a checkpoint' })).toBeTruthy();
    expect(desktopFiles.listRecoveryPoints).toHaveBeenCalledWith('session-handle');
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(confirmRestore).toHaveBeenCalledOnce();
    await waitFor(() => expect(desktopFiles.readRecoveryPoint).toHaveBeenCalledWith({ handle: 'session-handle', recoveryId: point.id }));
    await waitFor(() => expect(desktopFiles.save).toHaveBeenCalledWith({ handle: 'session-handle', contents: earlierContents }));
    expect(await screen.findByText('Recovery checkpoint restored.')).toBeTruthy();
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
      expect(saved[0].metadata.name).toBe('Earlier managed version');
    });
  });

  it('rejects an invalid project file without adding a partial project entry', async () => {
    const badContents = '{broken';
    const file = new File([badContents], 'broken.cwproject', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => badContents });
    const { container } = render(<App />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText(/not valid JSON/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? '[]')).toHaveLength(0);
  });

  it('imports an ID collision as a separate copy instead of replacing existing data', async () => {
    const existing = createProject('Existing local project', '16:9', 24);
    const existingDocument = createProjectDocument(existing);
    writeProjects(window.localStorage, [existing]);
    writeProjectDocuments(window.localStorage, [existingDocument]);
    const incoming = createProjectDocument({ ...existing, name: 'Imported copy' });
    const contents = serializeProjectDocument(incoming);
    const file = new File([contents], 'copy.cwproject', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => contents });
    const { container } = render(<App />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    expect(await screen.findByText('Imported copy')).toBeTruthy();
    expect(screen.getByText(/separate project copy/i)).toBeTruthy();
    const savedProjects = JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? '[]');
    const savedDocuments = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(savedProjects).toHaveLength(2);
    expect(savedDocuments).toHaveLength(2);
    expect(savedProjects[0].id).not.toBe(existing.id);
    expect(savedDocuments.find((doc: { id: string }) => doc.id === existing.id).metadata.name).toBe('Existing local project');
  });

  it('preserves unreadable project documents and rebuilds only after confirmation', () => {
    const project = createProject('Recover project', '16:9', 30);
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([project]));
    const brokenDocuments = '{unreadable';
    window.localStorage.setItem(PROJECT_DOCUMENTS_KEY, brokenDocuments);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('existing documents have not been overwritten');
    expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).toBe(brokenDocuments);
    fireEvent.click(screen.getByRole('button', { name: /preserve & rebuild/i }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(`${PROJECT_DOCUMENTS_KEY}.recovery`)).toBe(brokenDocuments);
    const recovered = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe(project.id);
    expect(recovered[0].sequences[0].tracks).toHaveLength(2);
  });

  it('preserves unreadable project data until the user confirms recovery', async () => {
    const brokenData = '{not valid';
    window.localStorage.setItem(PROJECTS_KEY, brokenData);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('has not been overwritten');
    expect(window.localStorage.getItem(PROJECTS_KEY)).toBe(brokenData);
    fireEvent.click(screen.getByRole('button', { name: /preserve & start fresh/i }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(`${PROJECTS_KEY}.recovery`)).toBe(brokenData);
    expect(window.localStorage.getItem(PROJECTS_KEY)).toBe('[]');
  });

  it('traps focus inside dialogs and restores it to the opener when dismissed', async () => {
    render(<App />);
    const opener = screen.getByRole('button', { name: /create your first project/i });
    opener.focus();
    fireEvent.click(opener);
    const projectName = await screen.findByLabelText('Project name');
    expect(document.activeElement).toBe(projectName);

    const close = screen.getByRole('button', { name: 'Close dialog' });
    fireEvent.keyDown(projectName, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    const submit = screen.getByRole('button', { name: /create project/i });
    expect(document.activeElement).toBe(submit);
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a project' })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('applies and persists editor preferences and editable shortcut bindings, with a safe reset', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Snapping/i }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('clipwright.preferences.v1') ?? '{}').editor.snapEnabled).toBe(false));

    fireEvent.click(screen.getByRole('tab', { name: 'Shortcuts' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Split at playhead' }), { target: { value: 'Ctrl+Shift+X' } });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('clipwright.preferences.v1') ?? '{}').shortcuts.split).toBe('Ctrl+Shift+X'));

    fireEvent.click(screen.getByRole('button', { name: 'Reset defaults' }));
    await waitFor(() => {
      const preferences = JSON.parse(window.localStorage.getItem('clipwright.preferences.v1') ?? '{}');
      expect(preferences.editor.snapEnabled).toBe(true);
      expect(preferences.shortcuts.split).toBe('S');
    });
  });

  it('focuses and restores Settings and Task centre dialogs', async () => {
    render(<App />);
    const settingsOpener = screen.getByRole('button', { name: 'Settings' });
    settingsOpener.focus();
    fireEvent.click(settingsOpener);
    const settingsClose = screen.getByRole('button', { name: 'Close settings' });
    expect(document.activeElement).toBe(settingsClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(document.activeElement).toBe(settingsOpener);

    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: 'Focus test' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    const taskOpener = await screen.findByRole('button', { name: 'Task centre' });
    taskOpener.focus();
    fireEvent.click(taskOpener);
    const taskDialog = screen.getByRole('dialog', { name: 'Task centre' });
    const taskClose = screen.getByRole('button', { name: 'Close task centre' });
    expect(taskDialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(taskClose);
    fireEvent.keyDown(taskClose, { key: 'Tab' });
    expect(document.activeElement).toBe(taskClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task centre' })).toBeNull());
    expect(document.activeElement).toBe(taskOpener);
  });

  it('announces error notifications assertively while hiding decorative status icons', async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.click(await screen.findByRole('option', { name: 'Open Editor workspace' }));
    const errorAlert = screen.getByRole('alert');
    expect(errorAlert.getAttribute('aria-live')).toBe('assertive');
    expect(errorAlert.getAttribute('aria-atomic')).toBe('true');
    expect(errorAlert.querySelector('.toast-mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(errorAlert.textContent).toContain('Create or open a project before entering the editor.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens a keyboard shortcut reference and restores focus to its help trigger', async () => {
    render(<App />);
    const opener = screen.getByRole('button', { name: 'Help and keyboard shortcuts' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const close = screen.getByRole('button', { name: 'Close help' });
    expect(window.document.activeElement).toBe(close);
    expect(dialog.textContent).toContain('Trim controls');
    expect(dialog.textContent).toContain('Linked sources may need relinking if they move.');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
    expect(window.document.activeElement).toBe(opener);
  });

  it('opens project actions accessibly and restores focus when dismissed with Escape', () => {
    const project = createProject('Menu focus test', '16:9', 30);
    writeProjects(window.localStorage, [project]);
    render(<App />);
    const trigger = screen.getByRole('button', { name: `More actions for ${project.name}` });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: `Actions for ${project.name}` })).toBeTruthy();
    const openAction = screen.getByRole('button', { name: 'Open project' });
    expect(document.activeElement).toBe(openAction);
    fireEvent.keyDown(openAction, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: `Actions for ${project.name}` })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('supports keyboard navigation and panel semantics for project filter tabs', () => {
    render(<App />);
    const recent = screen.getByRole('tab', { name: /Recent/ }) as HTMLButtonElement;
    const archived = screen.getByRole('tab', { name: /Archived/ }) as HTMLButtonElement;
    const panel = screen.getByRole('tabpanel');
    expect(recent.tabIndex).toBe(0);
    expect(archived.tabIndex).toBe(-1);
    expect(panel.getAttribute('aria-labelledby')).toBe('recent-projects-tab');

    recent.focus();
    fireEvent.keyDown(recent, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(archived);
    expect(archived.getAttribute('aria-selected')).toBe('true');
    expect(archived.tabIndex).toBe(0);
    expect(panel.getAttribute('aria-labelledby')).toBe('archived-projects-tab');
    expect(screen.getByRole('heading', { name: 'No archived projects' })).toBeTruthy();

    fireEvent.keyDown(archived, { key: 'Home' });
    expect(document.activeElement).toBe(recent);
    expect(recent.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(recent, { key: 'End' });
    expect(document.activeElement).toBe(archived);
    fireEvent.keyDown(archived, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(recent);
  });

  it('shows optional first-run guidance and remembers a skipped welcome screen', () => {
    const { unmount } = render(<App />);
    expect(screen.getByRole('region', { name: 'Start with a project, not a setup wizard.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open existing project' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip onboarding' }));
    expect(screen.queryByRole('region', { name: 'Start with a project, not a setup wizard.' })).toBeNull();
    expect(window.localStorage.getItem('clipwright.onboarding.completed.v1')).toBe('true');
    unmount();
    render(<App />);
    expect(screen.queryByRole('region', { name: 'Start with a project, not a setup wizard.' })).toBeNull();
  });

  it('skips first-run guidance when existing projects are present', () => {
    writeProjects(window.localStorage, [createProject('Existing edit', '16:9', 30)]);
    render(<App />);
    expect(screen.queryByRole('region', { name: 'Start with a project, not a setup wizard.' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Existing edit' })).toBeTruthy();
  });

  it('remembers project search and sort, and orders collections predictably', async () => {
    const alpha = createProject('Alpha edit', '16:9', 30, new Date('2026-02-01T00:00:00Z'));
    const zulu = createProject('Zulu edit', '16:9', 30, new Date('2026-01-01T00:00:00Z'));
    writeProjects(window.localStorage, [zulu, alpha]);
    const first = render(<App />);
    const sort = screen.getByRole('combobox', { name: 'Sort projects' });
    fireEvent.change(sort, { target: { value: 'name' } });
    await waitFor(() => expect([...first.container.querySelectorAll('.project-thumb')].map((item) => item.getAttribute('aria-label'))).toEqual(['Open Alpha edit', 'Open Zulu edit']));
    const search = screen.getByRole('textbox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'Zulu' } });
    expect(screen.getByText('1 project found')).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem('clipwright.projects.view.v1')).toContain('Zulu'));
    first.unmount();
    const second = render(<App />);
    expect((screen.getByRole('textbox', { name: 'Search projects' }) as HTMLInputElement).value).toBe('Zulu');
    expect((screen.getByRole('combobox', { name: 'Sort projects' }) as HTMLSelectElement).value).toBe('name');
    expect(second.container.querySelectorAll('.project-thumb')).toHaveLength(1);
  });

  it('renders large project lists incrementally without hiding the remaining entries', () => {
    const projects = Array.from({ length: 61 }, (_, index) => createProject(`Project ${String(index + 1).padStart(2, '0')}`, '16:9', 30, new Date('2026-01-01T00:00:00Z')));
    writeProjects(window.localStorage, projects);
    const { container } = render(<App />);
    expect(container.querySelectorAll('.project-thumb')).toHaveLength(60);
    expect(screen.getByText('Showing 60 of 61')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    expect(container.querySelectorAll('.project-thumb')).toHaveLength(61);
    expect(screen.queryByRole('button', { name: 'Load more projects' })).toBeNull();
  });

  it('applies each interface scale and accent choice to the root design tokens', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.change(screen.getByRole('combobox', { name: /Interface scale/ }), { target: { value: '125' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Accent color/ }), { target: { value: 'blue' } });
    await waitFor(() => {
      expect(document.documentElement.dataset.uiScale).toBe('125');
      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#4b91e2');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#28639e'));
  });

  it('runs an optional editor tour, supports Back and Escape, and can be restarted from Help', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Tour project' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create project$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Help$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start editor tour' }));
    expect(await screen.findByRole('complementary', { name: 'Guided editor tour' })).toBeTruthy();
    expect(document.querySelector('[data-tour="media-bin"]')?.getAttribute('data-tour-active')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Guided editor tour' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /^Help$/ }));
    expect(screen.getByRole('button', { name: 'Start editor tour' }).hasAttribute('disabled')).toBe(false);
  });

  it('uses keyboard navigation in the command palette to switch workspaces', async () => {
    render(<App />);
    const opener = screen.getByRole('button', { name: 'Settings' });
    opener.focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('Type a command…');
    expect(document.activeElement).toBe(input);
    const options = within(screen.getByRole('listbox', { name: 'Available commands' })).getAllByRole('option');
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(options[options.length - 1]);
    fireEvent.keyDown(options[options.length - 1], { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    expect(document.activeElement).toBe(opener);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const reopenedInput = await screen.findByPlaceholderText('Type a command…');
    const reopenedOptions = within(screen.getByRole('listbox', { name: 'Available commands' })).getAllByRole('option');
    fireEvent.keyDown(reopenedInput, { key: 'ArrowUp' });
    expect(reopenedOptions[reopenedOptions.length - 1].getAttribute('aria-selected')).toBe('true');
    expect(reopenedInput.getAttribute('aria-activedescendant')).toBe(`command-option-${reopenedOptions.length - 1}`);
    fireEvent.keyDown(reopenedInput, { key: 'ArrowDown' });
    expect(reopenedOptions[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(reopenedInput, { key: 'End' });
    expect(reopenedOptions[reopenedOptions.length - 1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(reopenedInput, { key: 'Home' });
    fireEvent.keyDown(reopenedInput, { key: 'ArrowDown' });
    fireEvent.keyDown(reopenedInput, { key: 'ArrowDown' });
    fireEvent.keyDown(reopenedInput, { key: 'ArrowDown' });
    fireEvent.keyDown(reopenedInput, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: /find the moments worth keeping/i })).toBeTruthy();
    expect(screen.getByText(/analysis is not available yet/i)).toBeTruthy();
  });
});
