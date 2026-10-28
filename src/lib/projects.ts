export type AspectRatio = '16:9' | '9:16' | '1:1';
export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  aspectRatio: string;
  frameRate: number;
  archived: boolean;
  favorite: boolean;
};

export const PROJECTS_KEY = 'clipwright.projects.v1';

function isAspectRatio(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{1,5}):(\d{1,5})$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 && width / height >= 1 / 1024 && width / height <= 1024;
}

function isSupportedFrameRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 240;
}

export function validateProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<Project>;
  return typeof project.id === 'string'
    && project.id.trim().length > 0
    && typeof project.name === 'string'
    && project.name.trim().length > 0
    && typeof project.createdAt === 'string'
    && Number.isFinite(Date.parse(project.createdAt))
    && typeof project.updatedAt === 'string'
    && Number.isFinite(Date.parse(project.updatedAt))
    && isAspectRatio(project.aspectRatio)
    && isSupportedFrameRate(project.frameRate)
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
    if (!Array.isArray(parsed) || !parsed.every(validateProject) || new Set(parsed.map((project) => project.id)).size !== parsed.length) return { projects: [], issue: 'invalid-data' };
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
  if (!isAspectRatio(aspectRatio) || !isSupportedFrameRate(frameRate)) throw new Error('Project settings are invalid.');
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
  const ids = new Set<string>();
  for (const project of projects) {
    if (!validateProject(project)) throw new Error('Cannot persist an invalid project-list entry.');
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    ids.add(project.id);
  }
  storage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}
