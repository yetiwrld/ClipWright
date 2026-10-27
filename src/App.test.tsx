import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createProject, PROJECTS_KEY } from './lib/projects';
import { PROJECT_DOCUMENTS_KEY } from './lib/projectDocument';

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
    render(<App />);
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
    expect(screen.getByText(/media import and metadata inspection are not implemented/i)).toBeTruthy();
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
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: /find the moments worth keeping/i })).toBeTruthy();
    expect(screen.getByText(/analysis is not available yet/i)).toBeTruthy();
  });
});
