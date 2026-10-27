import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createProject, PROJECTS_KEY, writeProjects } from './lib/projects';
import { createProjectDocument, PROJECT_DOCUMENTS_KEY, serializeProjectDocument, writeProjectDocuments } from './lib/projectDocument';

beforeEach(() => {
  window.localStorage.clear();
  let uuid = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `project-test-id-${++uuid}` });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClipWright foundation UI', () => {
  it('creates and persists a project before opening the editor workspace', async () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Interview cut' } });
    fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: '9:16' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByRole('heading', { name: 'Interview cut' })).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem(PROJECTS_KEY)).toContain('Interview cut'));
    expect(window.localStorage.getItem(PROJECTS_KEY)).toContain('9:16');
    await waitFor(() => expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).toContain('"schemaVersion":1'));
    const savedDocuments = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(savedDocuments[0].sequences[0].tracks).toHaveLength(2);
    expect(screen.getByText(/choose a local video to read browser-reported metadata/i)).toBeTruthy();
    expect([...container.querySelectorAll('.editor-layout > *')].map((element) => element.className)).toEqual([
      'editor-media-panel',
      'editor-center',
      'properties-panel',
      'timeline-resize-handle',
      'timeline-panel',
    ]);
    expect([...container.querySelectorAll('.editor-center > *')].map((element) => element.className)).toEqual([
      'preview-stage',
      'preview-controls',
    ]);
    expect(container.querySelector('.timeline-panel')?.parentElement).toBe(container.querySelector('.editor-layout'));
    expect([...container.querySelectorAll('.timeline-track-layout > *')].map((element) => element.className)).toEqual([
      'timeline-track-header-column',
      'timeline-scroll',
    ]);
    const timelineScroller = container.querySelector('.timeline-scroll') as HTMLDivElement;
    const trackHeaders = container.querySelector('.timeline-track-header-rows') as HTMLDivElement;
    fireEvent.scroll(timelineScroller, { target: { scrollTop: 42, scrollLeft: 50 } });
    expect(trackHeaders.style.transform).toBe('translateY(-42px)');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize timeline height' }), { key: 'ArrowUp' });
    expect(screen.getByRole('separator', { name: 'Resize timeline height' }).getAttribute('aria-valuenow')).toBe('296');
    expect(window.localStorage.getItem('clipwright.workspace.timeline-height')).toBe('296');
    fireEvent.change(screen.getByRole('slider', { name: 'Timeline zoom level' }), { target: { value: '2' } });
    expect(screen.getByText('200%')).toBeTruthy();
    expect(window.localStorage.getItem('clipwright.workspace.timeline-zoom')).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Fit project in timeline' }));
    expect(screen.getByText('100%')).toBeTruthy();
    expect(window.localStorage.getItem('clipwright.workspace.timeline-zoom')).toBe('1');
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
    const file = new File(['local test bytes'], 'sample.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('Choose a local video file'), { target: { files: [file] } });

    expect(await screen.findByText(/Metadata read · sample\.mp4 · 1280 × 720 · 8\.13 s/)).toBeTruthy();
    const preview = screen.getByLabelText('sample.mp4 source preview') as HTMLVideoElement;
    expect(preview.src).toBe('blob:clipwright-local-video');
    expect(screen.getByRole('button', { name: 'Play source preview' }).hasAttribute('disabled')).toBe(false);
    await waitFor(() => expect(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY)).toContain('browser-session'));
    const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(saved[0].assets[0]).toMatchObject({
      name: 'sample.mp4',
      sourcePath: 'sample.mp4',
      pathKind: 'browser-session',
      kind: 'video',
      fileSizeBytes: file.size,
      streams: { video: { timeBase: { numerator: 1, denominator: 1_000_000 }, durationTicks: 8_125_000, width: 1280, height: 720, metadataSource: 'browser' } },
    });
    expect(JSON.stringify(saved)).not.toContain('blob:clipwright-local-video');
    expect(createObjectURL).toHaveBeenCalledWith(file);

    firstRender.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:clipwright-local-video');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Local source test' }));
    expect(await screen.findByText('Relink required')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Relink' }));
    const relinkedFile = new File(['same source'], 'sample-relinked.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('Choose a local video file'), { target: { files: [relinkedFile] } });
    expect(await screen.findByText(/Metadata read · sample-relinked\.mp4 · 1280 × 720 · 8\.13 s/)).toBeTruthy();
    const relinkedPreview = screen.getByLabelText('sample-relinked.mp4 source preview') as HTMLVideoElement;
    expect(relinkedPreview.src).toBe('blob:clipwright-relinked-video');
    const relinkedDocument = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(relinkedDocument[0].assets).toHaveLength(1);
    expect(relinkedDocument[0].assets[0].sourcePath).toBe('sample-relinked.mp4');

    fireEvent.click(screen.getByRole('button', { name: 'Add selected source' }));
    expect(await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip at frame 0' })).toBeTruthy();
    let edited = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(edited[0].sequences[0].durationFrames).toBe(244);
    expect(edited[0].sequences[0].tracks[0].clips[0]).toMatchObject({ timelineStartFrame: 0, timelineDurationFrames: 244 });

    fireEvent.click(screen.getByRole('button', { name: 'Undo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Redo timeline change' }));
    expect(await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip at frame 0' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Timeline start frame'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip at frame 20' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Source out (seconds)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply trim' }));
    await waitFor(() => {
      const current = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0];
      expect(current.durationFrames).toBe(140);
      expect(current.tracks[0].clips[0]).toMatchObject({ sourceInTick: 0, sourceOutTick: 4_000_000, timelineStartFrame: 20, timelineDurationFrames: 120 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips[0].sourceOutTick).toBe(8_125_000));
    fireEvent.click(screen.getByRole('button', { name: 'Redo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips[0].sourceOutTick).toBe(4_000_000));

    fireEvent.click(screen.getByRole('button', { name: 'Add selected source' }));
    expect(await screen.findByRole('button', { name: 'Select sample-relinked.mp4 clip at frame 140' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected clip' }));
    edited = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(edited[0].sequences[0].durationFrames).toBe(140);
    expect(edited[0].sequences[0].tracks[0].clips).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Undo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Redo timeline change' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]')[0].sequences[0].tracks[0].clips).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Select sample-relinked.mp4 clip at frame 20' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected clip' }));
    edited = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(edited[0].sequences[0].durationFrames).toBe(0);
    expect(edited[0].sequences[0].tracks[0].clips).toEqual([]);
  });

  it('rejects audio-only picks without creating a project media reference', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Audio negative case' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    const audio = new File(['audio bytes'], 'voice.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText('Choose a local video file'), { target: { files: [audio] } });

    expect(await screen.findByText(/audio-only ingestion is not supported yet/i)).toBeTruthy();
    const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(saved[0].assets).toEqual([]);
  });

  it('downloads the validated project document without embedding media', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /create your first project/i }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Export test' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:project-test');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    let downloadedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadedName = this.download; });
    fireEvent.click(screen.getByRole('button', { name: /more actions for export test/i }));
    fireEvent.click(screen.getByRole('button', { name: /download \.cwproject/i }));

    expect(downloadedName).toBe('Export test.cwproject');
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const serialized = await blob.text();
    expect(serialized).toContain('"schemaVersion": 1');
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

    expect(await screen.findByRole('heading', { name: 'Imported interview' })).toBeTruthy();
    expect(screen.getAllByText('4:3')).toHaveLength(2);
    expect(screen.getAllByText('29.97 fps')).toHaveLength(2);
    const saved = JSON.parse(window.localStorage.getItem(PROJECT_DOCUMENTS_KEY) ?? '[]');
    expect(saved[0].sequences[0].frameRate).toEqual({ numerator: 30000, denominator: 1001 });
    expect(saved[0].sequences[0].width).toBe(1440);
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

    expect(await screen.findByRole('heading', { name: 'Imported copy' })).toBeTruthy();
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

  it('uses keyboard navigation in the command palette to switch workspaces', async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('Type a command…');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: /find the moments worth keeping/i })).toBeTruthy();
    expect(screen.getByText(/analysis is not available yet/i)).toBeTruthy();
  });
});
