import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowLeft, ArrowRight, Check, ChevronDown, Download,
  CircleHelp, Clapperboard, Clock3, Command, FilePlus2, Film, FolderOpen,
  Pause, Play, SkipBack, SkipForward, Undo2, Redo2, Volume2, VolumeX,
  Grid2X2, HardDrive, Heart, Home, Keyboard, ListFilter, Maximize2,
  MoreHorizontal, Plus, Search, Settings2, Sparkles, Sun, Moon, Trash2, Upload, ZoomIn, ZoomOut,
  X, type LucideIcon,
} from 'lucide-react';
import { createProject, PROJECTS_KEY, readProjectStore, writeProjects } from './lib/projects';
import type { AspectRatio, Project } from './lib/projects';
import { createProjectDocument, migrateLegacyProjectEntry, parseProjectDocument, PROJECT_DOCUMENTS_KEY, readProjectDocuments, serializeProjectDocument, writeProjectDocuments } from './lib/projectDocument';
import type { MediaAsset, ProjectDocument, Sequence, StreamInfo, VideoClip } from './lib/projectDocument';
import { probeBrowserVideo } from './lib/browserMedia';
import { appendVideoClip, moveVideoClip, removeVideoClip, sequenceDurationInFrames, trimVideoClip } from './lib/timelineOperations';

type Workspace = 'home' | 'clipping' | 'editor';
type Toast = { id: number; message: string; kind?: 'error' | 'success' };

const workspaceItems: { id: Workspace; label: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'clipping', label: 'AI Clipping', icon: Sparkles },
  { id: 'editor', label: 'Editor', icon: Clapperboard },
];

function readableDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
}

