import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { PROJECTS_KEY } from './lib/projects';

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('crypto', { ...window.crypto, randomUUID: () => 'project-test-id' });
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
    expect(screen.getByText(/media import and metadata inspection are not implemented/i)).toBeTruthy();
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
