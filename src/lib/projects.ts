export type AspectRatio = '16:9' | '9:16' | '1:1';
export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  aspectRatio: AspectRatio;
  frameRate: 24 | 25 | 30 | 60;
  archived: boolean;
  favorite: boolean;
};

export const PROJECTS_KEY = 'clipwright.projects.v1';

export function validateProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<Project>;
  return typeof project.id === 'string'
    && typeof project.name === 'string'
    && typeof project.createdAt === 'string'
    && typeof project.updatedAt === 'string'
    && ['16:9', '9:16', '1:1'].includes(project.aspectRatio ?? '')
    && [24, 25, 30, 60].includes(project.frameRate ?? 0)
    && typeof project.archived === 'boolean'
    && typeof project.favorite === 'boolean';
}

export type ProjectStoreRead = { projects: Project[]; issue: 'invalid-data' | 'storage-unavailable' | null };

export function readProjectStore(storage: Pick<Storage, 'getItem'>): ProjectStoreRead {
  let raw: string | null;
  try { raw = storage.getItem(PROJECTS_KEY); }
  catch { return { projects: [], issue: 'storage-unavailable' }; }
  if (!raw) return { projects: [], issue: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(validateProject)) return { projects: [], issue: 'invalid-data' };
    return { projects: parsed, issue: null };
  } catch {
    return { projects: [], issue: 'invalid-data' };
  }
}

export function readProjects(storage: Pick<Storage, 'getItem'>): Project[] {
  return readProjectStore(storage).projects;
}

export function createProject(name: string, aspectRatio: AspectRatio, frameRate: Project['frameRate'], now = new Date()): Project {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Enter a project name.');
  return {
    id: crypto.randomUUID(),
    name: trimmedName,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    aspectRatio,
    frameRate,
    archived: false,
    favorite: false,
  };
}

export function writeProjects(storage: Pick<Storage, 'setItem'>, projects: Project[]): void {
  storage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}
