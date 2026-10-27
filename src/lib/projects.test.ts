import { describe, expect, it } from 'vitest';
import { createProject, PROJECTS_KEY, readProjectStore, readProjects, validateProject, writeProjects } from './projects';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

describe('project persistence', () => {
  it('creates a project with the chosen settings and a stable id', () => {
    const created = createProject('  Interview edit  ', '9:16', 30, new Date('2026-10-27T00:00:00.000Z'));
    expect(created.name).toBe('Interview edit');
    expect(created.aspectRatio).toBe('9:16');
    expect(created.frameRate).toBe(30);
    expect(created.id).toBeTruthy();
    expect(validateProject(created)).toBe(true);
  });

  it('rejects blank names', () => {
    expect(() => createProject('  ', '16:9', 24)).toThrow('Enter a project name.');
  });

  it('round trips projects through storage and tolerates damaged data', () => {
    const storage = memoryStorage();
    const projects = [createProject('Launch film', '16:9', 24)];
    writeProjects(storage, projects);
    expect(storage.getItem(PROJECTS_KEY)).toContain('Launch film');
    expect(readProjects(storage)).toEqual(projects);
    storage.setItem(PROJECTS_KEY, '{broken');
    expect(readProjects(storage)).toEqual([]);
    expect(readProjectStore(storage).issue).toBe('invalid-data');
    expect(storage.getItem(PROJECTS_KEY)).toBe('{broken'); // Invalid data remains untouched until recovery is confirmed.
    storage.setItem(PROJECTS_KEY, JSON.stringify([{ name: 'not a project' }]));
    expect(readProjects(storage)).toEqual([]);
    expect(readProjectStore(storage).issue).toBe('invalid-data');
  });
});