function formatFrameRate(value: number) {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))} fps`;
}

function aspectRatioOf(width: number, height: number) {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

type SessionMediaSource = { url: string; name: string };
type TimelineHistory = { past: Sequence[]; future: Sequence[] };
const mediaKey = (projectId: string, assetId: string) => JSON.stringify([projectId, assetId]);
const TIMELINE_HEIGHT_KEY = 'clipwright.workspace.timeline-height';
const TIMELINE_ZOOM_KEY = 'clipwright.workspace.timeline-zoom';
const TIMELINE_MIN_HEIGHT = 180;
const TIMELINE_DEFAULT_HEIGHT = 360;

function readTimelineHeight() {
  try {
    const value = Number(window.localStorage.getItem(TIMELINE_HEIGHT_KEY));
    return Number.isFinite(value) && value >= TIMELINE_MIN_HEIGHT ? value : TIMELINE_DEFAULT_HEIGHT;
  } catch { return TIMELINE_DEFAULT_HEIGHT; }
}

function storeTimelineHeight(value: number) {
  try { window.localStorage.setItem(TIMELINE_HEIGHT_KEY, String(value)); }
  catch { /* The workspace remains usable when preferences cannot be persisted. */ }
}

function readTimelineZoom() {
  try {
    const value = Number(window.localStorage.getItem(TIMELINE_ZOOM_KEY));
    return Number.isFinite(value) && value >= 0.25 && value <= 4 ? value : 1;
  } catch { return 1; }
}

function storeTimelineZoom(value: number) {
  try { window.localStorage.setItem(TIMELINE_ZOOM_KEY, String(value)); }
  catch { /* The workspace remains usable when preferences cannot be persisted. */ }
}

function niceRulerIntervalSeconds(target: number) {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find((value) => value >= target) ?? Math.ceil(target / 3600) * 3600;
}

function formatPlaybackTime(value: number) {
  const milliseconds = Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function formatRulerTime(frame: number, frameRate: { numerator: number; denominator: number }) {
  const totalSeconds = Math.floor(frame * frameRate.denominator / frameRate.numerator);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  const frames = frame - Math.floor(totalSeconds * frameRate.numerator / frameRate.denominator);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

function formatSourceSeconds(ticks: number, timeBase: { numerator: number; denominator: number }) {
  return (ticks * timeBase.numerator / timeBase.denominator).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>('home');
  const [initialProjectStore] = useState(() => readProjectStore(window.localStorage));
  const [projects, setProjects] = useState<Project[]>(initialProjectStore.projects);
  const [storageWarning, setStorageWarning] = useState(initialProjectStore.issue);
  const [initialDocumentStore] = useState(() => readProjectDocuments(window.localStorage));
  const [documents, setDocuments] = useState<ProjectDocument[]>(() => {
    if (initialDocumentStore.issue) return [];
    const byId = new Map(initialDocumentStore.documents.map((document) => [document.id, document]));
    for (const project of initialProjectStore.projects) {
      if (!byId.has(project.id)) {
        try { byId.set(project.id, migrateLegacyProjectEntry(project)); }
        catch { /* A malformed legacy record remains in the separate project-list store for recovery. */ }
      }
    }
    return [...byId.values()];
  });
  const [documentStorageWarning, setDocumentStorageWarning] = useState(initialDocumentStore.issue);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => window.localStorage.getItem('clipwright.theme') === 'light' ? 'light' : 'dark');
  const [sessionSources, setSessionSources] = useState<Record<string, SessionMediaSource>>({});
  const [timelineHistory, setTimelineHistory] = useState<Record<string, TimelineHistory>>({});
  const sessionSourcesRef = useRef<Record<string, SessionMediaSource>>({});
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null);
  const [pendingRelinkAssetId, setPendingRelinkAssetId] = useState<string | null>(null);
  const [isReadingMedia, setIsReadingMedia] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const persistenceWarning = storageWarning ?? documentStorageWarning;
  const visibleProjects = useMemo(() => projects
    .filter((project) => project.archived === showArchived)
    .filter((project) => project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt)), [projects, query, showArchived]);

  useEffect(() => {
    if (storageWarning) return; // Never replace unreadable project metadata without an explicit recovery choice.
    try { writeProjects(window.localStorage, projects); }
    catch { notify('Unable to save project list in this browser profile.', 'error'); }
  // Persist application-owned project metadata; media files are not copied or uploaded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, storageWarning]);

  useEffect(() => {
    if (documentStorageWarning) return; // Keep unreadable project documents intact until recovery is confirmed.
    try { writeProjectDocuments(window.localStorage, documents); }
    catch {
      setDocumentStorageWarning('storage-unavailable');
      notify('Unable to save project documents in this browser profile.', 'error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, documentStorageWarning]);

  useEffect(() => {
    try { window.localStorage.setItem('clipwright.theme', theme); }
    catch { /* Theme remains usable for this session even if browser storage is blocked. */ }
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => () => {
    for (const source of Object.values(sessionSourcesRef.current)) URL.revokeObjectURL(source.url);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setShowCommands((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault(); if (!persistenceWarning) setShowCreate(true);
      }
      if (event.key === 'Escape') {
        setShowCreate(false); setShowSettings(false); setShowCommands(false); setShowTasks(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistenceWarning]);

  function notify(message: string, kind: Toast['kind'] = 'success') {
    const id = Date.now();
    setToast({ id, message, kind });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 3200);
  }

  function requestVideoImport(assetId?: string) {
    if (!activeProjectId || persistenceWarning) {
      notify('Open a project with writable browser storage before importing video.', 'error');
      return;
    }
    setPendingRelinkAssetId(assetId ?? null);
    videoFileInputRef.current?.click();
  }

  async function importVideoFile(file: File | null) {
    if (!file) { setPendingRelinkAssetId(null); return; }
    const projectId = activeProjectId;
    const project = projects.find((entry) => entry.id === projectId);
    const projectDocument = documents.find((entry) => entry.id === projectId);
    if (!project || !projectDocument) {
      setPendingRelinkAssetId(null);
      notify('The active project document is unavailable; video was not imported.', 'error');
      return;
    }
    if (file.type.startsWith('audio/')) {
      setPendingRelinkAssetId(null);
      notify('Audio-only ingestion is not supported yet. Select a video file.', 'error');
      return;
    }
    const targetAsset = pendingRelinkAssetId
      ? projectDocument.assets.find((asset) => asset.id === pendingRelinkAssetId && asset.kind === 'video')
      : undefined;
    if (pendingRelinkAssetId && !targetAsset) {
      setPendingRelinkAssetId(null);
      notify('This project has no matching video asset to relink.', 'error');
      return;
    }

    const safeFileName = file.name.split(/[\\/]/).filter(Boolean).pop()?.replace(/[<>:"|?*]/g, '-').replace(/[\x00-\x1f]/g, '-').slice(0, 200) || 'video';
    let objectUrl: string | null = null;
    setIsReadingMedia(true);
    try {
      objectUrl = URL.createObjectURL(file);
      const metadata = await probeBrowserVideo(objectUrl);
      const timeBase = targetAsset?.streams.video?.timeBase ?? metadata.timeBase;
      const videoStream: StreamInfo = {
        timeBase,
        durationTicks: targetAsset
          ? Math.round(metadata.durationSeconds * timeBase.denominator / timeBase.numerator)
          : metadata.durationTicks,
        width: metadata.width,
        height: metadata.height,
        metadataSource: 'browser',
      };
      const asset: MediaAsset = targetAsset
        ? {
          ...targetAsset,
          name: safeFileName,
          sourcePath: safeFileName,
          pathKind: 'browser-session',
          fileSizeBytes: file.size,
          streams: { ...targetAsset.streams, video: videoStream },
        }
        : {
          id: crypto.randomUUID(),
          name: safeFileName,
          sourcePath: safeFileName,
          pathKind: 'browser-session',
          kind: 'video',
          streams: { video: videoStream },
          fileSizeBytes: file.size,
        };
      const updatedDocument: ProjectDocument = {
        ...projectDocument,
        metadata: { ...projectDocument.metadata, modifiedAt: new Date().toISOString() },
        assets: targetAsset
          ? projectDocument.assets.map((entry) => entry.id === targetAsset.id ? asset : entry)
          : [...projectDocument.assets, asset],
      };
      serializeProjectDocument(updatedDocument); // Validate before changing either persisted project store.

      const key = mediaKey(projectId!, asset.id);
      const oldUrl = sessionSourcesRef.current[key]?.url;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      const nextSources = { ...sessionSourcesRef.current, [key]: { url: objectUrl, name: safeFileName } };
      sessionSourcesRef.current = nextSources;
      setSessionSources(nextSources);
      setDocuments((current) => current.map((entry) => entry.id === projectId ? updatedDocument : entry));
      setProjects((current) => current.map((entry) => entry.id === projectId ? { ...entry, updatedAt: updatedDocument.metadata.modifiedAt } : entry));
      setSelectedMediaKey(key);
      objectUrl = null; // The session source registry now owns the URL and revokes it on replacement/unmount.
      notify(`Metadata read · ${safeFileName} · ${metadata.width} × ${metadata.height} · ${metadata.durationSeconds.toFixed(2)} s.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read video metadata in this browser.', 'error');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPendingRelinkAssetId(null);
      setIsReadingMedia(false);
    }
  }

  function applyTimelineEdit(projectId: string, edit: (document: ProjectDocument) => ProjectDocument, successMessage: string) {
    if (persistenceWarning) {
      notify('Resolve project storage before editing the timeline.', 'error');
      return false;
    }
    const currentDocument = documents.find((document) => document.id === projectId);
    if (!currentDocument) {
      notify('The active project document is unavailable; the timeline was not changed.', 'error');
      return false;
    }
    try {
      const sequenceId = currentDocument.projectSettings.defaultSequenceId;
      const previousSequence = currentDocument.sequences.find((sequence) => sequence.id === sequenceId);
      const updatedDocument = edit(currentDocument);
      const updatedSequence = updatedDocument.sequences.find((sequence) => sequence.id === sequenceId);
      if (!previousSequence || !updatedSequence) throw new Error('The default sequence could not be updated.');
      serializeProjectDocument(updatedDocument);
      setTimelineHistory((current) => {
        const history = current[projectId] ?? { past: [], future: [] };
        return { ...current, [projectId]: { past: [...history.past, previousSequence].slice(-50), future: [] } };
      });
      setDocuments((current) => current.map((document) => document.id === projectId ? updatedDocument : document));
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, updatedAt: updatedDocument.metadata.modifiedAt } : project));
      notify(successMessage);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The timeline edit could not be applied.', 'error');
      return false;
    }
  }

  function addVideoToTimeline(assetId: string) {
    if (!activeProjectId) return null;
    const clipId = crypto.randomUUID();
    const applied = applyTimelineEdit(activeProjectId, (document) => appendVideoClip(document, document.projectSettings.defaultSequenceId, assetId, clipId), 'Added video source to the timeline.');
    return applied ? clipId : null;
  }

  function moveTimelineClip(clipId: string, startFrame: number) {
    if (!activeProjectId) return false;
    return applyTimelineEdit(activeProjectId, (document) => moveVideoClip(document, document.projectSettings.defaultSequenceId, clipId, startFrame), 'Updated clip position.');
  }

  function deleteTimelineClip(clipId: string) {
    if (!activeProjectId) return false;
    return applyTimelineEdit(activeProjectId, (document) => removeVideoClip(document, document.projectSettings.defaultSequenceId, clipId), 'Removed clip from the timeline.');
  }

  function trimTimelineClip(clipId: string, sourceInTick: number, sourceOutTick: number) {
    if (!activeProjectId) return false;
    return applyTimelineEdit(activeProjectId, (document) => trimVideoClip(document, document.projectSettings.defaultSequenceId, clipId, sourceInTick, sourceOutTick), 'Updated source trim.');
  }

  function changeTimelineHistory(projectId: string | null, direction: 'undo' | 'redo') {
    if (!projectId || persistenceWarning) return false;
    const currentDocument = documents.find((document) => document.id === projectId);
    const history = timelineHistory[projectId];
    if (!currentDocument || !history) return false;
    const sequenceId = currentDocument.projectSettings.defaultSequenceId;
    const currentSequence = currentDocument.sequences.find((sequence) => sequence.id === sequenceId);
    const source = direction === 'undo' ? history.past : history.future;
    const targetSequence = source[source.length - 1];
    if (!currentSequence || !targetSequence) return false;
    const updatedDocument: ProjectDocument = {
      ...currentDocument,
      metadata: { ...currentDocument.metadata, modifiedAt: new Date().toISOString() },
      sequences: currentDocument.sequences.map((sequence) => sequence.id === sequenceId ? targetSequence : sequence),
    };
    try {
      serializeProjectDocument(updatedDocument);
      setTimelineHistory((current) => {
        const latest = current[projectId] ?? history;
        return {
          ...current,
          [projectId]: direction === 'undo'
            ? { past: latest.past.slice(0, -1), future: [...latest.future, currentSequence] }
            : { past: [...latest.past, currentSequence].slice(-50), future: latest.future.slice(0, -1) },
        };
      });
      setDocuments((current) => current.map((document) => document.id === projectId ? updatedDocument : document));
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, updatedAt: updatedDocument.metadata.modifiedAt } : project));
      notify(direction === 'undo' ? 'Undid the last timeline change.' : 'Redid the timeline change.');
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Timeline history could not be restored.', 'error');
      return false;
    }
  }

  function undoTimelineEdit() { return changeTimelineHistory(activeProjectId, 'undo'); }
  function redoTimelineEdit() { return changeTimelineHistory(activeProjectId, 'redo'); }

  function createNewProject(name: string, ratio: AspectRatio, fps: Project['frameRate']) {
    if (storageWarning || documentStorageWarning) {
      notify('Resolve the project storage warning before creating a project.', 'error');
      return;
    }
    try {
      const project = createProject(name, ratio, fps);
      const document = createProjectDocument(project);
      setDocuments((current) => [...current.filter((item) => item.id !== project.id), document]);
      setProjects((current) => [project, ...current]);
      setActiveProjectId(project.id);
      setWorkspace('editor');
      setShowCreate(false);
      notify(`Created “${project.name}”.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create the project.', 'error');
    }
  }

  function startFreshProjectList() {
    if (storageWarning === 'storage-unavailable') {
      notify('Browser storage is unavailable. Existing data was not changed.', 'error');
      return;
    }
    const confirmed = window.confirm('Keep a recovery copy of the unreadable project-list data and start with an empty list? This does not touch media files.');
    if (!confirmed) return;
    try {
      const raw = window.localStorage.getItem(PROJECTS_KEY);
      if (raw) window.localStorage.setItem(`${PROJECTS_KEY}.recovery`, raw);
      window.localStorage.setItem(PROJECTS_KEY, '[]');
      setProjects([]);
      setStorageWarning(null);
      notify('Recovery copy preserved. Started a new empty project list.');
    } catch {
      notify('Could not create a recovery copy. Existing data was left untouched.', 'error');
    }
  }

  function startFreshDocumentStore() {
    if (documentStorageWarning === 'storage-unavailable') {
      notify('Browser storage is unavailable. Existing project documents were not changed.', 'error');
      return;
    }
    const confirmed = window.confirm('Preserve a recovery copy of the unreadable project documents and rebuild empty documents from the project list? Existing source media will not be touched.');
    if (!confirmed) return;
    try {
      const raw = window.localStorage.getItem(PROJECT_DOCUMENTS_KEY);
      if (raw) window.localStorage.setItem(`${PROJECT_DOCUMENTS_KEY}.recovery`, raw);
      const rebuilt = projects.map((project) => migrateLegacyProjectEntry(project));
      window.localStorage.setItem(PROJECT_DOCUMENTS_KEY, JSON.stringify(rebuilt));
      setDocuments(rebuilt);
      setDocumentStorageWarning(null);
      notify('Recovery copy preserved. Empty project documents rebuilt from the project list.');
    } catch {
      notify('Could not create a recovery copy. Existing project data was left untouched.', 'error');
    }
  }

  function downloadProjectFile(project: Project) {
    try {
      if (documentStorageWarning) throw new Error('Project document storage needs attention. Recover it before downloading to avoid exporting an incomplete document.');
      const document = documents.find((item) => item.id === project.id);
      if (!document) throw new Error('No validated project document is available for this project.');
      const contents = serializeProjectDocument(document);
      const objectUrl = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
      const link = window.document.createElement('a');
      const safeName = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'ClipWright-project';
      link.href = objectUrl;
      link.download = `${safeName}.cwproject`;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      notify(`Downloaded ${safeName}.cwproject. Source media is not included.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create the project file.', 'error');
    }
  }

  function requestProjectFile() {
    if (persistenceWarning) {
      notify('Resolve the project storage warning before opening a project file.', 'error');
      return;
    }
    projectFileInputRef.current?.click();
  }

  async function importProjectFile(file: File | null) {
    if (!file) return;
    if (storageWarning || documentStorageWarning) {
      notify('Resolve the project storage warning before importing a project file.', 'error');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      notify('Project file exceeds the 25 MB safety limit.', 'error');
      return;
    }
    try {
      const incomingDocument = parseProjectDocument(await file.text());
      const sequence = incomingDocument.sequences.find((item) => item.id === incomingDocument.projectSettings.defaultSequenceId);
      if (!sequence) throw new Error('The project file does not contain its declared default sequence.');
      const idConflict = projects.some((project) => project.id === incomingDocument.id) || documents.some((document) => document.id === incomingDocument.id);
      const projectId = idConflict ? crypto.randomUUID() : incomingDocument.id;
      const importedDocument = projectId === incomingDocument.id ? incomingDocument : { ...incomingDocument, id: projectId };
      const project: Project = {
        id: projectId,
        name: incomingDocument.metadata.name,
        createdAt: incomingDocument.metadata.createdAt,
        updatedAt: incomingDocument.metadata.modifiedAt,
        aspectRatio: aspectRatioOf(sequence.width, sequence.height),
        frameRate: sequence.frameRate.numerator / sequence.frameRate.denominator,
        archived: false,
        favorite: false,
      };
      setProjects((current) => [project, ...current]);
      setDocuments((current) => [...current, importedDocument]);
      setActiveProjectId(project.id);
      setWorkspace('editor');
      notify(idConflict ? 'Opened as a separate project copy to protect the existing project.' : `Opened “${project.name}”.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open this project file.', 'error');
    }
  }

  function openProject(project: Project) {
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, updatedAt: new Date().toISOString() } : item));
    setActiveProjectId(project.id);
    setWorkspace('editor');
  }

  function updateProject(id: string, patch: Partial<Project>): boolean {
    if (patch.name && documentStorageWarning) {
      notify('Recover project-document storage before renaming this project.', 'error');
      return false;
    }
    const updatedAt = new Date().toISOString();
    setProjects((current) => current.map((project) => project.id === id ? { ...project, ...patch, updatedAt } : project));
    if (patch.name) setDocuments((current) => current.map((document) => document.id === id ? { ...document, metadata: { ...document.metadata, name: patch.name!.trim(), modifiedAt: updatedAt } } : document));
    return true;
  }

  function duplicateProject(project: Project) {
    if (documentStorageWarning) {
      notify('Recover project-document storage before duplicating this project.', 'error');
      return;
    }
    const sourceDocument = documents.find((document) => document.id === project.id);
    if (!sourceDocument) {
      notify('This project has no validated document to duplicate.', 'error');
      return;
    }
    const now = new Date().toISOString();
    const copy = { ...project, id: crypto.randomUUID(), name: `${project.name} copy`, createdAt: now, updatedAt: now, favorite: false, archived: false };
    setProjects((current) => [copy, ...current]);
    setDocuments((current) => [...current, { ...sourceDocument, id: copy.id, metadata: { ...sourceDocument.metadata, name: copy.name, createdAt: now, modifiedAt: now } }]);
    notify('Project document duplicated. Source media is referenced, not copied.');
  }

  function deleteProject(project: Project) {
    const confirmed = window.confirm(`Delete “${project.name}” from this project list? This removes only its local project entry; it does not delete source media.`);
    if (!confirmed) return;
    setProjects((current) => current.filter((item) => item.id !== project.id));
    const removedDocument = documents.find((document) => document.id === project.id);
    if (removedDocument) {
      for (const asset of removedDocument.assets) {
        const key = mediaKey(project.id, asset.id);
        const source = sessionSourcesRef.current[key];
        if (source) URL.revokeObjectURL(source.url);
      }
      const nextSources = { ...sessionSourcesRef.current };
      for (const asset of removedDocument.assets) delete nextSources[mediaKey(project.id, asset.id)];
      sessionSourcesRef.current = nextSources;
      setSessionSources(nextSources);
    }
    setDocuments((current) => current.filter((document) => document.id !== project.id));
    setTimelineHistory((current) => { const next = { ...current }; delete next[project.id]; return next; });
    if (activeProjectId === project.id) { setActiveProjectId(null); setWorkspace('home'); }
    if (removedDocument?.assets.some((asset) => mediaKey(project.id, asset.id) === selectedMediaKey)) setSelectedMediaKey(null);
    notify('Project entry deleted. Source media was left untouched.');
  }

  const navigate = (next: Workspace) => {
    setWorkspace(next);
    if (next !== 'editor') setActiveProjectId(null);
  };

  const pageTitle = workspace === 'home' ? 'Projects' : workspace === 'clipping' ? 'AI Clipping' : activeProject?.name ?? 'Editor';

  return (
    <div className="app-shell" data-testid="app-shell">
      <aside className="rail">
        <button className="brand-lockup" onClick={() => navigate('home')} aria-label="ClipWright Studio home" title="ClipWright Studio">
          <img src="/assets/clipwright-icon.png" alt="" />
        </button>
        <div className="rail-divider" />
        <nav className="primary-nav" aria-label="Primary navigation">
          {workspaceItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${workspace === id ? 'is-active' : ''}`} onClick={() => navigate(id)} aria-current={workspace === id ? 'page' : undefined}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-spacer" />
        <div className="rail-bottom">
          <button className="nav-item subtle" onClick={() => setShowTasks(true)}><Clock3 size={18} /><span>Tasks</span></button>
          <button className="nav-item subtle" onClick={() => setShowSettings(true)}><Settings2 size={18} /><span>Settings</span></button>
          <div className="local-badge"><span className="status-dot" />Local workspace</div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="brand-title"><span className="wordmark">ClipWright</span><span className="brand-studio">STUDIO</span><span className="version-tag">EARLY ACCESS</span></div>
          <div className="topbar-actions">
            {workspace === 'home' && <div className="top-search"><Search size={15} /><input aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></div>}
            <button className="icon-button" aria-label="Open command palette" title="Command palette (Ctrl+K)" onClick={() => setShowCommands(true)}><Command size={17} /></button>
            <button className="icon-button task-button" aria-label="Task centre" title="Task centre" onClick={() => setShowTasks(true)}><Clock3 size={17} /></button>
            <button className="icon-button" aria-label="Help and project status" title="Project status and help" onClick={() => notify('This foundation build runs locally; editing and AI services are not connected yet.', 'error')}><CircleHelp size={17} /></button>
          </div>
        </header>
        <div className="workspace-head">
          <div className="breadcrumb">
            {workspace !== 'home' && <button className="back-button" onClick={() => navigate('home')} aria-label="Back to projects"><ArrowLeft size={16} /></button>}
            <span className="crumb-muted">Workspace</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong>
          </div>
          <div className="head-status"><span className={`status-dot ${persistenceWarning ? 'status-warning' : ''}`} />{persistenceWarning ? 'Storage needs attention' : 'All changes saved locally'}</div>
        </div>

        <main className={`content-area ${workspace === 'editor' ? 'content-area-editor' : ''}`}>
          {workspace === 'home' && (
            <section className="dashboard-view">
              <div className="welcome-row">
                <div><div className="eyebrow">YOUR CREATIVE WORKSPACE</div><h1>Projects</h1><p className="page-description">Pick up where you left off, or start something new.</p></div>
                <div className="welcome-actions"><button className="button button-secondary" onClick={requestProjectFile} disabled={!!persistenceWarning} title={persistenceWarning ? 'Resolve the storage warning before opening projects' : undefined}><Upload size={15} />Open project file</button><button className="button button-primary" onClick={() => setShowCreate(true)} disabled={!!persistenceWarning} title={persistenceWarning ? 'Resolve the storage warning before creating projects' : undefined}><Plus size={17} />New project</button></div>
              </div>
              {persistenceWarning && <div className="storage-warning" role="alert"><div><strong>{storageWarning === 'invalid-data' ? 'Project list could not be read' : documentStorageWarning === 'invalid-data' ? 'Project documents could not be read' : 'Browser storage is unavailable'}</strong><p>{storageWarning === 'invalid-data' ? 'The existing list has not been overwritten. Preserve a recovery copy before starting over.' : documentStorageWarning === 'invalid-data' ? 'The existing documents have not been overwritten. Recovery will rebuild empty documents from your project list.' : 'This browser profile cannot currently save all project data.'}</p></div>{storageWarning === 'invalid-data' ? <button className="button button-secondary button-small" onClick={startFreshProjectList}>Preserve & start fresh</button> : !storageWarning && documentStorageWarning === 'invalid-data' ? <button className="button button-secondary button-small" onClick={startFreshDocumentStore}>Preserve & rebuild</button> : null}</div>}
              <div className="dashboard-tools">
                <div className="project-tabs" role="tablist" aria-label="Project filters">
                  <button role="tab" aria-selected={!showArchived} className={!showArchived ? 'selected' : ''} onClick={() => setShowArchived(false)}>Recent <span className="tab-count">{projects.filter((p) => !p.archived).length}</span></button>
                  <button role="tab" aria-selected={showArchived} className={showArchived ? 'selected' : ''} onClick={() => setShowArchived(true)}>Archived <span className="tab-count">{projects.filter((p) => p.archived).length}</span></button>
                </div>
                <button className="filter-button" onClick={() => setShowArchived((value) => !value)} title="Toggle archived projects"><ListFilter size={15} /><span>{showArchived ? 'Show recent' : 'Filter'}</span><ChevronDown size={13} /></button>
              </div>
              {visibleProjects.length > 0 ? (
                <div className="project-grid">
                  {visibleProjects.map((project, index) => <ProjectCard key={project.id} project={project} index={index} onOpen={() => openProject(project)} onRename={() => {
                    const name = window.prompt('Rename project', project.name);
                    if (name?.trim() && updateProject(project.id, { name: name.trim() })) notify('Project renamed.');
                  }} onDuplicate={() => duplicateProject(project)} onArchive={() => { updateProject(project.id, { archived: !project.archived }); notify(project.archived ? 'Project restored.' : 'Project archived.'); }} onFavorite={() => updateProject(project.id, { favorite: !project.favorite })} onDelete={() => deleteProject(project)} onDownload={() => downloadProjectFile(project)} />)}
                </div>
              ) : query ? (
                <div className="empty-state compact-empty"><div className="empty-icon"><Search size={20} /></div><h2>No projects found</h2><p>Try another search term or clear the search.</p><button className="button button-secondary" onClick={() => setQuery('')}>Clear search</button></div>
              ) : showArchived ? (
                <div className="empty-state compact-empty"><div className="empty-icon"><Archive size={20} /></div><h2>No archived projects</h2><p>Archived project entries will appear here. Source media is never removed by archiving.</p></div>
              ) : (
                <div className="empty-state">
                  <div className="empty-art"><div className="art-window"><div className="art-topline" /><div className="art-preview"><Film size={28} strokeWidth={1.2} /></div><div className="art-timeline"><i /><i /><i /></div></div><span className="art-spark spark-one" /><span className="art-spark spark-two" /></div>
                  <div className="eyebrow">A CLEAR START</div><h2>Make room for your next story.</h2><p>Create a project to begin. Your workspace stays on this device, and your original media remains untouched.</p>
                  <button className="button button-primary" onClick={() => setShowCreate(true)} disabled={!!persistenceWarning} title={persistenceWarning ? 'Resolve the storage warning before creating projects' : undefined}><Plus size={17} />Create your first project</button>
                  <span className="empty-footnote"><HardDrive size={13} />Project list stored in this browser profile</span>
                </div>
              )}
              <div className="dashboard-footer"><div><span className="footer-label">WORKSPACE</span><strong>Local-first</strong><span> · Your files stay on this device</span></div><button onClick={() => setShowSettings(true)}>Preferences <ArrowRight size={13} /></button></div>
            </section>
          )}

          {workspace === 'editor' && <EditorFoundation
            project={activeProject}
            projectDocument={documents.find((document) => document.id === activeProjectId) ?? null}
            sessionSources={sessionSources}
            selectedMediaKey={selectedMediaKey}
            isReadingMedia={isReadingMedia}
            onBack={() => navigate('home')}
            onImportVideo={() => requestVideoImport()}
            onRelinkVideo={(assetId) => requestVideoImport(assetId)}
            onSelectMedia={setSelectedMediaKey}
            onAddVideo={addVideoToTimeline}
            onMoveClip={moveTimelineClip}
            onTrimClip={trimTimelineClip}
            onRemoveClip={deleteTimelineClip}
            canUndo={Boolean(!persistenceWarning && activeProjectId && timelineHistory[activeProjectId]?.past.length)}
            canRedo={Boolean(!persistenceWarning && activeProjectId && timelineHistory[activeProjectId]?.future.length)}
            onUndo={undoTimelineEdit}
            onRedo={redoTimelineEdit}
            onPlaybackError={() => notify('Browser playback failed. The file may use a codec this browser cannot decode.', 'error')}
          />}
          {workspace === 'clipping' && <ClippingFoundation onCreate={() => setShowCreate(true)} />}
        </main>
      </div>

      <input ref={projectFileInputRef} hidden type="file" accept=".cwproject,application/json" aria-label="Choose a ClipWright project file" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importProjectFile(file); }} />
      <input ref={videoFileInputRef} hidden type="file" accept="video/*,.mp4,.m4v,.mov,.webm,.ogv,.avi" aria-label="Choose a local video file" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importVideoFile(file); }} />
      {showCreate && <CreateProjectDialog onClose={() => setShowCreate(false)} onCreate={createNewProject} />}
      {showSettings && <SettingsDialog theme={theme} onTheme={setTheme} onClose={() => setShowSettings(false)} />}
      {showCommands && <CommandDialog inputRef={searchRef} onClose={() => setShowCommands(false)} actions={[
        { label: 'Create a new project', shortcut: 'Ctrl+N', icon: FilePlus2, run: () => { setShowCommands(false); if (persistenceWarning) notify('Resolve the project storage warning before creating a project.', 'error'); else setShowCreate(true); } },
        { label: 'Open a project file', icon: Upload, run: () => { setShowCommands(false); requestProjectFile(); } },
        { label: 'Go to Projects', shortcut: 'G then P', icon: Home, run: () => { navigate('home'); setShowCommands(false); } },
        { label: 'Open AI Clipping', icon: Sparkles, run: () => { navigate('clipping'); setShowCommands(false); } },
        { label: 'Open Editor workspace', icon: Clapperboard, run: () => { if (activeProject) setWorkspace('editor'); else notify('Create or open a project before entering the editor.', 'error'); setShowCommands(false); } },
        { label: 'Open Task Centre', icon: Clock3, run: () => { setShowCommands(false); setShowTasks(true); } },
        { label: 'Open Preferences', icon: Settings2, run: () => { setShowCommands(false); setShowSettings(true); } },
      ]} />}
      {showTasks && <TaskDrawer onClose={() => setShowTasks(false)} />}
      {toast && <div className={`toast ${toast.kind === 'error' ? 'toast-error' : ''}`} role="status"><span className="toast-mark">{toast.kind === 'error' ? '!' : <Check size={14} />}</span>{toast.message}<button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function ProjectCard({ project, index, onOpen, onRename, onDuplicate, onArchive, onFavorite, onDelete, onDownload }: { project: Project; index: number; onOpen: () => void; onRename: () => void; onDuplicate: () => void; onArchive: () => void; onFavorite: () => void; onDelete: () => void; onDownload: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <article className="project-card" style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}>
    <button className={`project-thumb thumb-${index % 4}`} onClick={onOpen} aria-label={`Open ${project.name}`}>
      <span className="thumb-frame"><Film size={24} strokeWidth={1.25} /></span><span className="thumb-empty">No media yet</span>
      <span className="aspect-pill">{project.aspectRatio}</span>
    </button>
    <div className="project-card-info">
      <div className="project-name-row"><button className="project-name" onClick={onOpen}>{project.name}</button>{project.favorite && <Heart size={13} fill="currentColor" className="favorite-mark" />}</div>
      <div className="project-meta">Edited {readableDate(project.updatedAt)} <span>·</span> {formatFrameRate(project.frameRate)}</div>
    </div>
    <button className="card-menu-trigger" aria-label={`More actions for ${project.name}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
    {menuOpen && <><button className="click-away" aria-label="Close project menu" onClick={() => setMenuOpen(false)} /><div className="project-menu">
      <button onClick={() => { onOpen(); setMenuOpen(false); }}><FolderOpen size={14} />Open project</button>
      <button onClick={() => { onRename(); setMenuOpen(false); }}><FilePlus2 size={14} />Rename</button>
      <button onClick={() => { onDuplicate(); setMenuOpen(false); }}><Grid2X2 size={14} />Duplicate project</button>
      <button onClick={() => { onDownload(); setMenuOpen(false); }}><Download size={14} />Download .cwproject</button>
      <button onClick={() => { onFavorite(); setMenuOpen(false); }}><Heart size={14} />{project.favorite ? 'Remove favourite' : 'Add to favourites'}</button>
      <button onClick={() => { onArchive(); setMenuOpen(false); }}><Archive size={14} />{project.archived ? 'Restore' : 'Archive'}</button>
      <div className="menu-divider" /><button className="danger-item" onClick={() => { onDelete(); setMenuOpen(false); }}><Trash2 size={14} />Delete entry</button>
    </div></>}
  </article>;
}

function CreateProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, ratio: AspectRatio, fps: Project['frameRate']) => void }) {
  const [name, setName] = useState('');
  const [ratio, setRatio] = useState<AspectRatio>('16:9');
  const [fps, setFps] = useState<Project['frameRate']>(30);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => { fieldRef.current?.focus(); }, []);
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <div className="dialog-head"><div className="dialog-icon"><FilePlus2 size={17} /></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button></div>
      <div className="eyebrow">NEW WORKSPACE</div><h2 id="create-title">Create a project</h2><p className="dialog-copy">Set up your sequence. You can change these settings later.</p>
      <form onSubmit={(event) => { event.preventDefault(); onCreate(name, ratio, fps); }}>
        <label className="field-label" htmlFor="project-name">Project name</label><input ref={fieldRef} id="project-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Summer campaign" maxLength={80} required />
        <div className="form-row"><div><label className="field-label" htmlFor="aspect-ratio">Aspect ratio</label><select id="aspect-ratio" className="select-input" value={ratio} onChange={(event) => setRatio(event.target.value as AspectRatio)}><option>16:9</option><option>9:16</option><option>1:1</option></select></div><div><label className="field-label" htmlFor="frame-rate">Frame rate</label><select id="frame-rate" className="select-input" value={fps} onChange={(event) => setFps(Number(event.target.value) as Project['frameRate'])}><option value={24}>24 fps</option><option value={25}>25 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></select></div></div>
        <div className="local-note"><HardDrive size={14} /><span>Project details are saved locally in this browser profile. No media is copied.</span></div>
        <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary"><Plus size={15} />Create project</button></div>
      </form>
    </section>
  </div>;
}

function EditorFoundation({
  project,
  projectDocument,
  sessionSources,
  selectedMediaKey,
  isReadingMedia,
  onBack,
  onImportVideo,
  onRelinkVideo,
  onSelectMedia,
  onAddVideo,
  onMoveClip,
  onTrimClip,
  onRemoveClip,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPlaybackError,
}: {
  project: Project | null;
  projectDocument: ProjectDocument | null;
  sessionSources: Record<string, SessionMediaSource>;
  selectedMediaKey: string | null;
  isReadingMedia: boolean;
  onBack: () => void;
  onImportVideo: () => void;
  onRelinkVideo: (assetId: string) => void;
  onSelectMedia: (key: string) => void;
  onAddVideo: (assetId: string) => string | null;
  onMoveClip: (clipId: string, timelineStartFrame: number) => boolean;
  onTrimClip: (clipId: string, sourceInTick: number, sourceOutTick: number) => boolean;
  onRemoveClip: (clipId: string) => boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onPlaybackError: () => void;
}) {
  const sequence = projectDocument?.sequences.find((item) => item.id === projectDocument.projectSettings.defaultSequenceId) ?? null;
  const ratio = sequence ? aspectRatioOf(sequence.width, sequence.height) : project?.aspectRatio ?? '16:9';
  const frameRate = sequence ? formatFrameRate(sequence.frameRate.numerator / sequence.frameRate.denominator) : formatFrameRate(project?.frameRate ?? 30);
  const assets = projectDocument?.assets ?? [];
  const playableAsset = assets.find((asset) => asset.kind === 'video' && mediaKey(projectDocument?.id ?? '', asset.id) === selectedMediaKey)
    ?? assets.find((asset) => asset.kind === 'video')
    ?? null;
  const activeKey = playableAsset && projectDocument ? mediaKey(projectDocument.id, playableAsset.id) : null;
  const source = activeKey ? sessionSources[activeKey] : undefined;
  const stream = playableAsset?.streams.video;
  const metadataDuration = stream ? stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator : 0;
  const videoTracks = sequence?.tracks.filter((track) => track.kind === 'video') ?? [];
  const audioTracks = sequence?.tracks.filter((track) => track.kind === 'audio') ?? [];
  const videoClips = videoTracks.flatMap((track) => track.clips.filter((clip): clip is VideoClip => clip.kind === 'video'));
  const [selectedTimelineClipId, setSelectedTimelineClipId] = useState<string | null>(null);
  const [timelinePlayheadFrame, setTimelinePlayheadFrame] = useState(0);
  const [timelineSyncClipId, setTimelineSyncClipId] = useState<string | null>(null);
  const pendingPreviewSeekRef = useRef<{ assetId: string; url: string | null; seconds: number } | null>(null);
  const selectedClip = videoClips.find((clip) => clip.id === selectedTimelineClipId) ?? null;
  const timelineSyncClip = videoClips.find((clip) => clip.id === timelineSyncClipId) ?? null;
  const selectedClipTrack = selectedClip ? videoTracks.find((track) => track.clips.some((clip) => clip.id === selectedClip.id)) : null;
  const selectedClipAsset = selectedClip ? assets.find((asset) => asset.id === selectedClip.assetId) : null;
  const frameRateValue = sequence ? sequence.frameRate.numerator / sequence.frameRate.denominator : project?.frameRate ?? 30;
  const editorLayoutRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineTrackHeaderRowsRef = useRef<HTMLDivElement>(null);
  const timelinePlayheadRef = useRef<HTMLDivElement>(null);
  const playheadPointerRef = useRef<number | null>(null);
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);
  const timelineHeightRef = useRef(280);
  const [editorLayoutSize, setEditorLayoutSize] = useState({ width: 0, height: 0 });
  const [timelineHeight, setTimelineHeight] = useState(readTimelineHeight);
  const [timelineZoom, setTimelineZoom] = useState(readTimelineZoom);
  timelineHeightRef.current = timelineHeight;
  const sequenceDurationFrames = sequence ? Math.max(sequence.durationFrames, sequenceDurationInFrames(sequence)) : 0;
  const timelineVisibleFrames = Math.max(sequenceDurationFrames, Math.ceil(frameRateValue * 20));
  const timelineHeaderWidth = 150;
  const timelineViewportWidth = Math.max(350, editorLayoutSize.width ? editorLayoutSize.width - 26 : Math.min(1_600, window.innerWidth - 260));
  const timelineAvailableWidth = Math.max(200, timelineViewportWidth - timelineHeaderWidth);
  const timelinePixelsPerFrame = Math.max(0.001, timelineAvailableWidth / timelineVisibleFrames * timelineZoom);
  const timelineCanvasFrames = Math.max(timelineVisibleFrames, Math.ceil(timelineAvailableWidth / timelinePixelsPerFrame));
  const timelineContentWidth = Math.min(119_850, Math.max(200, Math.ceil(timelineCanvasFrames * timelinePixelsPerFrame)));
  const tickSeconds = niceRulerIntervalSeconds(80 / Math.max(0.001, timelinePixelsPerFrame * frameRateValue));
  const tickInterval = Math.max(1, Math.round(frameRateValue * tickSeconds));
  const timelineTicks = Array.from({ length: Math.min(2_000, Math.floor(timelineCanvasFrames / tickInterval) + 1) }, (_, index) => index * tickInterval);
  const timelineMaxHeight = Math.max(TIMELINE_MIN_HEIGHT, Math.min(720, Math.floor((editorLayoutSize.height || 600) * 0.7), (editorLayoutSize.height || 600) - 246));
  const effectiveTimelineHeight = Math.max(TIMELINE_MIN_HEIGHT, Math.min(timelineHeight, timelineMaxHeight));
  const [startFrameDraft, setStartFrameDraft] = useState('0');
  const [sourceInDraft, setSourceInDraft] = useState('0');
  const [sourceOutDraft, setSourceOutDraft] = useState('0');
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [playbackError, setPlaybackError] = useState(false);
  const timelineSyncTimeBase = assets.find((item) => item.id === timelineSyncClip?.assetId)?.streams.video?.timeBase;
  const previewSeekMin = timelineSyncClip && timelineSyncTimeBase
    ? timelineSyncClip.sourceInTick * timelineSyncTimeBase.numerator / timelineSyncTimeBase.denominator
    : 0;
  const previewSeekMax = timelineSyncClip && timelineSyncTimeBase
    ? timelineSyncClip.sourceOutTick * timelineSyncTimeBase.numerator / timelineSyncTimeBase.denominator
    : duration;
  const previewSeekValue = Math.max(previewSeekMin, Math.min(currentTime, previewSeekMax || currentTime));

  useEffect(() => {
    const element = editorLayoutRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setEditorLayoutSize({ width: Math.ceil(entry.contentRect.width), height: Math.ceil(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setStartFrameDraft(String(selectedClip?.timelineStartFrame ?? 0));
    const timeBase = selectedClipAsset?.streams.video?.timeBase;
    setSourceInDraft(selectedClip && timeBase ? formatSourceSeconds(selectedClip.sourceInTick, timeBase) : '0');
    setSourceOutDraft(selectedClip && timeBase ? formatSourceSeconds(selectedClip.sourceOutTick, timeBase) : '0');
  }, [selectedClip?.id, selectedClip?.timelineStartFrame, selectedClip?.sourceInTick, selectedClip?.sourceOutTick, selectedClipAsset?.streams.video?.timeBase.numerator, selectedClipAsset?.streams.video?.timeBase.denominator]);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(metadataDuration);
    setIsPlaying(false);
    setPlaybackError(false);
    videoRef.current?.pause();
  }, [source?.url, metadataDuration]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, source?.url]);

  useEffect(() => {
    if (!videoRef.current) return;
    const rate = timelineSyncClip
      ? timelineSyncClip.playbackRate.numerator / timelineSyncClip.playbackRate.denominator
      : 1;
    videoRef.current.playbackRate = rate;
  }, [timelineSyncClip?.id, timelineSyncClip?.playbackRate.numerator, timelineSyncClip?.playbackRate.denominator, source?.url]);

  useEffect(() => {
    if (!isPlaying || !timelineSyncClip) return;
    const syncAsset = assets.find((item) => item.id === timelineSyncClip.assetId);
    const timeBase = syncAsset?.streams.video?.timeBase;
    if (!timeBase) return;
    let animationFrame = 0;
    let lastReadoutUpdate = 0;
    const sourceInSeconds = timelineSyncClip.sourceInTick * timeBase.numerator / timeBase.denominator;
    const playbackRate = timelineSyncClip.playbackRate.numerator / timelineSyncClip.playbackRate.denominator;
    const clipEndFrame = timelineSyncClip.timelineStartFrame + timelineSyncClip.timelineDurationFrames;
    const animatePlayhead = (now: number) => {
      const video = videoRef.current;
      const playhead = timelinePlayheadRef.current;
      if (video && playhead) {
        const elapsed = Math.max(0, video.currentTime - sourceInSeconds) / playbackRate * frameRateValue;
        const frame = Math.min(clipEndFrame, timelineSyncClip.timelineStartFrame + elapsed);
        playhead.style.transform = `translateX(${frame * timelinePixelsPerFrame}px)`;
        if (now - lastReadoutUpdate >= 100) {
          setTimelinePlayheadFrame(Math.floor(frame));
          lastReadoutUpdate = now;
        }
      }
      animationFrame = window.requestAnimationFrame(animatePlayhead);
    };
    animationFrame = window.requestAnimationFrame(animatePlayhead);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isPlaying, timelineSyncClip?.id, timelineSyncClip?.timelineStartFrame, timelineSyncClip?.timelineDurationFrames, timelineSyncClip?.sourceInTick, timelineSyncClip?.playbackRate.numerator, timelineSyncClip?.playbackRate.denominator, frameRateValue, timelinePixelsPerFrame]);

  function seekBy(seconds: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const minimum = timelineSyncClip ? previewSeekMin : 0;
    const maximum = Math.min(video.duration, previewSeekMax || video.duration);
    video.currentTime = Math.max(minimum, Math.min(maximum, video.currentTime + seconds));
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (timelineSyncClip && video.currentTime >= previewSeekMax - 0.05) {
        video.currentTime = previewSeekMin;
        setCurrentTime(previewSeekMin);
        setTimelinePlayheadFrame(timelineSyncClip.timelineStartFrame);
      }
      void video.play().catch(() => { setPlaybackError(true); onPlaybackError(); });
    } else video.pause();
  }

  function seekTimelineFrame(requestedFrame: number) {
    if (!sequence) return;
    const frame = Math.max(0, Math.min(timelineCanvasFrames, Math.round(requestedFrame)));
    setTimelinePlayheadFrame(frame);
    if (timelinePlayheadRef.current) timelinePlayheadRef.current.style.transform = `translateX(${frame * timelinePixelsPerFrame}px)`;
    const clip = videoClips.find((item) => frame >= item.timelineStartFrame && frame < item.timelineStartFrame + item.timelineDurationFrames);
    if (!clip || !projectDocument) {
      setTimelineSyncClipId(null);
      pendingPreviewSeekRef.current = null;
      videoRef.current?.pause();
      return;
    }

    setSelectedTimelineClipId(clip.id);
    setTimelineSyncClipId(clip.id);
    const asset = assets.find((item) => item.id === clip.assetId);
    const timeBase = asset?.streams.video?.timeBase;
    const targetSource = sessionSources[mediaKey(projectDocument.id, clip.assetId)];
    if (!timeBase) {
      pendingPreviewSeekRef.current = null;
      onSelectMedia(mediaKey(projectDocument.id, clip.assetId));
      return;
    }

    const sourceInSeconds = clip.sourceInTick * timeBase.numerator / timeBase.denominator;
    const playbackRate = clip.playbackRate.numerator / clip.playbackRate.denominator;
    const sourceSeconds = sourceInSeconds + (frame - clip.timelineStartFrame) / frameRateValue * playbackRate;
    pendingPreviewSeekRef.current = { assetId: clip.assetId, url: targetSource?.url ?? null, seconds: sourceSeconds };
    onSelectMedia(mediaKey(projectDocument.id, clip.assetId));
    if (!targetSource) return;
    const video = videoRef.current;
    if (source?.url === targetSource.url && video) {
      video.pause();
      video.playbackRate = playbackRate;
      video.currentTime = Math.max(0, Math.min(metadataDuration || sourceSeconds, sourceSeconds));
      setCurrentTime(video.currentTime);
      if (video.readyState >= 1 && Number.isFinite(video.duration)) pendingPreviewSeekRef.current = null;
    }
  }

  function seekTimelineAtClientX(clientX: number) {
    const canvas = timelineScrollRef.current?.querySelector('.timeline-canvas');
    if (!canvas) return;
    const frame = (clientX - canvas.getBoundingClientRect().left) / timelinePixelsPerFrame;
    seekTimelineFrame(frame);
  }

  function handleTimelineClick(event: React.MouseEvent<HTMLDivElement>) {
    seekTimelineAtClientX(event.clientX);
  }

  function beginPlayheadDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    playheadPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekTimelineAtClientX(event.clientX);
  }

  function movePlayheadDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (playheadPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    seekTimelineAtClientX(event.clientX);
  }

  function endPlayheadDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (playheadPointerRef.current !== event.pointerId) return;
    playheadPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handlePlayheadKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 10 : 1;
    const nextFrame = event.key === 'ArrowLeft' ? timelinePlayheadFrame - step
      : event.key === 'ArrowRight' ? timelinePlayheadFrame + step
        : event.key === 'Home' ? 0
          : event.key === 'End' ? timelineCanvasFrames
            : null;
    if (nextFrame === null) return;
    event.preventDefault();
    seekTimelineFrame(nextFrame);
  }

  function handlePreviewTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    setCurrentTime(video.currentTime);
    if (!timelineSyncClip || !sequence) return;
    const syncAsset = assets.find((item) => item.id === timelineSyncClip.assetId);
    const timeBase = syncAsset?.streams.video?.timeBase;
    if (!timeBase) return;
    const sourceInSeconds = timelineSyncClip.sourceInTick * timeBase.numerator / timeBase.denominator;
    const sourceOutSeconds = timelineSyncClip.sourceOutTick * timeBase.numerator / timeBase.denominator;
    const playbackRate = timelineSyncClip.playbackRate.numerator / timelineSyncClip.playbackRate.denominator;
    const elapsedSourceSeconds = Math.max(0, video.currentTime - sourceInSeconds);
    const frame = timelineSyncClip.timelineStartFrame + Math.round(elapsedSourceSeconds / playbackRate * frameRateValue);
    const clipEndFrame = timelineSyncClip.timelineStartFrame + timelineSyncClip.timelineDurationFrames;
    setTimelinePlayheadFrame(Math.min(clipEndFrame, frame));
    if (video.currentTime >= sourceOutSeconds - Math.max(0.005, 0.5 / frameRateValue)) {
      setTimelinePlayheadFrame(clipEndFrame);
      video.pause();
    }
  }

  function handlePreviewLoadedMetadata(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(nextDuration);
    const pending = pendingPreviewSeekRef.current;
    if (pending && pending.assetId === playableAsset?.id && (!pending.url || video.getAttribute('src') === pending.url)) {
      video.playbackRate = timelineSyncClip
        ? timelineSyncClip.playbackRate.numerator / timelineSyncClip.playbackRate.denominator
        : 1;
      video.currentTime = Math.max(0, Math.min(nextDuration || pending.seconds, pending.seconds));
      setCurrentTime(video.currentTime);
      pendingPreviewSeekRef.current = null;
    }
  }

  function selectTimelineClip(clip: VideoClip, event?: React.MouseEvent<HTMLButtonElement>) {
    setSelectedTimelineClipId(clip.id);
    const bounds = event?.currentTarget.getBoundingClientRect();
    const frame = event && bounds && bounds.width > 0
      ? clip.timelineStartFrame + (event.clientX - bounds.left) / timelinePixelsPerFrame
      : clip.timelineStartFrame;
    seekTimelineFrame(frame);
  }

  function selectMediaSource(key: string) {
    setTimelineSyncClipId(null);
    pendingPreviewSeekRef.current = null;
    if (videoRef.current) videoRef.current.playbackRate = 1;
    onSelectMedia(key);
  }

  function addSelectedSourceToTimeline() {
    if (!source || !playableAsset) return;
    const clipId = onAddVideo(playableAsset.id);
    if (clipId) setSelectedTimelineClipId(clipId);
  }

  function removeSelectedClip() {
    if (selectedClip && onRemoveClip(selectedClip.id)) setSelectedTimelineClipId(null);
  }

  function applyStartFrame() {
    if (!selectedClip || !/^\d+$/.test(startFrameDraft)) {
      setStartFrameDraft(String(selectedClip?.timelineStartFrame ?? 0));
      return;
    }
    const nextStartFrame = Number(startFrameDraft);
    if (!Number.isSafeInteger(nextStartFrame) || nextStartFrame < 0 || !onMoveClip(selectedClip.id, nextStartFrame)) {
      setStartFrameDraft(String(selectedClip.timelineStartFrame));
    }
  }

  function applySourceTrim() {
    const timeBase = selectedClipAsset?.streams.video?.timeBase;
    if (!selectedClip || !timeBase || !Number.isFinite(Number(sourceInDraft)) || !Number.isFinite(Number(sourceOutDraft))) return;
    const sourceInTick = Math.round(Number(sourceInDraft) * timeBase.denominator / timeBase.numerator);
    const sourceOutTick = Math.round(Number(sourceOutDraft) * timeBase.denominator / timeBase.numerator);
    if (!Number.isSafeInteger(sourceInTick) || !Number.isSafeInteger(sourceOutTick)
      || !onTrimClip(selectedClip.id, sourceInTick, sourceOutTick)) {
      setSourceInDraft(formatSourceSeconds(selectedClip.sourceInTick, timeBase));
      setSourceOutDraft(formatSourceSeconds(selectedClip.sourceOutTick, timeBase));
    }
  }

  function setWorkspaceTimelineHeight(nextHeight: number) {
    const next = Math.max(TIMELINE_MIN_HEIGHT, Math.min(timelineMaxHeight, Math.round(nextHeight)));
    timelineHeightRef.current = next;
    setTimelineHeight(next);
    storeTimelineHeight(next);
  }

  function beginTimelineResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStartRef.current = { y: event.clientY, height: effectiveTimelineHeight };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveTimelineResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    const next = Math.max(TIMELINE_MIN_HEIGHT, Math.min(timelineMaxHeight, resizeStartRef.current.height + resizeStartRef.current.y - event.clientY));
    timelineHeightRef.current = next;
    setTimelineHeight(next);
  }

  function endTimelineResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    storeTimelineHeight(timelineHeightRef.current);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleTimelineResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
      setWorkspaceTimelineHeight(event.key === 'Home' ? TIMELINE_MIN_HEIGHT : event.key === 'End' ? timelineMaxHeight : effectiveTimelineHeight + delta);
    }
  }

  function zoomTimeline(next: number, preserveAnchor = true) {
    const zoom = Math.max(0.25, Math.min(4, Number(next.toFixed(2))));
    const scroller = timelineScrollRef.current;
    const anchorFrame = scroller
      ? Math.max(0, (scroller.scrollLeft + scroller.clientWidth / 2) / timelinePixelsPerFrame)
      : 0;
    setTimelineZoom(zoom);
    storeTimelineZoom(zoom);
    if (scroller && preserveAnchor) window.requestAnimationFrame(() => {
      const nextPixelsPerFrame = timelineAvailableWidth / timelineVisibleFrames * zoom;
      scroller.scrollLeft = Math.max(0, anchorFrame * nextPixelsPerFrame - scroller.clientWidth / 2);
    });
  }

  function syncTimelineHeaderScroll(event: React.UIEvent<HTMLDivElement>) {
    if (timelineTrackHeaderRowsRef.current) {
      timelineTrackHeaderRowsRef.current.style.transform = `translateY(-${event.currentTarget.scrollTop}px)`;
    }
  }

  function fitTimelineToProject() {
    zoomTimeline(1, false);
    if (timelineScrollRef.current) timelineScrollRef.current.scrollLeft = 0;
  }

  return <section className="editor-foundation">
    <div className="editor-project-bar"><div><div className="eyebrow">EDITOR WORKSPACE</div><h1>{project?.name ?? 'No project selected'}</h1></div><div className="project-specs"><span>{project ? ratio : '—'}</span><span>{project ? frameRate : 'No sequence'}</span><span className="save-pill"><Check size={12} />Saved locally</span></div></div>
    <div className="editor-layout" ref={editorLayoutRef}>
      <aside className="editor-media-panel" aria-label="Project media">
        <div className="panel-title"><span>Project media</span><button className="icon-button small" title="Import a local video" aria-label="Import a local video" onClick={onImportVideo} disabled={isReadingMedia || !project}><Plus size={16} /></button></div>
        {assets.length ? <div className="media-asset-list" aria-label="Media assets">
          {assets.map((asset) => {
            const key = projectDocument ? mediaKey(projectDocument.id, asset.id) : '';
            const available = Boolean(sessionSources[key]);
            const isVideo = asset.kind === 'video' && Boolean(asset.streams.video);
            return <div className={`media-asset-row ${key === activeKey ? 'is-selected' : ''}`} key={asset.id}>
              <button className="media-asset-select" type="button" aria-pressed={key === activeKey} onClick={() => isVideo && selectMediaSource(key)} disabled={!isVideo} title={isVideo ? asset.name : 'Audio and image previews are not available in this build'}>
                <Film size={15} /><span className="media-asset-copy"><strong>{asset.name}</strong><small>{isVideo ? (available ? 'Ready in this session' : 'Relink required') : `${asset.kind} preview not supported`}</small></span>
              </button>
              {isVideo && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkVideo(asset.id)} disabled={isReadingMedia}>Relink</button>}
            </div>;
          })}
          <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportVideo} disabled={isReadingMedia || !project}><Plus size={13} />Add video</button>
        </div> : <div className="media-empty">
          <div className="media-icon"><Film size={20} /></div><strong>No media imported</strong><span>Choose a local video to read browser-reported metadata and preview supported formats.</span><button className="button button-secondary button-small" onClick={onImportVideo} disabled={isReadingMedia || !project}><Plus size={14} />Import video</button>
        </div>}
        {isReadingMedia && <div className="media-reading" role="status">Reading metadata in your browser…</div>}
        <div className="panel-footnote"><HardDrive size={12} />Original files stay in place; relink after reload</div>
      </aside>
      <div className="editor-center">
        <div className="preview-stage"><div className="preview-frame">
          {source ? <video
            ref={videoRef}
            className="preview-video"
            src={source.url}
            playsInline
            preload="metadata"
            aria-label={`${playableAsset?.name ?? source.name} source preview`}
            onLoadedMetadata={handlePreviewLoadedMetadata}
            onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
            onTimeUpdate={handlePreviewTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => {
              setIsPlaying(false);
              if (timelineSyncClip) setTimelinePlayheadFrame(timelineSyncClip.timelineStartFrame + timelineSyncClip.timelineDurationFrames);
            }}
            onError={() => { setPlaybackError(true); onPlaybackError(); }}
          /> : <><Film size={35} strokeWidth={1.15} /><span>{playableAsset ? 'Relink this source to preview it in the current session' : assets.length ? 'No supported video source is available to preview' : 'Choose a video to start source preview'}</span></>}
          {playbackError && <span className="preview-error" role="status">Browser playback failed for this source.</span>}
          <div className="preview-corner tl"/><div className="preview-corner tr"/><div className="preview-corner bl"/><div className="preview-corner br"/>
          <small>{sequence?.name ?? 'Sequence 01'} · {ratio} · {frameRate}</small>
        </div></div>
        <div className="preview-controls" aria-label={timelineSyncClip ? 'Timeline clip preview controls' : 'Source preview controls'}>
          <button className="transport-button" type="button" disabled={!source} title="Seek backward 5 seconds" aria-label="Seek backward 5 seconds" onClick={() => seekBy(-5)}><SkipBack size={15} /></button>
          <button className="play-button" type="button" disabled={!source} aria-label={isPlaying ? (timelineSyncClip ? 'Pause timeline clip preview' : 'Pause source preview') : (timelineSyncClip ? 'Play timeline clip preview' : 'Play source preview')} onClick={togglePlayback}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
          <button className="transport-button" type="button" disabled={!source} title="Seek forward 5 seconds" aria-label="Seek forward 5 seconds" onClick={() => seekBy(5)}><SkipForward size={15} /></button>
          <span className="time-readout">{formatPlaybackTime(currentTime)} <i>/</i> {formatPlaybackTime(duration)}</span>
          <input className="preview-seek" aria-label={timelineSyncClip ? 'Seek timeline clip preview' : 'Seek source video'} type="range" min={previewSeekMin} max={Math.max(previewSeekMin + 0.05, previewSeekMax || 1)} step="0.05" value={previewSeekValue} onChange={(event) => { if (videoRef.current) videoRef.current.currentTime = Number(event.target.value); }} disabled={!source || !duration} />
          <button className="volume-button" type="button" aria-label={volume > 0 ? 'Mute preview audio' : 'Unmute preview audio'} onClick={() => setVolume((value) => value > 0 ? 0 : 0.8)} disabled={!source}>{volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}</button>
          <input className="preview-volume" aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} disabled={!source} />
          <span className="preview-quality" title="Metadata is browser-reported. Playback and seeking depend on installed browser codecs and are not frame-accurate.">Browser preview</span>
        </div>

      </div>
      <aside className="properties-panel">
        <div className="panel-title">Properties</div>
        <div className="properties-body">
          {selectedClip ? <div className="property-section selected-clip-properties">
            <span className="panel-kicker">VIDEO CLIP</span>
            <strong className="selected-clip-name">{selectedClipAsset?.name ?? 'Video clip'}</strong>
            <div className="property-line"><span>Duration</span><strong>{selectedClip.timelineDurationFrames} frames</strong></div>
            <div className="property-line"><span>Source range</span><strong>{selectedClip.sourceInTick}–{selectedClip.sourceOutTick} ticks</strong></div>
            <form className="frame-position-form" onSubmit={(event) => { event.preventDefault(); applyStartFrame(); }}>
              <label htmlFor="clip-start-frame">Timeline start frame</label>
              <div><input id="clip-start-frame" type="number" min="0" step="1" value={startFrameDraft} onChange={(event) => setStartFrameDraft(event.target.value)} disabled={!!selectedClipTrack?.locked} /><button className="button button-secondary button-small" type="submit" disabled={!!selectedClipTrack?.locked}>Set</button></div>
            </form>
            {selectedClipAsset?.streams.video && <form className="source-trim-form" onSubmit={(event) => { event.preventDefault(); applySourceTrim(); }}>
              <div><label htmlFor="clip-source-in">Source in (seconds)</label><input id="clip-source-in" type="number" min="0" max={selectedClipAsset.streams.video.durationTicks * selectedClipAsset.streams.video.timeBase.numerator / selectedClipAsset.streams.video.timeBase.denominator} step="any" value={sourceInDraft} onChange={(event) => setSourceInDraft(event.target.value)} disabled={!!selectedClipTrack?.locked} /></div>
              <div><label htmlFor="clip-source-out">Source out (seconds)</label><input id="clip-source-out" type="number" min="0" max={selectedClipAsset.streams.video.durationTicks * selectedClipAsset.streams.video.timeBase.numerator / selectedClipAsset.streams.video.timeBase.denominator} step="any" value={sourceOutDraft} onChange={(event) => setSourceOutDraft(event.target.value)} disabled={!!selectedClipTrack?.locked} /></div>
              <button className="button button-secondary button-small" type="submit" disabled={!!selectedClipTrack?.locked}>Apply trim</button>
            </form>}
            <small>Trims are stored in source ticks; their timeline length rounds to sequence frames. Undo/redo is session-only.</small>
          </div> : <div className="properties-empty"><Settings2 size={20} /><strong>Nothing selected</strong><span>Select a video clip on the timeline to view its frame position.</span></div>}
          <div className="properties-divider"/>
          <div className="property-section"><span className="panel-kicker">SEQUENCE</span><div className="property-line"><span>Aspect ratio</span><strong>{ratio}</strong></div><div className="property-line"><span>Frame rate</span><strong>{frameRate}</strong></div><div className="property-line"><span>Resolution</span><strong>{sequence?.width ?? 1920} × {sequence?.height ?? 1080}</strong></div><div className="property-line"><span>Duration</span><strong>{sequence?.durationFrames ?? 0} frames</strong></div><small>Settings are loaded from the validated project document.</small></div>
        </div>
      </aside>
        <div
          className="timeline-resize-handle"
          role="separator"
          aria-label="Resize timeline height"
          aria-orientation="horizontal"
          aria-valuemin={TIMELINE_MIN_HEIGHT}
          aria-valuemax={timelineMaxHeight}
          aria-valuenow={effectiveTimelineHeight}
          aria-valuetext={`${effectiveTimelineHeight} pixels`}
          tabIndex={0}
          onPointerDown={beginTimelineResize}
          onPointerMove={moveTimelineResize}
          onPointerUp={endTimelineResize}
          onPointerCancel={endTimelineResize}
          onKeyDown={handleTimelineResizeKey}
        ><span /></div>
        <div className="timeline-panel" style={{ height: effectiveTimelineHeight }}>
          <div className="timeline-heading">
            <div><span className="panel-kicker">TIMELINE</span><span className="timeline-sequence">{sequence?.name ?? 'Sequence 01'}</span>{sequence && <span className="timeline-timecode" aria-label={`Playhead at ${formatRulerTime(timelinePlayheadFrame, sequence.frameRate)}`}>{formatRulerTime(timelinePlayheadFrame, sequence.frameRate)}</span>}</div>
            <div className="timeline-tools">
              <button type="button" aria-label="Undo timeline change" title="Undo timeline change" disabled={!canUndo} onClick={onUndo}><Undo2 size={14} /></button>
              <button type="button" aria-label="Redo timeline change" title="Redo timeline change" disabled={!canRedo} onClick={onRedo}><Redo2 size={14} /></button>
              <button className="button button-secondary button-small" type="button" onClick={addSelectedSourceToTimeline} disabled={!source || !playableAsset || !videoTracks.some((track) => !track.locked)} title="Append the selected source to an unlocked video track"><Plus size={13} />Add selected source</button>
              <button type="button" aria-label="Remove selected clip" disabled={!selectedClip || !!selectedClipTrack?.locked} title="Remove selected clip" onClick={removeSelectedClip}><Trash2 size={14} /></button>
              <div className="timeline-zoom" role="group" aria-label="Timeline zoom controls">
                <button type="button" aria-label="Zoom timeline out" title="Zoom timeline out" disabled={timelineZoom <= 0.25} onClick={() => zoomTimeline(timelineZoom / 1.25)}><ZoomOut size={14} /></button>
                <input aria-label="Timeline zoom level" type="range" min="0.25" max="4" step="0.05" value={timelineZoom} onChange={(event) => zoomTimeline(Number(event.target.value))} />
                <button type="button" aria-label="Zoom timeline in" title="Zoom timeline in" disabled={timelineZoom >= 4} onClick={() => zoomTimeline(timelineZoom * 1.25)}><ZoomIn size={14} /></button>
                <button type="button" aria-label="Fit project in timeline" title="Fit project in timeline" onClick={fitTimelineToProject}><Maximize2 size={14} /></button>
                <output aria-live="polite">{Math.round(timelineZoom * 100)}%</output>
              </div>
            </div>
          </div>
          {sequence ? <div className="timeline-track-layout">
            <div className="timeline-track-header-column">
              <div className="timeline-track-header-ruler" aria-hidden="true" />
              <div className="timeline-track-header-rows" ref={timelineTrackHeaderRowsRef}>
                {videoTracks.map((track, trackIndex) => <div className="track-row" key={track.id}>
                  <span className="track-name" title={track.name}><b>V{trackIndex + 1}</b><span>{track.name}</span></span>
                </div>)}
                {audioTracks.map((track, trackIndex) => <div className="track-row audio-track" key={track.id}>
                  <span className="track-name" title={track.name}><b>A{trackIndex + 1}</b><span>{track.name}</span></span>
                </div>)}
              </div>
            </div>
            <div className="timeline-scroll" ref={timelineScrollRef} onScroll={syncTimelineHeaderScroll} onClick={handleTimelineClick} role="region" aria-label="Timeline tracks">
              <div className="timeline-canvas" style={{ width: timelineContentWidth }}>
                <div className="timeline-ruler" style={{ width: timelineContentWidth }}>
                  {timelineTicks.map((frame) => <span className="timeline-tick" key={frame} style={{ left: `${frame * timelinePixelsPerFrame}px` }}>{formatRulerTime(frame, sequence.frameRate)}</span>)}
                </div>
                {videoTracks.map((track) => {
                  const clips = track.clips.filter((clip): clip is VideoClip => clip.kind === 'video');
                  return <div className="track-row" key={track.id}>
                    <div className="track-space timeline-track-space" style={{ width: timelineContentWidth, flex: '0 0 auto', backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)', backgroundSize: `${tickInterval * timelinePixelsPerFrame}px 100%` }}>
                      {clips.length ? clips.map((clip) => {
                        const asset = assets.find((item) => item.id === clip.assetId);
                        return <button
                          className={`timeline-clip ${selectedTimelineClipId === clip.id ? 'is-selected' : ''}`}
                          type="button"
                          key={clip.id}
                          style={{ left: clip.timelineStartFrame * timelinePixelsPerFrame, width: Math.max(4, clip.timelineDurationFrames * timelinePixelsPerFrame) }}
                          aria-label={`Select ${asset?.name ?? 'video'} clip at frame ${clip.timelineStartFrame}`}
                          aria-pressed={selectedTimelineClipId === clip.id}
                          title={`${asset?.name ?? 'Video'} · frame ${clip.timelineStartFrame} · ${clip.timelineDurationFrames} frames`}
                          onClick={(event) => { event.stopPropagation(); selectTimelineClip(clip, event); }}
                        >{asset?.name ?? 'Video clip'}</button>;
                      }) : <div className="empty-track"><span>Select a source in Project media, then choose “Add selected source”</span></div>}
                    </div>
                  </div>;
                })}
                {audioTracks.map((track) => <div className="track-row audio-track" key={track.id}>
                  <div className="track-space timeline-track-space" style={{ width: timelineContentWidth, flex: '0 0 auto', backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)', backgroundSize: `${tickInterval * timelinePixelsPerFrame}px 100%` }}><div className="empty-audio"><span>Audio lane editing unavailable</span></div></div>
                </div>)}
                <div ref={timelinePlayheadRef} className="timeline-playhead" style={{ transform: `translateX(${timelinePlayheadFrame * timelinePixelsPerFrame}px)` }}>
                  <button
                    className="timeline-playhead-grab"
                    type="button"
                    role="slider"
                    aria-label="Timeline playhead"
                    aria-valuemin={0}
                    aria-valuemax={timelineCanvasFrames}
                    aria-valuenow={timelinePlayheadFrame}
                    aria-valuetext={formatRulerTime(timelinePlayheadFrame, sequence.frameRate)}
                    onPointerDown={beginPlayheadDrag}
                    onPointerMove={movePlayheadDrag}
                    onPointerUp={endPlayheadDrag}
                    onPointerCancel={endPlayheadDrag}
                    onKeyDown={handlePlayheadKeyDown}
                    onClick={(event) => event.stopPropagation()}
                  />
                </div>
              </div>
            </div>
          </div> : <div className="timeline-empty">This project has no sequence to edit.</div>}
        </div>
    </div>
    <button className="subtle-back" onClick={onBack}><ArrowLeft size={14} />Back to projects</button>
  </section>;
}

function ClippingFoundation({ onCreate }: { onCreate: () => void }) {
  return <section className="clipping-view"><div className="clipping-heading"><div><div className="eyebrow">AI-ASSISTED WORKFLOW</div><h1>Find the moments worth keeping.</h1><p>Turn long recordings into focused clips — with you in control of every cut.</p></div><div className="clipping-mark"><Sparkles size={23} /></div></div><div className="clipping-notice"><span className="notice-indicator" /><div><strong>Analysis is not available yet</strong><p>This build does not include a transcription model or highlight-analysis provider. Your media will not be uploaded or analyzed.</p></div><span className="planned-tag">FOUNDATION</span></div><div className="clipping-steps"><div className="step-card"><span className="step-number">01</span><div className="step-icon"><FolderOpen size={19} /></div><h3>Preview your source</h3><p>Import a local video from the Editor for browser-based metadata and preview.</p><span className="step-state">Available in Editor</span></div><div className="step-connector" /><div className="step-card"><span className="step-number">02</span><div className="step-icon"><Sparkles size={19} /></div><h3>Review moments</h3><p>Check transcript-backed suggestions and why they were selected.</p><span className="step-state">Provider required</span></div><div className="step-connector" /><div className="step-card"><span className="step-number">03</span><div className="step-icon"><Clapperboard size={19} /></div><h3>Edit & export</h3><p>Refine the cut in the editor before creating your final export.</p><span className="step-state">Upcoming</span></div></div><div className="clipping-footer"><div><span className="footer-label">DESIGNED FOR PRIVACY</span><strong>Local-first, by default</strong><span> Cloud processing will always require explicit consent.</span></div><button className="button button-secondary" onClick={onCreate}><Plus size={15} />Create a project</button></div></section>;
}

function SettingsDialog({ theme, onTheme, onClose }: { theme: 'dark' | 'light'; onTheme: (value: 'dark' | 'light') => void; onClose: () => void }) {
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-head"><div className="dialog-icon"><Settings2 size={17} /></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={17} /></button></div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">Settings</h2><p className="dialog-copy">Adjust this workspace. Preferences are saved on this device.</p><div className="setting-row"><div><strong>Appearance</strong><span>Choose a theme for the studio.</span></div><div className="theme-toggle"><button className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}><Moon size={14} />Dark</button><button className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}><Sun size={14} />Light</button></div></div><div className="setting-row"><div><strong>Storage model</strong><span>Project index and documents in browser local storage</span></div><span className="setting-value">Local</span></div><div className="setting-row"><div><strong>Application version</strong><span>Foundation build · 0.1.0</span></div><span className="setting-value">Early access</span></div><div className="settings-disclaimer">A Windows desktop shell, managed project files, autosave, and recovery are not included in this first increment.</div><div className="dialog-actions"><button className="button button-primary" onClick={onClose}>Done</button></div></section></div>;
}

type CommandAction = { label: string; shortcut?: string; icon: LucideIcon; run: () => void };
function CommandDialog({ actions, onClose, inputRef }: { actions: CommandAction[]; onClose: () => void; inputRef: React.RefObject<HTMLInputElement> }) {
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = actions.filter((action) => action.label.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => { inputRef.current?.focus(); }, [inputRef]);
  useEffect(() => { setActiveIndex(0); }, [search]);
  return <div className="overlay command-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="command-dialog" role="dialog" aria-modal="true" aria-label="Command palette"><div className="command-search"><Search size={17} /><input ref={inputRef} placeholder="Type a command…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    if (event.key === 'Enter' && filtered[activeIndex]) filtered[activeIndex].run();
  }} /><kbd>ESC</kbd><button onClick={onClose} aria-label="Close command palette"><X size={15} /></button></div><div className="command-list" role="listbox" aria-label="Available commands">{filtered.map((action, index) => { const Icon = action.icon; return <button key={action.label} role="option" aria-selected={activeIndex === index} className={`command-item ${activeIndex === index ? 'is-highlighted' : ''}`} onMouseEnter={() => setActiveIndex(index)} onClick={action.run}><Icon size={16} /><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>; })}{filtered.length === 0 && <div className="command-empty">No matching commands</div>}</div><div className="command-footer"><span><Keyboard size={13} />↑ ↓ to navigate · Enter to run</span><span>CLIPWRIGHT STUDIO</span></div></section></div>;
}

function TaskDrawer({ onClose }: { onClose: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="task-drawer" aria-label="Task centre"><div className="drawer-head"><div><div className="eyebrow">BACKGROUND WORK</div><h2>Task centre</h2></div><button className="icon-button" onClick={onClose} aria-label="Close task centre"><X size={17} /></button></div><div className="task-empty"><div className="empty-icon"><Clock3 size={20} /></div><h3>No active tasks</h3><p>Imports, renders, and analysis jobs will be listed here when those systems are available.</p><span className="task-disclaimer">No background processing is running.</span></div><div className="drawer-bottom"><span className="status-dot" />Tasks run only when you start them</div></aside></div>;
}
