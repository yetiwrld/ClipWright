import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowLeft, ArrowRight, ArrowLeftRight, Check, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Download,
  CircleHelp, Clapperboard, Clock3, Command, FilePlus2, Film, FolderOpen, Image as ImageIcon,
  Pause, Play, SkipBack, SkipForward, Undo2, Redo2, Volume2, VolumeX,
  Grid2X2, HardDrive, Heart, Home, Keyboard, Maximize2,
  MoreHorizontal, Minimize2, Plus, Search, Settings2, Sparkles, Sun, Moon, Trash2, Upload, ZoomIn, ZoomOut, Scissors, Magnet,
  Eye, EyeOff, History, Lock, LockOpen, Save,
  X, type LucideIcon,
} from 'lucide-react';
import { createProject, PROJECTS_KEY, readProjectStore, writeProjects } from './lib/projects';
import type { AspectRatio, Project } from './lib/projects';
import { createProjectDocument, migrateLegacyProjectEntry, parseProjectDocument, PROJECT_DOCUMENTS_KEY, readProjectDocuments, serializeProjectDocument, writeProjectDocuments } from './lib/projectDocument';
import type { MediaAsset, ProjectDocument, Sequence, StreamInfo, TimelineClip, Track } from './lib/projectDocument';
import { probeBrowserAudio, probeBrowserVideo } from './lib/browserMedia';
import { exportResolutionLabel, getExportBitrates, getExportDimensions } from './lib/exportResolution';
import type { ExportQualityPreset, ExportResolutionPreset } from './lib/exportResolution';
import { prepareLocalMediaFile } from './lib/localMediaImport';
import { calculateWaveformPeaks } from './lib/audioWaveform';
import { DEFAULT_EDITOR_PREFERENCES, readEditorPreferences, writeEditorPreferences } from './lib/preferences';
import type { EditorPreferences } from './lib/preferences';
import { applyAppearance } from './lib/appearance';
import { selectActiveVideoClip } from './lib/timelineVideoFrames';
import { exportTimelineProject, type TimelineExportResult } from './lib/timelineExport';
import { checkMp4EncodingSupport } from './lib/deterministicWebmExport';
import type { EncoderConfigDiagnostic, FramePipelineCounts } from './lib/deterministicWebmExport';
import {
  addTimelineClip, clipDuration, clipEnd, duplicateTimelineClips, moveTimelineClips, pasteTimelineClips,
  quantizeTimelineTime, removeTimelineClips, resizeTimelineClip, sequenceDurationSeconds, splitTimelineClip,
} from './lib/timelineOperations';

type Workspace = 'home' | 'clipping' | 'editor';
type Toast = { id: number; message: string; kind?: 'error' | 'success' | 'warning' };
type ManagedProjectFile = { handle: string; fileName: string };
type DiskSaveState = 'saving' | 'saved' | 'error';
type ProjectSort = 'recent' | 'name' | 'oldest';
const PROJECTS_VIEW_KEY = 'clipwright.projects.view.v1';

function readProjectView() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PROJECTS_VIEW_KEY) ?? '{}');
    return {
      query: typeof stored.query === 'string' ? stored.query.slice(0, 120) : '',
      archived: stored.archived === true,
      sort: (['recent', 'name', 'oldest'].includes(stored.sort) ? stored.sort : 'recent') as ProjectSort,
    };
  } catch { return { query: '', archived: false, sort: 'recent' as ProjectSort }; }
}

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

type SessionMediaSource = { url: string; name: string; blob?: Blob };
type TimelineHistory = { past: Sequence[]; future: Sequence[] };
const mediaKey = (projectId: string, assetId: string) => JSON.stringify([projectId, assetId]);
const TIMELINE_HEIGHT_KEY = 'clipwright.workspace.timeline-height';
const TIMELINE_LAYOUT_VERSION_KEY = 'clipwright.workspace.timeline-layout-v2';
const TIMELINE_PX_PER_SECOND_KEY = 'clipwright.workspace.timeline-px-per-second';
const MEDIA_PANEL_WIDTH_KEY = 'clipwright.workspace.media-panel-width';
const PROPERTIES_PANEL_WIDTH_KEY = 'clipwright.workspace.properties-panel-width';
const TIMELINE_RESIZE_HANDLE_HEIGHT = 6;
const TIMELINE_MIN_PANEL_HEIGHT = 150;

function readTimelineHeight() {
  try {
    if (window.localStorage.getItem(TIMELINE_LAYOUT_VERSION_KEY) !== 'true') {
      window.localStorage.setItem(TIMELINE_LAYOUT_VERSION_KEY, 'true');
      return 0;
    }
    const value = Number(window.localStorage.getItem(TIMELINE_HEIGHT_KEY));
    return Number.isFinite(value) && value >= TIMELINE_MIN_PANEL_HEIGHT ? value : 0;
  } catch { return 0; }
}

function storeTimelineHeight(value: number) {
  try { window.localStorage.setItem(TIMELINE_HEIGHT_KEY, String(value)); }
  catch { /* The workspace remains usable when preferences cannot be persisted. */ }
}

function readTimelinePxPerSecond() {
  try {
    const value = Number(window.localStorage.getItem(TIMELINE_PX_PER_SECOND_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

function storeTimelinePxPerSecond(value: number) {
  try { window.localStorage.setItem(TIMELINE_PX_PER_SECOND_KEY, String(value)); }
  catch { /* The workspace remains usable when preferences cannot be persisted. */ }
}

function readPanelWidth(key: string, fallback: number) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= 180 && value <= 520 ? value : fallback;
  } catch { return fallback; }
}

function storePanelWidth(key: string, value: number) {
  try { window.localStorage.setItem(key, String(value)); }
  catch { /* Resizing remains available for this session when storage is blocked. */ }
}

function chooseRulerStep(pxPerSecond: number, frameRate: number) {
  const candidates = [1 / frameRate, 5 / frameRate, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 18000, 36000];
  return candidates.find((seconds) => seconds * pxPerSecond >= 80) ?? Math.ceil(80 / pxPerSecond / 3600) * 3600;
}

function formatRulerLabel(seconds: number, frameRate: number, stepSeconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const wholeSeconds = Math.floor(safeSeconds + 1e-7);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor(wholeSeconds % 3600 / 60);
  const remainder = wholeSeconds % 60;
  if (stepSeconds < 1) {
    const frames = Math.floor((safeSeconds - wholeSeconds) * frameRate + 1e-6);
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
  }
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts[parts.length - 1];
  const modifierRequired = parts.some((part) => ['ctrl', 'cmd', 'command', 'meta'].includes(part));
  const shiftRequired = parts.includes('shift');
  const altRequired = parts.includes('alt');
  const eventModifier = event.ctrlKey || event.metaKey;
  if (modifierRequired !== eventModifier || shiftRequired !== event.shiftKey || altRequired !== event.altKey) return false;
  if (['ctrl', 'cmd', 'command', 'meta', 'shift', 'alt'].includes(key)) return false;
  if (key === 'space') return event.code === 'Space';
  if (key === 'delete') return event.key === 'Delete' || event.key === 'Backspace';
  return event.key.toLowerCase() === key;
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


export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>('home');
  const [editorNavCollapsed, setEditorNavCollapsed] = useState(true);
  const [editorFocusMode, setEditorFocusMode] = useState(false);
  const [initialProjectStore] = useState(() => readProjectStore(window.localStorage));
  const [welcomeComplete, setWelcomeComplete] = useState(() => {
    if (initialProjectStore.projects.length) return true;
    try { return window.localStorage.getItem('clipwright.onboarding.completed.v1') === 'true'; }
    catch { return false; }
  });
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
  const [isStorageRestoring, setIsStorageRestoring] = useState(Boolean(window.clipwright?.library));
  const [desktopLibraryReady, setDesktopLibraryReady] = useState(!window.clipwright?.library);
  const [persistentStorageRoot, setPersistentStorageRoot] = useState<string | null>(null);
  const [persistentStorageIssue, setPersistentStorageIssue] = useState<string | null>(null);
  const [mediaImportMode, setMediaImportMode] = useState<'managed' | 'linked'>(() => window.clipwright?.library ? 'managed' : 'linked');
  const persistentSaveQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const restoredMediaProjectIdsRef = useRef(new Set<string>());
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'project' | 'editor' | 'audio' | 'export' | 'storage' | 'appearance' | 'shortcuts'>('project');
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showGuidedTour, setShowGuidedTour] = useState(false);
  const [projectRenderLimit, setProjectRenderLimit] = useState(60);
  const [projectView, setProjectView] = useState(readProjectView);
  const { archived: showArchived, query, sort: projectSort } = projectView;
  const setShowArchived = (archived: boolean | ((current: boolean) => boolean)) => setProjectView((current) => ({ ...current, archived: typeof archived === 'function' ? archived(current.archived) : archived }));
  const setQuery = (nextQuery: string) => setProjectView((current) => ({ ...current, query: nextQuery }));
  const setProjectSort = (sort: ProjectSort) => setProjectView((current) => ({ ...current, sort }));
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => window.localStorage.getItem('clipwright.theme') === 'light' ? 'light' : 'dark');
  const [preferences, setPreferences] = useState<EditorPreferences>(() => readEditorPreferences(window.localStorage));
  const updatePreferences = (update: (current: EditorPreferences) => EditorPreferences) => setPreferences(update);
  const [sessionSources, setSessionSources] = useState<Record<string, SessionMediaSource>>({});
  const [timelineHistory, setTimelineHistory] = useState<Record<string, TimelineHistory>>({});
  const [managedProjectFiles, setManagedProjectFiles] = useState<Record<string, ManagedProjectFile>>({});
  const [diskSaveStates, setDiskSaveStates] = useState<Record<string, DiskSaveState>>({});
  const [recoveryProjectId, setRecoveryProjectId] = useState<string | null>(null);
  const [recoveryPoints, setRecoveryPoints] = useState<ClipWrightRecoveryPoint[]>([]);
  const [isRestoringRecovery, setIsRestoringRecovery] = useState(false);
  const saveQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const closeSaveInFlightRef = useRef(false);
  const closeAfterSaveRef = useRef(false);
  const sessionSourcesRef = useRef<Record<string, SessionMediaSource>>({});
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null);
  const [pendingRelinkAssetId, setPendingRelinkAssetId] = useState<string | null>(null);
  const [isReadingMedia, setIsReadingMedia] = useState(false);
  const mediaImportInFlightRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeProjectDocument = documents.find((document) => document.id === activeProjectId) ?? null;
  const activeSequence = activeProjectDocument?.sequences.find((item) => item.id === activeProjectDocument.projectSettings.defaultSequenceId) ?? null;
  const editorAspectRatio = activeSequence ? aspectRatioOf(activeSequence.width, activeSequence.height) : activeProject?.aspectRatio ?? '16:9';
  const editorFrameRate = activeSequence ? formatFrameRate(activeSequence.frameRate.numerator / activeSequence.frameRate.denominator) : formatFrameRate(activeProject?.frameRate ?? 30);
  const persistenceWarning = storageWarning ?? documentStorageWarning ?? (persistentStorageIssue ? 'storage-unavailable' as const : null);
  useEffect(() => { if (workspace !== 'editor') setShowGuidedTour(false); }, [workspace]);

  const visibleProjects = useMemo(() => projects
    .filter((project) => project.archived === showArchived)
    .filter((project) => project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => {
      const favoriteOrder = Number(b.favorite) - Number(a.favorite);
      if (favoriteOrder) return favoriteOrder;
      if (projectSort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
      if (projectSort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    }), [projects, query, showArchived, projectSort]);
  const displayedProjects = visibleProjects.slice(0, projectRenderLimit);

  useEffect(() => { setProjectRenderLimit(60); }, [query, showArchived, projectSort]);

  function handleProjectTabsKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    if (!tabs.length) return;
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab === document.activeElement));
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (activeIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null || !tabs.length) return;
    event.preventDefault();
    setShowArchived(nextIndex === 1);
    tabs[nextIndex].focus();
  }

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
    const library = window.clipwright?.library;
    if (!library) return;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await library.initialize();
        if (cancelled) return;
        setPersistentStorageRoot(snapshot.root);
        const restoreIssues = [...snapshot.issues.map((issue) => issue.message)];
        const diskDocuments: ProjectDocument[] = [];
        for (const record of snapshot.projects) {
          try {
            const restored = parseProjectDocument(record.contents);
            if (restored.id !== record.documentId) throw new Error('Project manifest identity does not match its index.');
            diskDocuments.push(restored);
          } catch (error) { restoreIssues.push(error instanceof Error ? error.message : 'A project manifest could not be restored.'); }
        }
        const freshest = new Map(diskDocuments.map((document) => [document.id, document]));
        for (const localDocument of documents) {
          const diskDocument = freshest.get(localDocument.id);
          if (!diskDocument || Date.parse(localDocument.metadata.modifiedAt) > Date.parse(diskDocument.metadata.modifiedAt)) freshest.set(localDocument.id, localDocument);
        }
        const restoredDocuments = [...freshest.values()];
        const mergedProjects = new Map(projects.map((project) => [project.id, project]));
        for (const document of restoredDocuments) {
          const sequence = document.sequences.find((item) => item.id === document.projectSettings.defaultSequenceId);
          if (!sequence) { restoreIssues.push(`Project “${document.metadata.name}” has no default sequence.`); continue; }
          const previous = mergedProjects.get(document.id);
          mergedProjects.set(document.id, {
            id: document.id, name: document.metadata.name, createdAt: document.metadata.createdAt, updatedAt: document.metadata.modifiedAt,
            aspectRatio: aspectRatioOf(sequence.width, sequence.height), frameRate: sequence.frameRate.numerator / sequence.frameRate.denominator,
            archived: previous?.archived ?? false, favorite: previous?.favorite ?? false,
          });
        }
        if (cancelled) return;
        setProjects([...mergedProjects.values()]);
        setDocuments(restoredDocuments);
        if (diskDocuments.length && restoreIssues.length === 0) { setStorageWarning(null); setDocumentStorageWarning(null); }
        let lastProjectId: string | null = null;
        try { lastProjectId = window.localStorage.getItem('clipwright.workspace.last-project'); }
        catch { /* Last-opened restoration is optional when profile storage is unavailable. */ }
        const lastDocument = lastProjectId ? restoredDocuments.find((document) => document.id === lastProjectId) : null;
        if (lastProjectId && lastDocument && mergedProjects.has(lastProjectId)) {
          setActiveProjectId(lastProjectId);
          setWorkspace('editor');
          if (restoreIssues.length === 0) {
            try {
              await library.saveProject({ contents: serializeProjectDocument(lastDocument) });
              const resolved = await library.resolveMedia(lastProjectId);
              if (cancelled) return;
              const restoredSources = { ...sessionSourcesRef.current };
              for (const item of resolved) {
                if (!item.available || !item.mediaUrl) continue;
                const asset = lastDocument.assets.find((candidate) => candidate.id === item.assetId);
                restoredSources[mediaKey(lastProjectId, item.assetId)] = { url: item.mediaUrl, name: asset?.name ?? item.assetId };
              }
              sessionSourcesRef.current = restoredSources;
              setSessionSources(restoredSources);
              restoredMediaProjectIdsRef.current.add(lastProjectId);
            } catch (error) { restoreIssues.push(error instanceof Error ? error.message : 'The last project could not be restored from disk.'); }
          }
        }
        setPersistentStorageIssue(restoreIssues.length ? restoreIssues.join(' ') : null);
        setDesktopLibraryReady(restoreIssues.length === 0);
      } catch (error) {
        if (cancelled) return;
        setPersistentStorageIssue(error instanceof Error ? error.message : 'The ClipWright project library could not be opened.');
        setDesktopLibraryReady(false);
      } finally {
        if (!cancelled) setIsStorageRestoring(false);
      }
    })();
    return () => { cancelled = true; };
  // Startup snapshot only: merge disk with the first in-memory/localStorage snapshot before enabling persistence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    try { window.localStorage.setItem('clipwright.workspace.last-project', activeProjectId); }
    catch { /* Last-opened restoration is optional when profile storage is unavailable. */ }
  }, [activeProjectId]);

  useEffect(() => {
    try { window.localStorage.setItem(PROJECTS_VIEW_KEY, JSON.stringify(projectView)); }
    catch { /* Project filters remain usable for this session if profile storage is blocked. */ }
  }, [projectView]);

  useEffect(() => {
    const library = window.clipwright?.library;
    if (!library || !desktopLibraryReady || isStorageRestoring || persistentStorageIssue) return;
    const timers: number[] = [];
    for (const projectDocument of documents) {
      const timer = window.setTimeout(() => {
        let contents: string;
        try { contents = serializeProjectDocument(projectDocument); }
        catch { setDiskSaveStates((current) => ({ ...current, [projectDocument.id]: 'error' })); return; }
        setDiskSaveStates((current) => ({ ...current, [projectDocument.id]: 'saving' }));
        const previous = persistentSaveQueuesRef.current.get(projectDocument.id) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(() => library.saveProject({ contents }));
        persistentSaveQueuesRef.current.set(projectDocument.id, operation);
        void operation.then(() => {
          if (persistentSaveQueuesRef.current.get(projectDocument.id) === operation) setDiskSaveStates((current) => ({ ...current, [projectDocument.id]: 'saved' }));
        }).catch(() => {
          if (persistentSaveQueuesRef.current.get(projectDocument.id) === operation) setDiskSaveStates((current) => ({ ...current, [projectDocument.id]: 'error' }));
        });
      }, Math.max(300, preferences.storage.autosaveIntervalSeconds * 1000));
      timers.push(timer);
    }
    return () => timers.forEach(window.clearTimeout);
  }, [documents, desktopLibraryReady, isStorageRestoring, persistentStorageIssue, preferences.storage.autosaveIntervalSeconds]);

  useEffect(() => {
    const library = window.clipwright?.library;
    if (!library || !desktopLibraryReady || isStorageRestoring || !activeProjectId || restoredMediaProjectIdsRef.current.has(activeProjectId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const projectDocument = documents.find((document) => document.id === activeProjectId);
        if (projectDocument && !persistentStorageIssue) await library.saveProject({ contents: serializeProjectDocument(projectDocument) });
        const resolved = await library.resolveMedia(activeProjectId);
        if (cancelled) return;
        const next = { ...sessionSourcesRef.current };
        for (const item of resolved) {
          if (!item.available || !item.mediaUrl) continue;
          const key = mediaKey(activeProjectId, item.assetId);
          if (next[key]) continue;
          const asset = projectDocument?.assets.find((candidate) => candidate.id === item.assetId);
          next[key] = { url: item.mediaUrl, name: asset?.name ?? item.assetId };
        }
        sessionSourcesRef.current = next;
        setSessionSources(next);
        restoredMediaProjectIdsRef.current.add(activeProjectId);
      } catch (error) {
        if (!cancelled) setPersistentStorageIssue(error instanceof Error ? error.message : 'Project media could not be restored.');
      }
    })();
    return () => { cancelled = true; };
  // Opened project changes are the restore boundary; the app library validates each project manifest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, desktopLibraryReady, isStorageRestoring]);

  useEffect(() => {
    const desktopFiles = window.clipwright?.projectFiles;
    if (!desktopFiles) return;
    const timers: number[] = [];
    for (const document of documents) {
      const linkedFile = managedProjectFiles[document.id];
      if (!linkedFile) continue;
      const timer = window.setTimeout(() => {
        let contents: string;
        try { contents = serializeProjectDocument(document); }
        catch { setDiskSaveStates((current) => ({ ...current, [document.id]: 'error' })); return; }
        setDiskSaveStates((current) => ({ ...current, [document.id]: 'saving' }));
        const previous = saveQueuesRef.current.get(document.id) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(() => desktopFiles.save({ handle: linkedFile.handle, contents }));
        saveQueuesRef.current.set(document.id, operation);
        void operation.then((result) => {
          if (saveQueuesRef.current.get(document.id) !== operation) return;
          setDiskSaveStates((current) => ({ ...current, [document.id]: 'saved' }));
          setManagedProjectFiles((current) => current[document.id]?.handle === linkedFile.handle
            ? { ...current, [document.id]: { ...current[document.id], fileName: result.fileName } }
            : current);
        }).catch(() => {
          if (saveQueuesRef.current.get(document.id) === operation) setDiskSaveStates((current) => ({ ...current, [document.id]: 'error' }));
        });
      }, preferences.storage.autosaveIntervalSeconds * 1000);
      timers.push(timer);
    }
    return () => timers.forEach(window.clearTimeout);
  }, [documents, managedProjectFiles, preferences.storage.autosaveIntervalSeconds]);

  useEffect(() => {
    if (!window.clipwright?.library || !desktopLibraryReady || isStorageRestoring || persistentStorageIssue) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (closeAfterSaveRef.current) return;
      event.preventDefault();
      if (isReadingMedia) {
        notify('Wait for the current media import to finish before closing the editor.', 'error');
        return;
      }
      if (closeSaveInFlightRef.current) return;
      closeSaveInFlightRef.current = true;
      let snapshots: Array<{ projectDocument: ProjectDocument; linkedFile: ManagedProjectFile | undefined; contents: string }>;
      try {
        snapshots = documents.map((projectDocument) => ({
          projectDocument,
          linkedFile: managedProjectFiles[projectDocument.id],
          contents: serializeProjectDocument(projectDocument),
        }));
      } catch (error) {
        closeSaveInFlightRef.current = false;
        notify(error instanceof Error ? `Could not validate every project before closing: ${error.message}` : 'Could not validate every project before closing.', 'error');
        return;
      }
      void Promise.all(snapshots.map(async ({ projectDocument, linkedFile, contents }) => {
        await enqueuePersistentSave(projectDocument.id, contents);
        if (linkedFile) await enqueueDesktopSave(projectDocument.id, linkedFile.handle, contents);
        setDiskSaveStates((current) => ({ ...current, [projectDocument.id]: 'saved' }));
      })).then(() => {
        closeAfterSaveRef.current = true;
        window.close();
      }).catch((error) => {
        closeSaveInFlightRef.current = false;
        setDiskSaveStates((current) => ({ ...current, ...Object.fromEntries(snapshots.map(({ projectDocument }) => [projectDocument.id, 'error' as const])) }));
        notify(error instanceof Error ? `Could not save every project before closing: ${error.message}` : 'Could not save every project before closing.', 'error');
      });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [documents, managedProjectFiles, desktopLibraryReady, isStorageRestoring, persistentStorageIssue, isReadingMedia]);

  useEffect(() => {
    try { window.localStorage.setItem('clipwright.theme', theme); }
    catch { /* Theme remains usable for this session even if browser storage is blocked. */ }
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    try { writeEditorPreferences(window.localStorage, preferences); }
    catch { /* Editing remains available for this session when storage is blocked. */ }
    applyAppearance(document.documentElement, theme, preferences.appearance.accent, preferences.appearance.uiScale as 90 | 100 | 110 | 125);
  }, [preferences, theme]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && workspace === 'editor' && activeProject) {
        event.preventDefault(); void saveProjectFile(activeProject.id);
      }
      if (event.key === 'Escape') {
        setShowCreate(false); setShowSettings(false); setShowCommands(false); setShowTasks(false); setShowHelp(false);
        if (!isRestoringRecovery) setRecoveryProjectId(null);
        setEditorFocusMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistenceWarning, workspace, activeProject, documents, managedProjectFiles, isRestoringRecovery]);

  function completeWelcome() {
    setWelcomeComplete(true);
    try { window.localStorage.setItem('clipwright.onboarding.completed.v1', 'true'); }
    catch { /* Welcome remains dismissed for this session if profile storage is unavailable. */ }
  }

  function notify(message: string, kind: Toast['kind'] = 'success') {
    const id = Date.now();
    setToast({ id, message, kind });
    if (kind !== 'error') window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 3200);
  }

  function enqueuePersistentSave(projectId: string, contents: string) {
    const library = window.clipwright?.library;
    if (!library) return Promise.reject(new Error('Persistent project storage is available only in the desktop app.'));
    const previous = persistentSaveQueuesRef.current.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => library.saveProject({ contents }));
    persistentSaveQueuesRef.current.set(projectId, operation);
    return operation;
  }

  function enqueueDesktopSave(projectId: string, handle: string, contents: string) {
    const desktopFiles = window.clipwright?.projectFiles;
    if (!desktopFiles) return Promise.reject(new Error('Managed project files are available only in the desktop app.'));
    const previous = saveQueuesRef.current.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => desktopFiles.save({ handle, contents }));
    saveQueuesRef.current.set(projectId, operation);
    return operation;
  }

  async function saveProjectFile(projectId: string) {
    const projectDocument = documents.find((entry) => entry.id === projectId);
    if (!projectDocument) { notify('No validated project document is available to save.', 'error'); return; }
    const library = window.clipwright?.library;
    if (library) {
      try {
        const contents = serializeProjectDocument(projectDocument);
        setDiskSaveStates((current) => ({ ...current, [projectId]: 'saving' }));
        await enqueuePersistentSave(projectId, contents);
        setDiskSaveStates((current) => ({ ...current, [projectId]: 'saved' }));
        notify('Project saved to the ClipWright library.');
      } catch (error) {
        setDiskSaveStates((current) => ({ ...current, [projectId]: 'error' }));
        notify(error instanceof Error ? error.message : 'Could not save the project to the ClipWright library.', 'error');
      }
      return;
    }
    const desktopFiles = window.clipwright?.projectFiles;
    if (!desktopFiles) {
      const project = projects.find((entry) => entry.id === projectId);
      if (project) downloadProjectFile(project);
      return;
    }
    const linkedFile = managedProjectFiles[projectId];
    if (!linkedFile) { await saveProjectFileAs(projectId); return; }
    try {
      const contents = serializeProjectDocument(projectDocument);
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'saving' }));
      const result = await enqueueDesktopSave(projectId, linkedFile.handle, contents);
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'saved' }));
      notify(result.changed ? `Saved ${result.fileName}.` : `${result.fileName} is up to date.`);
    } catch (error) {
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'error' }));
      notify(error instanceof Error ? error.message : 'Could not save the project file.', 'error');
    }
  }

  async function saveProjectFileAs(projectId: string) {
    const desktopFiles = window.clipwright?.projectFiles;
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;
    if (!desktopFiles) { downloadProjectFile(project); return; }
    const projectDocument = documents.find((entry) => entry.id === projectId);
    if (!projectDocument) { notify('No validated project document is available to save.', 'error'); return; }
    try {
      const contents = serializeProjectDocument(projectDocument);
      const result = await desktopFiles.saveAs({ contents, suggestedName: project.name });
      if (result.canceled) return;
      setManagedProjectFiles((current) => ({ ...current, [projectId]: { handle: result.handle, fileName: result.fileName } }));
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'saved' }));
      notify(`Saved ${result.fileName}. Source media is referenced, not copied.`);
    } catch (error) {
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'error' }));
      notify(error instanceof Error ? error.message : 'Could not save the project file.', 'error');
    }
  }

  function clearSessionMediaForProject(projectId: string, previousDocument: ProjectDocument | undefined) {
    if (!previousDocument) return;
    const nextSources = { ...sessionSourcesRef.current };
    for (const asset of previousDocument.assets) {
      const key = mediaKey(projectId, asset.id);
      const source = nextSources[key];
      if (source) URL.revokeObjectURL(source.url);
      delete nextSources[key];
    }
    sessionSourcesRef.current = nextSources;
    setSessionSources(nextSources);
  }

  async function openDesktopProject() {
    const desktopFiles = window.clipwright?.projectFiles;
    if (!desktopFiles) { projectFileInputRef.current?.click(); return; }
    try {
      const result = await desktopFiles.open();
      if (result.canceled) return;
      const incomingDocument = parseProjectDocument(result.contents);
      if (incomingDocument.id !== result.documentId) throw new Error('The selected project id changed while it was being opened.');
      const existingProject = projects.find((project) => project.id === incomingDocument.id);
      if (existingProject && !window.confirm(`“${existingProject.name}” already exists in this workspace. Replace its browser copy with the version from ${result.fileName}? The file on disk will remain linked for autosave.`)) return;
      const sequence = incomingDocument.sequences.find((item) => item.id === incomingDocument.projectSettings.defaultSequenceId);
      if (!sequence) throw new Error('The project file does not contain its declared default sequence.');
      const project: Project = {
        id: incomingDocument.id,
        name: incomingDocument.metadata.name,
        createdAt: incomingDocument.metadata.createdAt,
        updatedAt: incomingDocument.metadata.modifiedAt,
        aspectRatio: aspectRatioOf(sequence.width, sequence.height),
        frameRate: sequence.frameRate.numerator / sequence.frameRate.denominator,
        archived: existingProject?.archived ?? false,
        favorite: existingProject?.favorite ?? false,
      };
      if (window.clipwright?.library) await window.clipwright.library.saveProject({ contents: serializeProjectDocument(incomingDocument) });
      clearSessionMediaForProject(project.id, documents.find((entry) => entry.id === project.id));
      setProjects((current) => existingProject
        ? current.map((entry) => entry.id === project.id ? project : entry)
        : [project, ...current]);
      setDocuments((current) => current.some((entry) => entry.id === incomingDocument.id)
        ? current.map((entry) => entry.id === incomingDocument.id ? incomingDocument : entry)
        : [...current, incomingDocument]);
      setManagedProjectFiles((current) => ({ ...current, [project.id]: { handle: result.handle, fileName: result.fileName } }));
      setDiskSaveStates((current) => ({ ...current, [project.id]: 'saved' }));
      setActiveProjectId(project.id);
      setWorkspace('editor');
      completeWelcome();
      notify(`Opened ${result.fileName}. Future changes will autosave to this file.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open this project file.', 'error');
    }
  }

  async function openRecoveryDialog(projectId: string) {
    const link = managedProjectFiles[projectId];
    const desktopFiles = window.clipwright?.projectFiles;
    if (!link || !desktopFiles) { notify('Save this project to a managed project file before using recovery.', 'warning'); return; }
    try {
      const points = await desktopFiles.listRecoveryPoints(link.handle);
      setRecoveryPoints(points);
      setRecoveryProjectId(projectId);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read project recovery points.', 'error');
    }
  }

  async function restoreRecoveryPoint(point: ClipWrightRecoveryPoint) {
    const projectId = recoveryProjectId;
    const link = projectId ? managedProjectFiles[projectId] : null;
    const desktopFiles = window.clipwright?.projectFiles;
    if (!projectId || !link || !desktopFiles) return;
    try {
      const confirmed = window.confirm(`Restore the checkpoint from ${readableDate(point.modifiedAt)}? The current disk version will first be retained as another recovery point.`);
      if (!confirmed) return;
      setIsRestoringRecovery(true);
      const restoredDocument = parseProjectDocument(await desktopFiles.readRecoveryPoint({ handle: link.handle, recoveryId: point.id }));
      if (restoredDocument.id !== projectId) throw new Error('This recovery checkpoint belongs to a different project.');
      const contents = serializeProjectDocument(restoredDocument);
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'saving' }));
      await enqueueDesktopSave(projectId, link.handle, contents);
      const sequence = restoredDocument.sequences.find((item) => item.id === restoredDocument.projectSettings.defaultSequenceId);
      if (!sequence) throw new Error('The recovery checkpoint does not contain its declared default sequence.');
      setDocuments((current) => current.map((entry) => entry.id === projectId ? restoredDocument : entry));
      setProjects((current) => current.map((entry) => entry.id === projectId ? {
        ...entry,
        name: restoredDocument.metadata.name,
        updatedAt: restoredDocument.metadata.modifiedAt,
        aspectRatio: aspectRatioOf(sequence.width, sequence.height),
        frameRate: sequence.frameRate.numerator / sequence.frameRate.denominator,
      } : entry));
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'saved' }));
      setRecoveryPoints(await desktopFiles.listRecoveryPoints(link.handle));
      setRecoveryProjectId(null);
      notify('Recovery checkpoint restored.');
    } catch (error) {
      setDiskSaveStates((current) => ({ ...current, [projectId]: 'error' }));
      notify(error instanceof Error ? error.message : 'Could not restore this recovery checkpoint.', 'error');
    } finally {
      setIsRestoringRecovery(false);
    }
  }

  function requestVideoImport(assetId?: string) {
    if (mediaImportInFlightRef.current) {
      notify('Wait for the current media read to finish before importing another file.', 'warning');
      return;
    }
    if (!activeProjectId || persistenceWarning) {
      notify('Open a project with writable browser storage before importing video.', 'error');
      return;
    }
    setPendingRelinkAssetId(assetId ?? null);
    videoFileInputRef.current?.click();
  }

  function requestAudioImport(assetId?: string) {
    if (mediaImportInFlightRef.current) {
      notify('Wait for the current media read to finish before importing another file.', 'warning');
      return;
    }
    if (!activeProjectId || persistenceWarning) {
      notify('Open a project with writable browser storage before importing audio.', 'error');
      return;
    }
    setPendingRelinkAssetId(assetId ?? null);
    audioFileInputRef.current?.click();
  }

  function requestImageImport(assetId?: string) {
    if (mediaImportInFlightRef.current) { notify('Wait for the current media read to finish before importing another file.', 'warning'); return; }
    if (!activeProjectId || persistenceWarning) { notify('Open a project with writable storage before importing an image.', 'error'); return; }
    setPendingRelinkAssetId(assetId ?? null);
    imageFileInputRef.current?.click();
  }

  async function importVideoFile(file: File | null) {
    if (!file) { setPendingRelinkAssetId(null); return; }
    if (mediaImportInFlightRef.current) { setPendingRelinkAssetId(null); notify('Wait for the current media read to finish.', 'warning'); return; }
    const projectId = activeProjectId;
    const project = projects.find((entry) => entry.id === projectId);
    const projectDocument = documents.find((entry) => entry.id === projectId);
    if (!project || !projectDocument) {
      setPendingRelinkAssetId(null);
      notify('The active project document is unavailable; video was not imported.', 'error');
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

    let safeFileName: string;
    try { safeFileName = prepareLocalMediaFile(file, 'video'); }
    catch (error) {
      setPendingRelinkAssetId(null);
      notify(error instanceof Error ? error.message : 'Choose a readable local video file.', 'error');
      return;
    }
    let objectUrl: string | null = null;
    mediaImportInFlightRef.current = true;
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
      const assetId = targetAsset?.id ?? crypto.randomUUID();
      const persisted = window.clipwright?.library
        ? await window.clipwright.library.importFile(file, { projectId: projectId!, assetId, mode: mediaImportMode })
        : null;
      if (targetAsset && persisted && targetAsset.fingerprint && targetAsset.fingerprint !== persisted.fingerprint
        && !window.confirm(`The selected file differs from the recorded fingerprint for “${targetAsset.name}”. Relink it anyway and keep its timeline edits?`)) return;
      if (targetAsset && !persisted && targetAsset.fileSizeBytes !== undefined && targetAsset.fileSizeBytes !== file.size
        && !window.confirm(`The selected file size differs from “${targetAsset.name}”. Use it as the replacement and keep its timeline edits?`)) return;
      const asset: MediaAsset = {
        ...(targetAsset ?? { id: assetId, kind: 'video' as const, streams: {} }),
        name: safeFileName,
        sourcePath: persisted?.sourcePath ?? safeFileName,
        pathKind: persisted?.pathKind ?? 'browser-session',
        fileSizeBytes: persisted?.fileSizeBytes ?? file.size,
        fingerprint: persisted?.fingerprint,
        streams: { ...targetAsset?.streams, video: videoStream },
      };
      const updatedDocument: ProjectDocument = {
        ...projectDocument,
        metadata: { ...projectDocument.metadata, modifiedAt: new Date().toISOString() },
        assets: targetAsset
          ? projectDocument.assets.map((entry) => entry.id === targetAsset.id ? asset : entry)
          : [...projectDocument.assets, asset],
      };
      const serializedDocument = serializeProjectDocument(updatedDocument);
      if (window.clipwright?.library) await window.clipwright.library.saveProject({ contents: serializedDocument });

      const key = mediaKey(projectId!, asset.id);
      const oldUrl = sessionSourcesRef.current[key]?.url;
      if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
      const playbackUrl = persisted?.mediaUrl ?? objectUrl;
      if (persisted && objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      const nextSources = { ...sessionSourcesRef.current, [key]: { url: playbackUrl, name: safeFileName, blob: file } };
      sessionSourcesRef.current = nextSources;
      setSessionSources(nextSources);
      setDocuments((current) => current.map((entry) => entry.id === projectId ? updatedDocument : entry));
      setProjects((current) => current.map((entry) => entry.id === projectId ? { ...entry, updatedAt: updatedDocument.metadata.modifiedAt } : entry));
      setSelectedMediaKey(key);
      if (objectUrl) objectUrl = null; // The session source registry now owns the URL and revokes it on replacement/unmount.
      notify(persisted?.mode === 'managed'
        ? `Managed copy verified · ${safeFileName} · ${metadata.width} × ${metadata.height} · ${metadata.durationSeconds.toFixed(2)} s.`
        : persisted?.mode === 'linked'
          ? `Linked external video · ${safeFileName} · ${metadata.width} × ${metadata.height} · ${metadata.durationSeconds.toFixed(2)} s.`
          : `Session-only video · ${safeFileName} · ${metadata.width} × ${metadata.height} · ${metadata.durationSeconds.toFixed(2)} s.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read video metadata in this browser.', 'error');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      mediaImportInFlightRef.current = false;
      setPendingRelinkAssetId(null);
      setIsReadingMedia(false);
    }
  }

  async function importAudioFile(file: File | null) {
    if (!file) { setPendingRelinkAssetId(null); return; }
    if (mediaImportInFlightRef.current) { setPendingRelinkAssetId(null); notify('Wait for the current media read to finish.', 'warning'); return; }
    const projectId = activeProjectId;
    const project = projects.find((entry) => entry.id === projectId);
    const projectDocument = documents.find((entry) => entry.id === projectId);
    if (!project || !projectDocument) {
      setPendingRelinkAssetId(null);
      notify('The active project document is unavailable; audio was not imported.', 'error');
      return;
    }
    const targetAsset = pendingRelinkAssetId
      ? projectDocument.assets.find((asset) => asset.id === pendingRelinkAssetId && asset.kind === 'audio')
      : undefined;
    if (pendingRelinkAssetId && !targetAsset) {
      setPendingRelinkAssetId(null);
      notify('This project has no matching audio asset to relink.', 'error');
      return;
    }
    let safeFileName: string;
    try { safeFileName = prepareLocalMediaFile(file, 'audio'); }
    catch (error) {
      setPendingRelinkAssetId(null);
      notify(error instanceof Error ? error.message : 'Choose a readable local audio file.', 'error');
      return;
    }
    let objectUrl: string | null = null;
    mediaImportInFlightRef.current = true;
    setIsReadingMedia(true);
    try {
      objectUrl = URL.createObjectURL(file);
      const metadata = await probeBrowserAudio(objectUrl);
      const timeBase = targetAsset?.streams.audio?.timeBase ?? metadata.timeBase;
      const audioStream: StreamInfo = {
        timeBase,
        durationTicks: targetAsset
          ? Math.round(metadata.durationSeconds * timeBase.denominator / timeBase.numerator)
          : metadata.durationTicks,
      };
      const assetId = targetAsset?.id ?? crypto.randomUUID();
      const persisted = window.clipwright?.library
        ? await window.clipwright.library.importFile(file, { projectId: projectId!, assetId, mode: mediaImportMode })
        : null;
      if (targetAsset && persisted && targetAsset.fingerprint && targetAsset.fingerprint !== persisted.fingerprint
        && !window.confirm(`The selected file differs from the recorded fingerprint for “${targetAsset.name}”. Relink it anyway and keep its timeline edits?`)) return;
      if (targetAsset && !persisted && targetAsset.fileSizeBytes !== undefined && targetAsset.fileSizeBytes !== file.size
        && !window.confirm(`The selected file size differs from “${targetAsset.name}”. Use it as the replacement and keep its timeline edits?`)) return;
      const asset: MediaAsset = {
        ...(targetAsset ?? { id: assetId, kind: 'audio' as const, streams: {} }),
        name: safeFileName,
        sourcePath: persisted?.sourcePath ?? safeFileName,
        pathKind: persisted?.pathKind ?? 'browser-session',
        fileSizeBytes: persisted?.fileSizeBytes ?? file.size,
        fingerprint: persisted?.fingerprint,
        streams: { ...targetAsset?.streams, audio: audioStream },
      };
      const updatedDocument: ProjectDocument = {
        ...projectDocument,
        metadata: { ...projectDocument.metadata, modifiedAt: new Date().toISOString() },
        assets: targetAsset
          ? projectDocument.assets.map((entry) => entry.id === targetAsset.id ? asset : entry)
          : [...projectDocument.assets, asset],
      };
      const serializedDocument = serializeProjectDocument(updatedDocument);
      if (window.clipwright?.library) await window.clipwright.library.saveProject({ contents: serializedDocument });
      const key = mediaKey(projectId!, asset.id);
      const oldUrl = sessionSourcesRef.current[key]?.url;
      if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
      const playbackUrl = persisted?.mediaUrl ?? objectUrl;
      if (persisted && objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      const nextSources = { ...sessionSourcesRef.current, [key]: { url: playbackUrl, name: safeFileName, blob: file } };
      sessionSourcesRef.current = nextSources;
      setSessionSources(nextSources);
      setDocuments((current) => current.map((entry) => entry.id === projectId ? updatedDocument : entry));
      setProjects((current) => current.map((entry) => entry.id === projectId ? { ...entry, updatedAt: updatedDocument.metadata.modifiedAt } : entry));
      setSelectedMediaKey(key);
      if (objectUrl) objectUrl = null;
      notify(persisted?.mode === 'managed' ? `Managed audio copy verified · ${safeFileName} · ${metadata.durationSeconds.toFixed(2)} s.`
        : persisted?.mode === 'linked' ? `Linked external audio · ${safeFileName} · ${metadata.durationSeconds.toFixed(2)} s.`
          : `Session-only audio · ${safeFileName} · ${metadata.durationSeconds.toFixed(2)} s.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read audio metadata in this browser.', 'error');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      mediaImportInFlightRef.current = false;
      setPendingRelinkAssetId(null);
      setIsReadingMedia(false);
    }
  }

  async function importImageFile(file: File | null) {
    if (!file) { setPendingRelinkAssetId(null); return; }
    if (mediaImportInFlightRef.current) { setPendingRelinkAssetId(null); notify('Wait for the current media read to finish.', 'warning'); return; }
    const projectId = activeProjectId;
    const projectDocument = documents.find((entry) => entry.id === projectId);
    if (!projectId || !projectDocument) { setPendingRelinkAssetId(null); notify('The active project document is unavailable; image was not imported.', 'error'); return; }
    const targetAsset = pendingRelinkAssetId ? projectDocument.assets.find((asset) => asset.id === pendingRelinkAssetId && asset.kind === 'image') : undefined;
    if (pendingRelinkAssetId && !targetAsset) { setPendingRelinkAssetId(null); notify('This project has no matching image asset to relink.', 'error'); return; }
    let safeFileName: string;
    try { safeFileName = prepareLocalMediaFile(file, 'image'); }
    catch (error) { setPendingRelinkAssetId(null); notify(error instanceof Error ? error.message : 'Choose a readable local image.', 'error'); return; }
    let objectUrl: string | null = null;
    mediaImportInFlightRef.current = true;
    setIsReadingMedia(true);
    try {
      objectUrl = URL.createObjectURL(file);
      const bitmap = await createImageBitmap(file);
      const imageDimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      if (imageDimensions.width > 16384 || imageDimensions.height > 16384) throw new Error('Image dimensions exceed the 16384 pixel project safety limit.');
      const assetId = targetAsset?.id ?? crypto.randomUUID();
      const persisted = window.clipwright?.library
        ? await window.clipwright.library.importFile(file, { projectId, assetId, mode: mediaImportMode })
        : null;
      if (targetAsset && persisted && targetAsset.fingerprint && targetAsset.fingerprint !== persisted.fingerprint
        && !window.confirm(`The selected image differs from the recorded fingerprint for “${targetAsset.name}”. Relink it and keep the project state?`)) return;
      const asset: MediaAsset = {
        ...(targetAsset ?? { id: assetId, kind: 'image' as const, streams: {} }),
        name: safeFileName,
        sourcePath: persisted?.sourcePath ?? safeFileName,
        pathKind: persisted?.pathKind ?? 'browser-session',
        fileSizeBytes: persisted?.fileSizeBytes ?? file.size,
        fingerprint: persisted?.fingerprint,
        imageDimensions,
        streams: {},
      };
      const updatedDocument: ProjectDocument = {
        ...projectDocument,
        metadata: { ...projectDocument.metadata, modifiedAt: new Date().toISOString() },
        assets: targetAsset ? projectDocument.assets.map((entry) => entry.id === targetAsset.id ? asset : entry) : [...projectDocument.assets, asset],
      };
      const contents = serializeProjectDocument(updatedDocument);
      if (window.clipwright?.library) await window.clipwright.library.saveProject({ contents });
      const key = mediaKey(projectId, asset.id);
      const oldUrl = sessionSourcesRef.current[key]?.url;
      if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
      const playbackUrl = persisted?.mediaUrl ?? objectUrl;
      if (persisted && objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      const nextSources = { ...sessionSourcesRef.current, [key]: { url: playbackUrl, name: safeFileName, blob: file } };
      sessionSourcesRef.current = nextSources;
      setSessionSources(nextSources);
      setDocuments((current) => current.map((entry) => entry.id === projectId ? updatedDocument : entry));
      setProjects((current) => current.map((entry) => entry.id === projectId ? { ...entry, updatedAt: updatedDocument.metadata.modifiedAt } : entry));
      setSelectedMediaKey(key);
      if (objectUrl) objectUrl = null;
      notify(persisted?.mode === 'managed' ? `Managed image copy verified · ${safeFileName} · ${imageDimensions.width} × ${imageDimensions.height}.`
        : persisted?.mode === 'linked' ? `Linked external image · ${safeFileName} · ${imageDimensions.width} × ${imageDimensions.height}.`
          : `Session-only image · ${safeFileName} · ${imageDimensions.width} × ${imageDimensions.height}.`);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not read this image.', 'error'); }
    finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      mediaImportInFlightRef.current = false;
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
      setProjects((current) => current.map((project) => project.id === projectId ? {
        ...project,
        updatedAt: updatedDocument.metadata.modifiedAt,
        aspectRatio: aspectRatioOf(updatedSequence.width, updatedSequence.height),
        frameRate: updatedSequence.frameRate.numerator / updatedSequence.frameRate.denominator,
      } : project));
      notify(successMessage);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The timeline edit could not be applied.', 'error');
      return false;
    }
  }

  function toggleTrackState(trackId: string, field: 'muted' | 'locked') {
    if (!activeProjectId || persistenceWarning) return;
    const projectId = activeProjectId;
    const currentDocument = documents.find((document) => document.id === projectId);
    const sequence = currentDocument?.sequences.find((item) => item.id === currentDocument.projectSettings.defaultSequenceId);
    const track = sequence?.tracks.find((item) => item.id === trackId);
    if (!currentDocument || !sequence || !track) return;
    const action = field === 'muted' ? (track.muted ? 'Unmuted' : 'Muted') : (track.locked ? 'Unlocked' : 'Locked');
    return applyTimelineEdit(projectId, (document) => ({
      ...document,
      metadata: { ...document.metadata, modifiedAt: new Date().toISOString() },
      sequences: document.sequences.map((item) => item.id !== sequence.id ? item : {
        ...item,
        tracks: item.tracks.map((entry) => entry.id === trackId ? { ...entry, [field]: !entry[field] } : entry),
      }),
    }), `${action} ${track.name}.`);
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
      setProjects((current) => current.map((project) => project.id === projectId ? {
        ...project,
        updatedAt: updatedDocument.metadata.modifiedAt,
        aspectRatio: aspectRatioOf(targetSequence.width, targetSequence.height),
        frameRate: targetSequence.frameRate.numerator / targetSequence.frameRate.denominator,
      } : project));
      notify(direction === 'undo' ? 'Undid the last timeline change.' : 'Redid the timeline change.');
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Timeline history could not be restored.', 'error');
      return false;
    }
  }

  function undoTimelineEdit() { return changeTimelineHistory(activeProjectId, 'undo'); }
  function redoTimelineEdit() { return changeTimelineHistory(activeProjectId, 'redo'); }

  async function createNewProject(name: string, ratio: AspectRatio, fps: Project['frameRate'], dimensions: { width: number; height: number }) {
    if (persistenceWarning) {
      notify('Resolve the project storage warning before creating a project.', 'error');
      return;
    }
    try {
      const project = createProject(name, ratio, fps);
      const baseDocument = createProjectDocument(project);
      const defaultSequenceId = baseDocument.projectSettings.defaultSequenceId;
      const document = {
        ...baseDocument,
        sequences: baseDocument.sequences.map((sequence) => sequence.id === defaultSequenceId
          ? { ...sequence, width: dimensions.width, height: dimensions.height }
          : sequence),
      };
      if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 16 || dimensions.height < 16 || dimensions.width > 16384 || dimensions.height > 16384) throw new Error('Canvas dimensions must be whole pixels from 16 to 16384.');
      if (window.clipwright?.library) {
        await window.clipwright.library.saveProject({ contents: serializeProjectDocument(document) });
        setDiskSaveStates((current) => ({ ...current, [project.id]: 'saved' }));
      }
      setDocuments((current) => [...current.filter((item) => item.id !== project.id), document]);
      setProjects((current) => [project, ...current]);
      setActiveProjectId(project.id);
      setWorkspace('editor');
      completeWelcome();
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
    void openDesktopProject();
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
      completeWelcome();
      notify(idConflict ? 'Opened as a separate project copy to protect the existing project.' : `Opened “${project.name}”.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open this project file.', 'error');
    }
  }

  function openProject(project: Project) {
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, updatedAt: new Date().toISOString() } : item));
    setActiveProjectId(project.id);
    setWorkspace('editor');
    completeWelcome();
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

  async function duplicateProject(project: Project) {
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
    const copyDocument = { ...sourceDocument, id: copy.id, metadata: { ...sourceDocument.metadata, name: copy.name, createdAt: now, modifiedAt: now } };
    try {
      if (window.clipwright?.library) {
        await window.clipwright.library.saveProject({ contents: serializeProjectDocument(sourceDocument) });
        await window.clipwright.library.cloneProject({ sourceProjectId: project.id, contents: serializeProjectDocument(copyDocument) });
      }
      setProjects((current) => [copy, ...current]);
      setDocuments((current) => [...current, copyDocument]);
      notify(window.clipwright?.library ? 'Project duplicated with its managed media copied locally; linked media still points to its original.' : 'Project document duplicated. Browser-session media must be relinked after restart.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not duplicate the project safely.', 'error'); }
  }

  async function deleteProject(project: Project) {
    const confirmed = window.confirm(`Remove “${project.name}” from the project library? Its project manifest will be archived and managed/source media will not be deleted.`);
    if (!confirmed) return;
    try { await window.clipwright?.library?.archiveProject(project.id); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not archive the project safely.', 'error'); return; }
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
    notify('Project manifest archived; managed media was preserved.');
  }

  async function openPersistentDataFolder() {
    const library = window.clipwright?.library;
    if (!library) { notify('Persistent app-data folders are available in the desktop app.', 'warning'); return; }
    try { await library.openDataFolder(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not open the ClipWright data folder.', 'error'); }
  }

  async function createProjectBackup() {
    if (!activeProjectId || !window.clipwright?.library) { notify('Open a project in the desktop app before creating a backup.', 'warning'); return; }
    const includeLinked = window.confirm('Include externally linked source files in this backup? Choosing OK copies them into the backup; choosing Cancel leaves them external and lists them as not included.');
    try {
      const result = await window.clipwright.library.createBackup({ projectId: activeProjectId, includeLinked });
      if (result.canceled) return;
      notify(result.externalNotCollected.length
        ? `Backup created with ${result.externalNotCollected.length} external or unavailable media reference${result.externalNotCollected.length === 1 ? '' : 's'} not collected.`
        : 'Portable project backup created and verified.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not create a project backup.', 'error'); }
  }

  async function restoreProjectBackup() {
    const library = window.clipwright?.library;
    if (!library) { notify('Backup restoration is available in the desktop app.', 'warning'); return; }
    try {
      const result = await library.restoreBackup();
      if (result.canceled) return;
      const restored = parseProjectDocument(result.contents);
      if (restored.id !== result.documentId) throw new Error('Restored project identity is invalid.');
      const sequence = restored.sequences.find((item) => item.id === restored.projectSettings.defaultSequenceId);
      if (!sequence) throw new Error('Restored project has no default sequence.');
      const project: Project = { id: restored.id, name: restored.metadata.name, createdAt: restored.metadata.createdAt, updatedAt: restored.metadata.modifiedAt, aspectRatio: aspectRatioOf(sequence.width, sequence.height), frameRate: sequence.frameRate.numerator / sequence.frameRate.denominator, archived: false, favorite: false };
      setProjects((current) => [project, ...current.filter((entry) => entry.id !== project.id)]);
      setDocuments((current) => [restored, ...current.filter((entry) => entry.id !== restored.id)]);
      setActiveProjectId(restored.id);
      setWorkspace('editor');
      notify(`Restored “${restored.metadata.name}” from backup.`);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not restore this project backup.', 'error'); }
  }

  async function clearPersistentCache() {
    try {
      const result = await window.clipwright?.library?.clearCache();
      window.dispatchEvent(new Event('clipwright:clear-waveform-cache'));
      notify(result ? `Temporary cache cleared (${result.removedEntries} item${result.removedEntries === 1 ? '' : 's'}). Managed media, projects, and exports were preserved.` : 'In-memory waveform cache cleared.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not clear the temporary cache.', 'error'); }
  }

  const navigate = (next: Workspace) => {
    setWorkspace(next);
    if (next !== 'editor') {
      setActiveProjectId(null);
      setEditorFocusMode(false);
    }
  };

  const pageTitle = workspace === 'home' ? 'Projects' : workspace === 'clipping' ? 'AI Clipping' : activeProject?.name ?? 'Editor';

  function applySettingsCanvas(width: number, height: number, canvasFit: NonNullable<Sequence['canvasFit']>, canvasBackground: string) {
    if (!activeProjectId || !activeProjectDocument) return;
    const targetId = activeProjectDocument.projectSettings.defaultSequenceId;
    applyTimelineEdit(activeProjectId, (document) => ({
      ...document,
      sequences: document.sequences.map((sequence) => sequence.id === targetId ? { ...sequence, width, height, canvasFit, canvasBackground } : sequence),
    }), 'Updated the project canvas.');
  }

  function applySettingsFrameRate(value: number) {
    if (!activeProjectId || !activeProjectDocument) return;
    const rates: Record<number, { numerator: number; denominator: number }> = {
      23.976: { numerator: 24000, denominator: 1001 }, 24: { numerator: 24, denominator: 1 }, 25: { numerator: 25, denominator: 1 },
      29.97: { numerator: 30000, denominator: 1001 }, 30: { numerator: 30, denominator: 1 }, 50: { numerator: 50, denominator: 1 },
      59.94: { numerator: 60000, denominator: 1001 }, 60: { numerator: 60, denominator: 1 },
    };
    const frameRate = rates[value];
    if (!frameRate) return;
    const targetId = activeProjectDocument.projectSettings.defaultSequenceId;
    applyTimelineEdit(activeProjectId, (document) => ({
      ...document,
      sequences: document.sequences.map((sequence) => {
        if (sequence.id !== targetId) return sequence;
        const fps = frameRate.numerator / frameRate.denominator;
        const seconds = sequence.durationFrames * sequence.frameRate.denominator / sequence.frameRate.numerator;
        return {
          ...sequence,
          frameRate,
          durationFrames: Math.max(1, Math.round(seconds * fps)),
          tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => {
            const asset = document.assets.find((item) => item.id === clip.sourceId);
            const stream = track.kind === 'video' ? asset?.streams.video : asset?.streams.audio ?? asset?.streams.video;
            const sourceDuration = stream ? stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator : Number.POSITIVE_INFINITY;
            const maxTrimIn = Number.isFinite(sourceDuration) ? Math.max(0, sourceDuration - 1 / fps) : Number.POSITIVE_INFINITY;
            const trimIn = Math.max(0, Math.min(maxTrimIn, Math.max(0, Math.round(clip.trimIn * fps) / fps)));
            return {
              ...clip,
              start: Math.max(0, Math.round(clip.start * fps) / fps),
              trimIn,
              trimOut: Math.min(sourceDuration, Math.max(trimIn + 1 / fps, Math.round(clip.trimOut * fps) / fps)),
            };
          }) })),
        };
      }),
    }), 'Changed the project frame rate and frame-aligned timeline clips.');
  }

  if (isStorageRestoring) return <main className="workspace-restoring" role="status" aria-live="polite"><img src="/assets/clipwright-icon.png" alt="" /><span className="eyebrow">CLIPWRIGHT STUDIO</span><h1>Restoring your workspace…</h1><p>Loading your recent projects and checking their local media references.</p><div className="restore-progress" /></main>;

  return (
    <div className={`app-shell ${workspace === 'editor' ? 'is-editor' : ''} ${workspace === 'editor' && editorNavCollapsed ? 'is-editor-nav-collapsed' : ''} ${editorFocusMode ? 'is-editor-focus' : ''}`} data-testid="app-shell">
      <a className="skip-to-content" href="#main-content">Skip to main content</a>
      <aside className="rail">
        <button className="brand-lockup" onClick={() => navigate('home')} aria-label="ClipWright Studio home" title="ClipWright Studio">
          <img src="/assets/clipwright-icon.png" alt="" />
        </button>
        <div className="rail-divider" />
        <nav className="primary-nav" aria-label="Primary navigation">
          {workspaceItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${workspace === id ? 'is-active' : ''}`} onClick={() => navigate(id)} aria-current={workspace === id ? 'page' : undefined} aria-label={label} title={label}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-spacer" />
        <div className="rail-bottom">
          <button className="nav-item subtle" onClick={() => setShowTasks(true)} aria-label="Task centre" title="Task centre"><Clock3 size={18} /><span>Tasks</span></button>
          <button className="nav-item subtle" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings"><Settings2 size={18} /><span>Settings</span></button>
          <div className="local-badge"><span className="status-dot" />Local workspace</div>
        </div>
      </aside>

      <div className="main-column">
        <header className={`topbar ${workspace === 'editor' ? 'topbar-editor' : ''}`}>
          {workspace === 'editor' ? <div className="editor-topbar-leading">
            <button className="icon-button editor-nav-toggle" type="button" aria-label={editorNavCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={editorNavCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!editorNavCollapsed} onClick={() => setEditorNavCollapsed((collapsed) => !collapsed)}>{editorNavCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button>
            <div className="brand-title"><span className="wordmark">ClipWright</span><span className="brand-studio">STUDIO</span></div>
            <span className="topbar-separator" aria-hidden="true" />
            <button className="editor-back-button" type="button" onClick={() => navigate('home')} aria-label="Back to projects" title="Back to projects"><ArrowLeft size={17} /></button>
            <h1 className="editor-topbar-project" title={activeProject?.name ?? 'Editor'}>{activeProject?.name ?? 'Editor'}</h1>
            <div className="editor-meta-badges" aria-label="Project settings and save status">
              <span>{editorAspectRatio}</span><span>{editorFrameRate}</span><span className={`editor-saved ${diskSaveStates[activeProjectId ?? ''] === 'error' ? 'editor-save-error' : ''}`} title={managedProjectFiles[activeProjectId ?? ''] ? managedProjectFiles[activeProjectId ?? ''].fileName : persistentStorageRoot ?? 'Stored in this browser profile'}>{diskSaveStates[activeProjectId ?? ''] === 'saving' ? <><Save size={12} />Saving…</> : diskSaveStates[activeProjectId ?? ''] === 'error' ? <><X size={12} />Disk save failed</> : <><Check size={12} />{managedProjectFiles[activeProjectId ?? ''] ? 'Saved to file' : window.clipwright?.library ? 'Saved to library' : 'Saved locally'}</>}</span>
            </div>
          </div> : <div className="brand-title"><span className="wordmark">ClipWright</span><span className="brand-studio">STUDIO</span><span className="version-tag">EARLY ACCESS</span></div>}
          <div className="topbar-actions">
            {workspace === 'home' && <div className="top-search"><Search size={15} /><input aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" className="search-clear" aria-label="Clear project search" onClick={() => setQuery('')}><X size={13} /></button> : <kbd>⌘ K</kbd>}</div>}
            {workspace === 'editor' && <>
              <div className="topbar-action-group" role="group" aria-label="Project file actions">
                <button className="topbar-labeled-action" type="button" aria-label="Save project" title={managedProjectFiles[activeProjectId ?? ''] ? 'Save project (Ctrl+S)' : 'Save project as a .cwproject file'} onClick={() => { if (activeProject) void saveProjectFile(activeProject.id); }} disabled={!activeProject || !!persistenceWarning}><Save size={15} /><span>Save</span></button>
                <button className="topbar-labeled-action" type="button" aria-label="Open project file" title="Open a ClipWright project file" onClick={requestProjectFile}><FolderOpen size={15} /><span>Open</span></button>
                <button className="topbar-labeled-action" type="button" aria-label="Project recovery" title="Browse project recovery checkpoints" onClick={() => { if (activeProject) void openRecoveryDialog(activeProject.id); }} disabled={!activeProject || !managedProjectFiles[activeProjectId ?? '']}><History size={15} /><span>Recovery</span></button>
              </div>
              <span className="topbar-separator" aria-hidden="true" />
              <div className="topbar-action-group topbar-view-actions" role="group" aria-label="Editor view actions">
                <button className="topbar-labeled-action" type="button" aria-label="Enter focus mode" title="Focus mode — hide navigation and header" onClick={() => setEditorFocusMode(true)}><Maximize2 size={15} /><span>Focus</span></button>
                <button className="topbar-labeled-action" type="button" aria-label="Open command palette" title="Command palette (Ctrl+K)" onClick={() => setShowCommands(true)}><Command size={15} /><span>Commands</span></button>
              </div>
              <span className="topbar-separator" aria-hidden="true" />
              <div className="topbar-action-group topbar-help-actions" role="group" aria-label="Help and preferences">
                <button className="topbar-labeled-action" type="button" aria-label="Edit keyboard shortcuts" title="Settings and editable keyboard shortcuts" onClick={() => { setSettingsInitialTab('shortcuts'); setShowSettings(true); }}><Keyboard size={15} /><span>Shortcuts</span></button>
                <button className="topbar-labeled-action" type="button" aria-label="Help" title="Help and keyboard shortcuts" onClick={() => setShowHelp(true)}><CircleHelp size={15} /><span>Help</span></button>
              </div>
              <button className="button button-primary header-export-button" type="button" onClick={() => setShowExportDialog(true)} disabled={!activeProject || !activeSequence} title="Export this project sequence"><Download size={16} /><span>Export</span></button>
            </>}
            {workspace !== 'editor' && <>
              <button className="icon-button" aria-label="Open command palette" title="Command palette (Ctrl+K)" onClick={() => setShowCommands(true)}><Command size={17} /></button>
              <button className="icon-button" aria-label="Task centre" title="Task centre" onClick={() => setShowTasks(true)}><Clock3 size={17} /></button>
              <button className="icon-button" type="button" aria-label="Help and keyboard shortcuts" title="Help and keyboard shortcuts" onClick={() => setShowHelp(true)}><CircleHelp size={17} /></button>
            </>}
          </div>
        </header>
        {workspace !== 'editor' && <div className="workspace-head">
          <div className="breadcrumb">
            {workspace !== 'home' && <button className="back-button" onClick={() => navigate('home')} aria-label="Back to projects"><ArrowLeft size={16} /></button>}
            <span className="crumb-muted">Workspace</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong>
          </div>
          <div className="head-status"><span className={`status-dot ${persistenceWarning ? 'status-warning' : ''}`} />{persistenceWarning ? 'Storage needs attention' : 'All changes saved locally'}</div>
        </div>}

        <main id="main-content" tabIndex={-1} className={`content-area ${workspace === 'editor' ? 'content-area-editor' : ''}`}>
          {workspace === 'home' && (
            <section className="dashboard-view">
              <div className="welcome-row">
                <div><div className="eyebrow">YOUR CREATIVE WORKSPACE</div><h1>Projects</h1><p className="page-description">Pick up where you left off, or start something new.</p></div>
                <div className="welcome-actions"><button className="button button-secondary" onClick={requestProjectFile} disabled={!!persistenceWarning} title={persistenceWarning ? 'Resolve the storage warning before opening projects' : undefined}><Upload size={15} />Open project file</button><button className="button button-primary" onClick={() => setShowCreate(true)} disabled={!!persistenceWarning} title={persistenceWarning ? 'Resolve the storage warning before creating projects' : undefined}><Plus size={17} />New project</button></div>
              </div>
              {persistenceWarning && <div className="storage-warning" role="alert"><div><strong>{storageWarning === 'invalid-data' ? 'Project list could not be read' : documentStorageWarning === 'invalid-data' ? 'Project documents could not be read' : 'Browser storage is unavailable'}</strong><p>{storageWarning === 'invalid-data' ? 'The existing list has not been overwritten. Preserve a recovery copy before starting over.' : documentStorageWarning === 'invalid-data' ? 'The existing documents have not been overwritten. Recovery will rebuild empty documents from your project list.' : 'This browser profile cannot currently save all project data.'}</p></div>{storageWarning === 'invalid-data' ? <button className="button button-secondary button-small" onClick={startFreshProjectList}>Preserve & start fresh</button> : !storageWarning && documentStorageWarning === 'invalid-data' ? <button className="button button-secondary button-small" onClick={startFreshDocumentStore}>Preserve & rebuild</button> : null}</div>}
              <div className="dashboard-tools">
                <div className="project-tabs" role="tablist" aria-label="Project filters" onKeyDown={handleProjectTabsKeyDown}>
                  <button id="recent-projects-tab" role="tab" aria-controls="projects-filter-panel" aria-selected={!showArchived} tabIndex={showArchived ? -1 : 0} className={!showArchived ? 'selected' : ''} onClick={() => setShowArchived(false)}>Recent <span className="tab-count">{projects.filter((p) => !p.archived).length}</span></button>
                  <button id="archived-projects-tab" role="tab" aria-controls="projects-filter-panel" aria-selected={showArchived} tabIndex={showArchived ? 0 : -1} className={showArchived ? 'selected' : ''} onClick={() => setShowArchived(true)}>Archived <span className="tab-count">{projects.filter((p) => p.archived).length}</span></button>
                </div>
                <div className="project-list-controls">
                  <span className="project-result-count" aria-live="polite">{visibleProjects.length} {showArchived ? 'archived ' : ''}{visibleProjects.length === 1 ? 'project' : 'projects'}{query ? ' found' : ''}</span>
                  <label className="project-sort-control"><span>Sort by</span><select aria-label="Sort projects" className="select-input" value={projectSort} onChange={(event) => setProjectSort(event.target.value as ProjectSort)}><option value="recent">Recently edited</option><option value="name">Name</option><option value="oldest">Oldest first</option></select></label>
                </div>
              </div>
              <div id="projects-filter-panel" role="tabpanel" aria-labelledby={showArchived ? 'archived-projects-tab' : 'recent-projects-tab'} tabIndex={0}>
              {visibleProjects.length > 0 ? (
                <>
                <div className="project-grid">
                  {displayedProjects.map((project, index) => <ProjectCard key={project.id} project={project} index={index} onOpen={() => openProject(project)} onRename={() => {
                    const name = window.prompt('Rename project', project.name);
                    if (name?.trim() && updateProject(project.id, { name: name.trim() })) notify('Project renamed.');
                  }} onDuplicate={() => duplicateProject(project)} onArchive={() => { updateProject(project.id, { archived: !project.archived }); notify(project.archived ? 'Project restored.' : 'Project archived.'); }} onFavorite={() => updateProject(project.id, { favorite: !project.favorite })} onDelete={() => deleteProject(project)} onDownload={() => downloadProjectFile(project)} />)}
                </div>
                {visibleProjects.length > projectRenderLimit && <div className="project-load-more"><span>Showing {displayedProjects.length} of {visibleProjects.length}</span><button type="button" className="button button-secondary button-small" onClick={() => setProjectRenderLimit((limit) => Math.min(visibleProjects.length, limit + 60))}>Load more projects</button></div>}
                </>
              ) : query ? (
                <div className="empty-state compact-empty"><div className="empty-icon"><Search size={20} /></div><h2>No projects found</h2><p>Try another search term or clear the search.</p><button className="button button-secondary" onClick={() => setQuery('')}>Clear search</button></div>
              ) : showArchived ? (
                <div className="empty-state compact-empty"><div className="empty-icon"><Archive size={20} /></div><h2>No archived projects</h2><p>Archived project entries will appear here. Source media is never removed by archiving.</p></div>
              ) : !welcomeComplete && !isStorageRestoring && desktopLibraryReady && !persistenceWarning ? (
                <section className="first-run-welcome" aria-labelledby="first-run-title">
                  <div className="welcome-icon"><Clapperboard size={23} /></div>
                  <div className="eyebrow">WELCOME TO CLIPWRIGHT STUDIO</div>
                  <h2 id="first-run-title">Start with a project, not a setup wizard.</h2>
                  <p>Build a local timeline, bring in video or audio, and export when your browser supports the selected format. Your original media is not changed.</p>
                  <ul>
                    <li><strong>Create a project</strong><span>Choose canvas dimensions and frame rate.</span></li>
                    <li><strong>Import media</strong><span>Keep a managed copy here or link to the original file.</span></li>
                    <li><strong>Edit and export</strong><span>Use the timeline tools, then check format support in Export.</span></li>
                  </ul>
                  <div className="first-run-actions">
                    <button className="button button-primary" onClick={() => setShowCreate(true)} disabled={!!persistenceWarning}><Plus size={16} />Create your first project</button>
                    <button className="button button-secondary" onClick={requestProjectFile} disabled={!!persistenceWarning}><Upload size={15} />Open existing project</button>
                    <button className="button button-ghost" onClick={completeWelcome}>Skip onboarding</button>
                  </div>
                  <span className="first-run-note"><HardDrive size={13} />{window.clipwright?.library ? 'Your project library stays on this device.' : 'Your browser profile stores project documents.'} No sample project is included.</span>
                </section>
              ) : (
                <div className="empty-state">
                  <div className="empty-art"><div className="art-window"><div className="art-topline" /><div className="art-preview"><Film size={28} strokeWidth={1.2} /></div><div className="art-timeline"><i /><i /><i /></div></div><span className="art-spark spark-one" /><span className="art-spark spark-two" /></div>
                  <div className="eyebrow">A CLEAR START</div><h2>Make room for your next story.</h2><p>Create a project to begin. Your workspace stays on this device, and your original media remains untouched.</p>
                  <button className="button button-primary" onClick={() => setShowCreate(true)} disabled={!!persistenceWarning} title={persistenceWarning ? 'Resolve the storage warning before creating projects' : undefined}><Plus size={17} />Create your first project</button>
                  <span className="empty-footnote"><HardDrive size={13} />{window.clipwright?.library ? 'Projects restore from this device’s ClipWright library' : 'Project list stored in this browser profile'}</span>
                </div>
              )}
              </div>
              <div className="dashboard-footer"><div><span className="footer-label">WORKSPACE</span><strong>Local-first</strong><span> · Your files stay on this device</span></div><button onClick={() => setShowSettings(true)}>Preferences <ArrowRight size={13} /></button></div>
            </section>
          )}

          {workspace === 'editor' && <EditorFoundation
            project={activeProject}
            projectDocument={activeProjectDocument}
            exportDialogOpen={showExportDialog}
            onExportDialogOpenChange={setShowExportDialog}
            preferences={preferences}
            onPreferenceChange={(update) => updatePreferences(update)}
            sessionSources={sessionSources}
            selectedMediaKey={selectedMediaKey}
            isReadingMedia={isReadingMedia}
            focusMode={editorFocusMode}
            onToggleFocusMode={() => setEditorFocusMode((focus) => !focus)}
            onImportVideo={() => requestVideoImport()}
            onImportAudio={() => requestAudioImport()}
            onImportImage={() => requestImageImport()}
            onRelinkImage={(assetId) => requestImageImport(assetId)}
            onRelinkVideo={(assetId) => requestVideoImport(assetId)}
            onRelinkAudio={(assetId) => requestAudioImport(assetId)}
            onSelectMedia={setSelectedMediaKey}
            onRevealMedia={(assetId) => {
              const library = window.clipwright?.library;
              if (library && activeProjectId) void library.revealMedia({ projectId: activeProjectId, assetId }).catch((error) => notify(error instanceof Error ? error.message : 'Could not reveal this media file.', 'error'));
            }}
            mediaImportMode={mediaImportMode}
            onMediaImportModeChange={setMediaImportMode}
            hasPersistentLibrary={Boolean(window.clipwright?.library)}
            onApplyTimelineEdit={(edit, message) => activeProjectId ? applyTimelineEdit(activeProjectId, edit, message) : false}
            onToggleTrackState={toggleTrackState}
            canUndo={Boolean(!persistenceWarning && activeProjectId && timelineHistory[activeProjectId]?.past.length)}
            canRedo={Boolean(!persistenceWarning && activeProjectId && timelineHistory[activeProjectId]?.future.length)}
            onUndo={undoTimelineEdit}
            onRedo={redoTimelineEdit}
            onPlaybackError={() => notify('Browser playback failed. The file may use a codec this browser cannot decode.', 'error')}
            onNotify={notify}
          />}
          {workspace === 'clipping' && <ClippingFoundation onCreate={() => setShowCreate(true)} />}
        </main>
      </div>

      <input ref={projectFileInputRef} hidden type="file" accept=".cwproject,application/json" aria-label="Choose a ClipWright project file" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importProjectFile(file); }} />
      <input ref={videoFileInputRef} hidden type="file" accept="video/*,.mp4,.m4v,.mov,.webm,.ogv,.avi" aria-label="Choose a local video file" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importVideoFile(file); }} />
      <input ref={audioFileInputRef} hidden type="file" accept="audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.oga,.ogg,.opus,.wav,.weba" aria-label="Choose a local audio file" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importAudioFile(file); }} />
      <input ref={imageFileInputRef} hidden type="file" accept="image/*,.avif,.bmp,.gif,.heic,.heif,.jpeg,.jpg,.png,.tif,.tiff,.webp" aria-label="Choose a local image file" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importImageFile(file); }} />
      {showCreate && <CreateProjectDialog onClose={() => setShowCreate(false)} onCreate={createNewProject} />}
      {recoveryProjectId && <RecoveryDialog projectName={projects.find((project) => project.id === recoveryProjectId)?.name ?? 'Project'} points={recoveryPoints} restoring={isRestoringRecovery} onRestore={(point) => { void restoreRecoveryPoint(point); }} onClose={() => { if (!isRestoringRecovery) setRecoveryProjectId(null); }} />}
      {showSettings && <SettingsDialog
        initialTab={settingsInitialTab}
        theme={theme}
        onTheme={setTheme}
        preferences={preferences}
        onPreferencesChange={(update) => updatePreferences(update)}
        project={activeProject}
        projectDocument={activeProjectDocument}
        onRenameProject={(name) => { if (activeProject && updateProject(activeProject.id, { name })) notify('Project renamed.'); }}
        onApplyCanvas={applySettingsCanvas}
        onApplyFrameRate={applySettingsFrameRate}
        storageRoot={persistentStorageRoot}
        storageIssue={persistentStorageIssue}
        onOpenStorageFolder={() => { void openPersistentDataFolder(); }}
        onCreateBackup={() => { void createProjectBackup(); }}
        onRestoreBackup={() => { void restoreProjectBackup(); }}
        onClearCache={() => { void clearPersistentCache(); }}
        onReset={() => { updatePreferences(() => structuredClone(DEFAULT_EDITOR_PREFERENCES)); setTheme('dark'); }}
        onClose={() => setShowSettings(false)}
      />}
      {showHelp && <HelpDialog canTour={workspace === 'editor' && Boolean(activeProject)} onStartTour={() => { setShowHelp(false); setShowGuidedTour(true); }} onClose={() => setShowHelp(false)} />}
      {showGuidedTour && workspace === 'editor' && <GuidedTour onClose={() => setShowGuidedTour(false)} />}
      {showCommands && <CommandDialog inputRef={searchRef} onClose={() => setShowCommands(false)} actions={[
        { label: 'Create a new project', shortcut: 'Ctrl+N', icon: FilePlus2, run: () => { setShowCommands(false); if (persistenceWarning) notify('Resolve the project storage warning before creating a project.', 'error'); else setShowCreate(true); } },
        { label: 'Open a project file', icon: Upload, run: () => { setShowCommands(false); requestProjectFile(); } },
        { label: 'Go to Projects', shortcut: 'G then P', icon: Home, run: () => { navigate('home'); setShowCommands(false); } },
        { label: 'Open AI Clipping', icon: Sparkles, run: () => { navigate('clipping'); setShowCommands(false); } },
        { label: 'Open Editor workspace', icon: Clapperboard, run: () => { if (activeProject) setWorkspace('editor'); else notify('Create or open a project before entering the editor.', 'error'); setShowCommands(false); } },
        { label: 'Open Task Centre', icon: Clock3, run: () => { setShowCommands(false); setShowTasks(true); } },
        { label: 'Open Preferences', icon: Settings2, run: () => { setShowCommands(false); setShowSettings(true); } },
        { label: 'Open Help and keyboard shortcuts', icon: CircleHelp, run: () => { setShowCommands(false); setShowHelp(true); } },
      ]} />}
      {showTasks && <TaskDrawer onClose={() => setShowTasks(false)} />}
      {toast && <div className={`toast ${toast.kind === 'error' ? 'toast-error' : toast.kind === 'warning' ? 'toast-warning' : ''}`} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true"><span className="toast-mark" aria-hidden="true">{toast.kind === 'error' || toast.kind === 'warning' ? '!' : <Check size={14} />}</span>{toast.message}<button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function ProjectCard({ project, index, onOpen, onRename, onDuplicate, onArchive, onFavorite, onDelete, onDownload }: { project: Project; index: number; onOpen: () => void; onRename: () => void; onDuplicate: () => void; onArchive: () => void; onFavorite: () => void; onDelete: () => void; onDownload: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menuOpen]);
  function closeMenu(restoreFocus = true) {
    setMenuOpen(false);
    if (restoreFocus) menuTriggerRef.current?.focus();
  }
  return <article className="project-card" style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}>
    <button className={`project-thumb thumb-${index % 4}`} onClick={onOpen} aria-label={`Open ${project.name}`}>
      <span className="thumb-frame"><Film size={24} strokeWidth={1.25} /></span><span className="thumb-empty">No media yet</span>
      <span className="aspect-pill">{project.aspectRatio}</span>
    </button>
    <div className="project-card-info">
      <div className="project-name-row"><button className="project-name" onClick={onOpen}>{project.name}</button>{project.favorite && <Heart size={13} fill="currentColor" className="favorite-mark" />}</div>
      <div className="project-meta">Edited {readableDate(project.updatedAt)} <span>·</span> {formatFrameRate(project.frameRate)}</div>
    </div>
    <button ref={menuTriggerRef} type="button" className="card-menu-trigger" aria-label={`More actions for ${project.name}`} aria-expanded={menuOpen} aria-controls={`project-actions-${project.id}`} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
    {menuOpen && <><div className="click-away" aria-hidden="true" onClick={() => closeMenu(false)} /><div ref={menuRef} id={`project-actions-${project.id}`} className="project-menu" role="group" aria-label={`Actions for ${project.name}`} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); } }}>
      <button type="button" onClick={() => { onOpen(); closeMenu(false); }}><FolderOpen size={14} />Open project</button>
      <button type="button" onClick={() => { onRename(); closeMenu(); }}><FilePlus2 size={14} />Rename</button>
      <button type="button" onClick={() => { onDuplicate(); closeMenu(); }}><Grid2X2 size={14} />Duplicate project</button>
      <button type="button" onClick={() => { onDownload(); closeMenu(); }}><Download size={14} />Download .cwproject</button>
      <button type="button" onClick={() => { onFavorite(); closeMenu(); }}><Heart size={14} />{project.favorite ? 'Remove favourite' : 'Add to favourites'}</button>
      <button type="button" onClick={() => { onArchive(); closeMenu(); }}><Archive size={14} />{project.archived ? 'Restore' : 'Archive'}</button>
      <div className="menu-divider" /><button type="button" className="danger-item" onClick={() => { onDelete(); closeMenu(false); }}><Trash2 size={14} />Delete entry</button>
    </div></>}
  </article>;
}

function useDialogFocusTrap<T extends HTMLElement>(initialFocus?: () => HTMLElement | null) {
  const containerRef = useRef<T>(null);
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusableElements = () => [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.getAttribute('aria-hidden') !== 'true' && !element.closest('[aria-hidden="true"]'));
    const firstFocus = initialFocusRef.current?.() ?? focusableElements()[0] ?? container;
    firstFocus.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      if (!elements.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const currentIndex = elements.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? elements.length - 1 : currentIndex - 1
        : currentIndex < 0 || currentIndex === elements.length - 1 ? 0 : currentIndex + 1;
      event.preventDefault();
      elements[nextIndex].focus();
    };
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return containerRef;
}

function CreateProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, ratio: AspectRatio, fps: Project['frameRate'], dimensions: { width: number; height: number }) => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [ratio, setRatio] = useState<AspectRatio | 'custom'>('16:9');
  const [width, setWidth] = useState('1920');
  const [height, setHeight] = useState('1080');
  const [fps, setFps] = useState<Project['frameRate']>(30);
  const frameRateOptions: Array<{ value: number; label: string }> = [
    { value: 23.976, label: '23.976 fps (24000/1001)' },
    { value: 24, label: '24 fps' },
    { value: 25, label: '25 fps' },
    { value: 29.97, label: '29.97 fps (30000/1001)' },
    { value: 30, label: '30 fps' },
    { value: 50, label: '50 fps' },
    { value: 59.94, label: '59.94 fps (60000/1001)' },
    { value: 60, label: '60 fps' },
  ];
  const fieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLElement>(() => fieldRef.current);
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="dialog create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <div className="dialog-head"><div className="dialog-icon"><FilePlus2 size={17} /></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button></div>
      <div className="eyebrow">NEW WORKSPACE</div><h2 id="create-title">Create a project</h2><p className="dialog-copy">Set up your sequence. You can change these settings later.</p>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (isCreating) return;
        const numericWidth = Number(width);
        const numericHeight = Number(height);
        setIsCreating(true);
        try { await onCreate(name, aspectRatioOf(numericWidth, numericHeight) as AspectRatio, fps, { width: numericWidth, height: numericHeight }); }
        finally { setIsCreating(false); }
      }}>
        <label className="field-label" htmlFor="project-name">Project name</label><input ref={fieldRef} id="project-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Summer campaign" maxLength={80} required />
        <div className="form-row"><div><label className="field-label" htmlFor="aspect-ratio">Aspect ratio</label><select id="aspect-ratio" className="select-input" value={ratio} onChange={(event) => {
          const next = event.target.value as AspectRatio | 'custom';
          setRatio(next);
          const presets: Record<string, { width: number; height: number }> = {
            '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 },
            '4:3': { width: 1440, height: 1080 }, '3:4': { width: 1080, height: 1440 }, '4:5': { width: 1080, height: 1350 },
            '5:4': { width: 1350, height: 1080 }, '21:9': { width: 2520, height: 1080 },
          };
          if (presets[next]) { setWidth(String(presets[next].width)); setHeight(String(presets[next].height)); }
        }}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>4:5</option><option>5:4</option><option>21:9</option><option value="custom">Custom</option></select></div><div><label className="field-label" htmlFor="frame-rate">Frame rate</label><select id="frame-rate" className="select-input" value={fps} onChange={(event) => setFps(Number(event.target.value) as Project['frameRate'])}>{frameRateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></div>
        <div className="form-row"><div><label className="field-label" htmlFor="project-canvas-width">Canvas width (px)</label><input id="project-canvas-width" className="text-input" type="number" min="16" max="16384" step="1" value={width} onChange={(event) => setWidth(event.target.value)} required /></div><div><label className="field-label" htmlFor="project-canvas-height">Canvas height (px)</label><input id="project-canvas-height" className="text-input" type="number" min="16" max="16384" step="1" value={height} onChange={(event) => setHeight(event.target.value)} required /></div></div>
        <div className="local-note"><HardDrive size={14} /><span>{window.clipwright?.library ? 'Project details autosave to the local ClipWright library. Media is copied only when you choose Managed copy during import.' : 'Project details stay in this browser profile; media sources are session-only until you reopen them.'}</span></div>
        <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={isCreating}>Cancel</button><button type="submit" className="button button-primary" disabled={isCreating}><Plus size={15} />{isCreating ? 'Creating…' : 'Create project'}</button></div>
      </form>
    </section>
  </div>;
}

function EditorFoundation({
  project, projectDocument, exportDialogOpen, onExportDialogOpenChange, preferences, onPreferenceChange, sessionSources, selectedMediaKey, isReadingMedia, focusMode, onToggleFocusMode,
  onImportVideo, onImportAudio, onImportImage, onRelinkVideo, onRelinkAudio, onRelinkImage, onSelectMedia, onRevealMedia, mediaImportMode, onMediaImportModeChange, hasPersistentLibrary, onToggleTrackState, onApplyTimelineEdit,
  canUndo, canRedo, onUndo, onRedo, onPlaybackError, onNotify,
}: {
  project: Project | null;
  projectDocument: ProjectDocument | null;
  exportDialogOpen: boolean;
  onExportDialogOpenChange: (open: boolean) => void;
  preferences: EditorPreferences;
  onPreferenceChange: (update: (current: EditorPreferences) => EditorPreferences) => void;
  sessionSources: Record<string, SessionMediaSource>;
  selectedMediaKey: string | null;
  isReadingMedia: boolean;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  onImportVideo: () => void;
  onImportAudio: () => void;
  onImportImage: () => void;
  onRelinkVideo: (assetId: string) => void;
  onRelinkAudio: (assetId: string) => void;
  onRelinkImage: (assetId: string) => void;
  onSelectMedia: (key: string) => void;
  onRevealMedia: (assetId: string) => void;
  mediaImportMode: 'managed' | 'linked';
  onMediaImportModeChange: (mode: 'managed' | 'linked') => void;
  hasPersistentLibrary: boolean;
  onToggleTrackState: (trackId: string, field: 'muted' | 'locked') => void;
  onApplyTimelineEdit: (edit: (document: ProjectDocument) => ProjectDocument, message: string) => boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => boolean;
  onRedo: () => boolean;
  onPlaybackError: () => void;
  onNotify: (message: string, kind?: Toast['kind']) => void;
}) {
  const sequence = projectDocument?.sequences.find((item) => item.id === projectDocument.projectSettings.defaultSequenceId) ?? null;
  const assets = projectDocument?.assets ?? [];
  const tracks = sequence?.tracks ?? [];
  const frameRateValue = sequence ? sequence.frameRate.numerator / sequence.frameRate.denominator : project?.frameRate ?? 30;
  const sequenceLength = sequence ? sequenceDurationSeconds(sequence) : 0;
  const minimumTimelineSeconds = sequenceLength > 0 ? sequenceLength : 20;
  const allClips = tracks.flatMap((track) => track.clips);
  const videoClips = tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips);
  const audioClips = tracks.filter((track) => track.kind === 'audio').flatMap((track) => track.clips);
  const timelineTrackRowTemplate = `repeat(${Math.max(1, tracks.length)}, 60px)`;
  const playableAsset = assets.find((asset) => asset.kind === 'video' && mediaKey(projectDocument?.id ?? '', asset.id) === selectedMediaKey)
    ?? assets.find((asset) => asset.kind === 'video') ?? null;
  const selectedMediaExists = Boolean(projectDocument && assets.some((asset) => mediaKey(projectDocument.id, asset.id) === selectedMediaKey));
  const activeKey = selectedMediaExists ? selectedMediaKey : (playableAsset && projectDocument ? mediaKey(projectDocument.id, playableAsset.id) : null);
  const activeMediaAsset = activeKey && projectDocument ? assets.find((asset) => mediaKey(projectDocument.id, asset.id) === activeKey) ?? null : null;

  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [mediaPanelCollapsed, setMediaPanelCollapsed] = useState(false);
  const [propertiesPanelCollapsed, setPropertiesPanelCollapsed] = useState(() => { try { return window.localStorage.getItem('clipwright.workspace.properties-collapsed') === 'true'; } catch { return false; } });
  const [timelineTime, setTimelineTimeState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeDeck, setActiveDeck] = useState(0);
  const [deckUrls, setDeckUrls] = useState<[string | null, string | null]>([null, null]);
  const [deckReady, setDeckReady] = useState<[boolean, boolean]>([false, false]);
  const [timelineVideoVisible, setTimelineVideoVisible] = useState(false);
  const hiddenTrackIds = useMemo(() => Object.fromEntries(tracks.filter((track) => track.hidden).map((track) => [track.id, true])), [tracks]);
  const soloTrackIds = useMemo(() => tracks.filter((track) => track.solo).map((track) => track.id), [tracks]);
  const [timelineScrollOffsets, setTimelineScrollOffsets] = useState({ left: 0, top: 0 });
  const [snapEnabled, setSnapEnabled] = useState(preferences.editor.snapEnabled);
  const [rippleMode, setRippleMode] = useState(preferences.editor.rippleMode);
  const [dragPreview, setDragPreview] = useState<{ items: TimelineClip[]; guide: number | null } | null>(null);
  const [dropPreview, setDropPreview] = useState<{ trackId: string; start: number; duration: number; guide: number | null } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null);
  const contextMenuInvokerRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRestoreFocusRef = useRef(true);
  const [timelineHeight, setTimelineHeight] = useState(readTimelineHeight);
  const [mediaPanelWidth, setMediaPanelWidth] = useState(() => readPanelWidth(MEDIA_PANEL_WIDTH_KEY, 240));
  const [propertiesPanelWidth, setPropertiesPanelWidth] = useState(() => readPanelWidth(PROPERTIES_PANEL_WIDTH_KEY, 260));
  const [pxPerSecond, setPxPerSecond] = useState(readTimelinePxPerSecond);
  const [editorLayoutSize, setEditorLayoutSize] = useState({ width: 0, height: 0 });
  const [timelineViewportSize, setTimelineViewportSize] = useState({ width: 0, height: 0 });
  const [startFrameDraft, setStartFrameDraft] = useState('0');
  const [sourceInDraft, setSourceInDraft] = useState('0');
  const [sourceOutDraft, setSourceOutDraft] = useState('0');
  const [audioControlsDraft, setAudioControlsDraft] = useState<{ trackId: string; gain: number; pan: number } | null>(null);
  const audioControlsDraftRef = useRef<{ trackId: string; gain: number; pan: number } | null>(null);
  const [audioWaveforms, setAudioWaveforms] = useState<Record<string, { sourceUrl: string; peaks: number[] }>>({});
  const [waveformLoadingAssetId, setWaveformLoadingAssetId] = useState<string | null>(null);
  const waveformGenerationRef = useRef<Record<string, number>>({});
  const waveformContextRef = useRef<AudioContext | null>(null);
  const currentSessionSourcesRef = useRef(sessionSources);
  currentSessionSourcesRef.current = sessionSources;
  const [volume, setVolume] = useState(preferences.audio.masterVolume);
  const [playbackError, setPlaybackError] = useState(false);
  const [previewSyncRevision, setPreviewSyncRevision] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [isSavingExport, setIsSavingExport] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResolution, setExportResolution] = useState<ExportResolutionPreset>(preferences.export.resolution);
  const [exportQuality, setExportQuality] = useState<ExportQualityPreset>(preferences.export.quality);
  const [exportContainer, setExportContainer] = useState<'webm' | 'mp4'>(preferences.export.container);
  const [exportFilename, setExportFilename] = useState('');
  const [exportFolder, setExportFolder] = useState<{ handle: string; folderName: string } | null>(null);
  const exportFolderChosenByUserRef = useRef(false);
  const [exportSavedFile, setExportSavedFile] = useState<{ handle: string; fileName: string; folderName: string } | null>(null);
  const [exportSaveError, setExportSaveError] = useState<string | null>(null);
  const [lastExportSpeedFactor, setLastExportSpeedFactor] = useState<number | null>(() => {
    try { const value = Number(window.localStorage.getItem('clipwright.export.speed-factor')); return Number.isFinite(value) && value > 0 && value < 20 ? value : null; }
    catch { return null; }
  });
  const [mp4Capability, setMp4Capability] = useState<{ pending: boolean; supported: boolean; reason: string | null }>({ pending: true, supported: false, reason: null });
  const mp4AudioRequired = Boolean(sequence && tracks.some((track) => !track.muted && !hiddenTrackIds[track.id]
    && (!soloTrackIds.length || soloTrackIds.includes(track.id))
    && track.clips.some((clip) => track.kind === 'audio' || Boolean(assets.find((asset) => asset.id === clip.sourceId)?.streams.audio))));
  const mp4Dimensions = sequence ? getExportDimensions(sequence.width, sequence.height, exportResolution) : null;
  const mp4Bitrates = sequence && mp4Dimensions ? getExportBitrates(mp4Dimensions.width, mp4Dimensions.height, frameRateValue, exportQuality) : null;
  const exportEstimatedBytes = mp4Bitrates && sequenceLength > 0
    ? Math.ceil((mp4Bitrates.videoBitsPerSecond + (mp4AudioRequired ? mp4Bitrates.audioBitsPerSecond : 0)) * sequenceLength / 8 * 1.05)
    : null;
  const defaultExportFilename = `${project?.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'ClipWright-export'}${exportResolution === 'sequence' || !mp4Dimensions ? '' : `-${mp4Dimensions.width}x${mp4Dimensions.height}`}${exportQuality === 'standard' ? '' : `-${exportQuality}`}`;
  useEffect(() => { setExportFilename(defaultExportFilename); }, [defaultExportFilename]);
  useEffect(() => {
    if (isExportingRef.current) return;
    setExportContainer(preferences.export.container);
    setExportQuality(preferences.export.quality);
    setExportResolution(preferences.export.resolution);
  }, [preferences.export.container, preferences.export.quality, preferences.export.resolution]);
  useEffect(() => {
    const exportFiles = window.clipwright?.exportFiles;
    if (!exportFiles) return;
    let active = true;
    void exportFiles.getDefaultFolder().then((result) => {
      if (active && !result.canceled && !exportFolderChosenByUserRef.current) setExportFolder({ handle: result.handle, folderName: result.folderName });
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!sequence || !mp4Dimensions || !mp4Bitrates) {
      setMp4Capability({ pending: false, supported: false, reason: 'Open a sequence to check MP4 support.' });
      return;
    }
    let active = true;
    setMp4Capability({ pending: true, supported: false, reason: null });
    void checkMp4EncodingSupport({
      width: mp4Dimensions.width,
      height: mp4Dimensions.height,
      frameRate: frameRateValue,
      videoBitrate: mp4Bitrates.videoBitsPerSecond,
      audioBitrate: mp4Bitrates.audioBitsPerSecond,
      audioSampleRate: sequence.audioSampleRate,
      includeAudio: mp4AudioRequired,
    }).then((capability) => {
      if (active) setMp4Capability({ pending: false, supported: capability.supported, reason: capability.reason });
    }).catch((error) => {
      if (active) setMp4Capability({ pending: false, supported: false, reason: error instanceof Error ? error.message : 'WebCodecs capability checks failed.' });
    });
    return () => { active = false; };
  }, [sequence?.id, sequence?.width, sequence?.height, sequence?.audioSampleRate, frameRateValue, exportResolution, exportQuality, mp4AudioRequired, mp4Dimensions?.width, mp4Dimensions?.height, mp4Bitrates?.videoBitsPerSecond, mp4Bitrates?.audioBitsPerSecond]);
  const isExportingRef = useRef(false);

  const editorLayoutRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineTrackHeaderRowsRef = useRef<HTMLDivElement>(null);
  const timelineRulerContentRef = useRef<HTMLDivElement>(null);
  const timelineRulerPlayheadRef = useRef<HTMLDivElement>(null);
  const timelinePlayheadRef = useRef<HTMLDivElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const videoRefs = [videoARef, videoBRef] as const;
  const audioElementRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const audioElementRefCallbacks = useRef<Record<string, (element: HTMLAudioElement | null) => void>>({});
  const audioPlayRequestRef = useRef(new Set<string>());
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  const exportAudioGraphRef = useRef<{ context: AudioContext; destination: MediaStreamAudioDestinationNode; gains: Map<HTMLMediaElement, GainNode>; panners: Map<HTMLMediaElement, StereoPannerNode> } | null>(null);
  const deckUrlsRef = useRef<[string | null, string | null]>([null, null]);
  const deckSourceIdsRef = useRef<[string | null, string | null]>([null, null]);
  const pendingSeekRef = useRef<[number | null, number | null]>([null, null]);
  const playRequestRef = useRef<[boolean, boolean]>([false, false]);
  const activeDeckRef = useRef(0);
  const activeClipRef = useRef<string | null>(null);
  const forcePreviewSyncRef = useRef(false);
  const timelineTimeRef = useRef(0);
  const autoFollowRef = useRef(true);
  const suppressProgrammaticScrollRef = useRef(false);
  const rulerPointerRef = useRef<number | null>(null);
  const dragRef = useRef<{ pointerId: number; mode: 'move' | 'trim-left' | 'trim-right'; primaryId: string; ids: string[]; originals: TimelineClip[]; startX: number; startY: number; moved: boolean; targetTrackId: string } | null>(null);
  const marqueeRef = useRef<{ pointerId: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const suppressClearClickRef = useRef(false);
  const suppressClipClickRef = useRef(false);
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);
  const zoomPreferenceMountedRef = useRef(false);
  const panelResizeStartRef = useRef<{ side: 'media' | 'properties'; x: number; width: number } | null>(null);
  const timelineHeightRef = useRef(0);
  const clipboardRef = useRef<TimelineClip[]>([]);
  const mediaDragSourceRef = useRef<string | null>(null);
  const [clipboardClips, setClipboardClips] = useState<TimelineClip[]>([]);

  const timelineProjectSeconds = Math.max(minimumTimelineSeconds, dropPreview ? dropPreview.start + dropPreview.duration : 0);
  const selectedClips = allClips.filter((clip) => selectedClipIds.includes(clip.id));
  const selectedClip = selectedClips[0] ?? null;
  const selectedClipTrack = selectedClip ? tracks.find((track) => track.id === selectedClip.trackId) ?? null : null;
  const selectedClipAsset = selectedClip ? assets.find((asset) => asset.id === selectedClip.sourceId) ?? null : null;
  const selectedAudioSource = selectedClipAsset?.kind === 'audio' && projectDocument ? sessionSources[mediaKey(projectDocument.id, selectedClipAsset.id)] : undefined;
  const selectedAudioWaveform = selectedClipAsset?.kind === 'audio' && selectedAudioSource && audioWaveforms[selectedClipAsset.id]?.sourceUrl === selectedAudioSource.url ? audioWaveforms[selectedClipAsset.id] : null;
  const activeTimelineClip = videoClips
    .filter((clip) => !hiddenTrackIds[clip.trackId] && timelineTime >= clip.start - 1e-7 && timelineTime < clipEnd(clip) - 1e-7)
    .sort((a, b) => tracks.findIndex((track) => track.id === b.trackId) - tracks.findIndex((track) => track.id === a.trackId))[0] ?? null;
  const activeTimelineAsset = activeTimelineClip ? assets.find((asset) => asset.id === activeTimelineClip.sourceId) ?? null : null;
  const missingMediaIds = [...new Set(allClips.filter((clip) => projectDocument && !sessionSources[mediaKey(projectDocument.id, clip.sourceId)]).map((clip) => clip.sourceId))];
  const missingMediaAssets = missingMediaIds.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is MediaAsset => Boolean(asset));
  const activeTimelineTrackMuted = Boolean(activeTimelineClip && (tracks.find((track) => track.id === activeTimelineClip.trackId)?.muted || (soloTrackIds.length > 0 && !soloTrackIds.includes(activeTimelineClip.trackId))));
  const activeTimelineAudioClips = audioClips.filter((clip) => {
    const track = tracks.find((item) => item.id === clip.trackId);
    return track && !track.muted && !hiddenTrackIds[track.id] && (!soloTrackIds.length || soloTrackIds.includes(track.id)) && timelineTime >= clip.start - 1e-7 && timelineTime < clipEnd(clip) - 1e-7;
  });
  const activeTimelineAudioClip = activeTimelineAudioClips[0] ?? null;
  const activeTimelineAudioAsset = activeTimelineAudioClip ? assets.find((asset) => asset.id === activeTimelineAudioClip.sourceId) ?? null : null;

  const timelineViewportWidth = timelineViewportSize.width || Math.max(320, window.innerWidth - 714);
  const timelineViewportHeight = timelineViewportSize.height || 240;
  const maximumPxPerSecond = frameRateValue * 30;
  const minimumPxPerSecond = Math.min(timelineViewportWidth / (timelineProjectSeconds * 1.15), maximumPxPerSecond);
  const timelineScale = Math.max(minimumPxPerSecond, Math.min(pxPerSecond || minimumPxPerSecond, maximumPxPerSecond));
  const timelineTotalSeconds = timelineProjectSeconds * 1.15;
  const timelineContentWidth = Math.ceil(Math.max(timelineViewportWidth, timelineTotalSeconds * timelineScale));
  const timelineCanvasFrames = Math.ceil(timelineContentWidth / timelineScale * frameRateValue);
  const timelineRowsContentHeight = Math.max(timelineViewportHeight, Math.max(1, tracks.length) * 60);
  const rulerStepSeconds = chooseRulerStep(timelineScale, frameRateValue);
  const rulerMinorStepSeconds = rulerStepSeconds <= 5 / frameRateValue + 1e-7 ? 1 / frameRateValue : rulerStepSeconds / 5;
  const rulerMajorEvery = Math.max(1, Math.round(rulerStepSeconds / rulerMinorStepSeconds));
  const firstRulerTick = Math.max(0, Math.floor((timelineScrollOffsets.left / timelineScale - rulerStepSeconds * 2) / rulerMinorStepSeconds));
  const lastRulerTick = Math.min(Math.ceil(timelineTotalSeconds / rulerMinorStepSeconds), Math.ceil(((timelineScrollOffsets.left + timelineViewportWidth) / timelineScale + rulerStepSeconds * 2) / rulerMinorStepSeconds));
  const timelineTicks = Array.from({ length: Math.max(0, lastRulerTick - firstRulerTick + 1) }, (_, offset) => {
    const index = firstRulerTick + offset;
    return { index, seconds: index * rulerMinorStepSeconds, major: index % rulerMajorEvery === 0 };
  });
  const editorAvailableHeight = editorLayoutSize.height || Math.max(360, window.innerHeight - (focusMode ? 0 : 62));
  const previewMinHeight = Math.floor(editorAvailableHeight * 0.3);
  const previewMaxHeight = Math.floor(editorAvailableHeight * 0.75);
  const timelineMinHeight = Math.max(TIMELINE_MIN_PANEL_HEIGHT, Math.ceil(editorAvailableHeight - previewMaxHeight - TIMELINE_RESIZE_HANDLE_HEIGHT));
  const timelineMaxHeight = Math.max(timelineMinHeight, Math.floor(editorAvailableHeight - previewMinHeight - TIMELINE_RESIZE_HANDLE_HEIGHT));
  const effectiveTimelineHeight = Math.max(timelineMinHeight, Math.min(timelineHeight || Math.round(editorAvailableHeight * 0.4), timelineMaxHeight));
  const previewHeight = Math.max(0, editorAvailableHeight - effectiveTimelineHeight - TIMELINE_RESIZE_HANDLE_HEIGHT);
  const previewHeightPercent = Math.round(previewHeight / Math.max(1, editorAvailableHeight) * 100);
  const ratio = sequence ? aspectRatioOf(sequence.width, sequence.height) : project?.aspectRatio ?? '16:9';
  const frameRate = sequence ? formatFrameRate(frameRateValue) : formatFrameRate(project?.frameRate ?? 30);
  const timecodeFrame = Math.round(timelineTime * frameRateValue);

  function requestPreviewRefresh() {
    forcePreviewSyncRef.current = true;
    setPreviewSyncRevision((revision) => revision + 1);
  }
  function toggleSnapPreference() {
    const next = !snapEnabled;
    setSnapEnabled(next);
    onPreferenceChange((current) => ({ ...current, editor: { ...current.editor, snapEnabled: next } }));
  }
  function toggleRipplePreference() {
    const next = !rippleMode;
    setRippleMode(next);
    onPreferenceChange((current) => ({ ...current, editor: { ...current.editor, rippleMode: next } }));
  }
  function setPreviewVolume(value: number) {
    const next = Math.max(0, Math.min(1, value));
    setVolume(next);
    onPreferenceChange((current) => ({ ...current, audio: { ...current.audio, masterVolume: next } }));
  }
  function persistTimelineEdit(edit: (document: ProjectDocument) => ProjectDocument, message: string) {
    const applied = onApplyTimelineEdit(edit, message);
    if (applied) requestPreviewRefresh();
    return applied;
  }
  function addTimelineTrack(kind: Track['kind']) {
    if (!sequence || !projectDocument) return;
    const trackNumber = sequence.tracks.filter((track) => track.kind === kind).length + 1;
    const newTrack: Track = {
      id: crypto.randomUUID(),
      name: `${kind === 'video' ? 'Video' : 'Audio'} ${trackNumber}`,
      kind,
      muted: kind === 'audio' && preferences.audio.defaultAudioMuted,
      locked: false,
      clips: [],
    };
    persistTimelineEdit((document) => ({
      ...document,
      sequences: document.sequences.map((item) => item.id === sequence.id ? { ...item, tracks: [...item.tracks, newTrack] } : item),
    }), `Added ${newTrack.name} track.`);
  }

  function applyCanvasSettings(width: number, height: number, canvasFit: NonNullable<Sequence['canvasFit']>, canvasBackground: string) {
    if (!sequence) return false;
    return persistTimelineEdit((document) => ({
      ...document,
      sequences: document.sequences.map((item) => item.id === sequence.id
        ? { ...item, width, height, canvasFit, canvasBackground }
        : item),
    }), `Updated project canvas to ${width} × ${height} pixels.`);
  }
  function undoTimelineEdit() {
    const applied = onUndo();
    if (applied) requestPreviewRefresh();
    return applied;
  }
  function redoTimelineEdit() {
    const applied = onRedo();
    if (applied) requestPreviewRefresh();
    return applied;
  }

  function updateAudioControlDraft(track: Track, field: 'gain' | 'pan', value: number) {
    const current = audioControlsDraftRef.current?.trackId === track.id
      ? audioControlsDraftRef.current
      : { trackId: track.id, gain: track.gain ?? 1, pan: track.pan ?? 0 };
    const next = { ...current, [field]: value };
    audioControlsDraftRef.current = next;
    setAudioControlsDraft(next);
  }

  function commitAudioControlDraft() {
    const draft = audioControlsDraftRef.current;
    if (!draft || !sequence) return;
    audioControlsDraftRef.current = null;
    setAudioControlsDraft(null);
    const trackName = tracks.find((track) => track.id === draft.trackId)?.name ?? 'audio track';
    persistTimelineEdit((document) => ({
      ...document,
      metadata: { ...document.metadata, modifiedAt: new Date().toISOString() },
      sequences: document.sequences.map((item) => item.id === sequence.id
        ? { ...item, tracks: item.tracks.map((track) => track.id === draft.trackId ? { ...track, gain: draft.gain, pan: draft.pan } : track) }
        : item),
    }), `Updated ${trackName} gain and pan.`);
  }

  function updateTrackRenderState(trackId: string, field: 'hidden' | 'solo') {
    if (!sequence) return;
    const track = tracks.find((item) => item.id === trackId);
    if (!track) return;
    const nextValue = !track[field];
    const verb = field === 'hidden' ? (nextValue ? 'Hid' : 'Showed') : (nextValue ? 'Soloed' : 'Unsoloed');
    persistTimelineEdit((document) => ({
      ...document,
      metadata: { ...document.metadata, modifiedAt: new Date().toISOString() },
      sequences: document.sequences.map((item) => item.id === sequence.id
        ? { ...item, tracks: item.tracks.map((candidate) => candidate.id === trackId ? { ...candidate, [field]: nextValue } : candidate) }
        : item),
    }), `${verb} ${track.name}; this render state is saved with the project.`);
  }

  function toggleTrackSolo(trackId: string) {
    updateTrackRenderState(trackId, 'solo');
  }

  async function generateAudioWaveform(asset: MediaAsset) {
    if (asset.kind !== 'audio' || !projectDocument) return;
    const key = mediaKey(projectDocument.id, asset.id);
    const source = sessionSources[key];
    if (!source) {
      onNotify('Relink this audio source before generating its waveform.', 'warning');
      return;
    }
    const stream = asset.streams.audio;
    const durationSeconds = stream ? stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator : 0;
    if (asset.fileSizeBytes !== undefined && asset.fileSizeBytes > 20 * 1024 * 1024) {
      onNotify('Waveform preview is limited to local audio files up to 20 MB.', 'warning');
      return;
    }
    if (durationSeconds > 180) {
      onNotify('Waveform preview is limited to audio clips up to 3 minutes.', 'warning');
      return;
    }
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor || typeof AudioContextConstructor.prototype.decodeAudioData !== 'function') {
      onNotify('This browser does not support local waveform decoding.', 'warning');
      return;
    }
    const requestId = (waveformGenerationRef.current[asset.id] ?? 0) + 1;
    waveformGenerationRef.current[asset.id] = requestId;
    setWaveformLoadingAssetId(asset.id);
    let context: AudioContext | null = null;
    try {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error('The browser could not read this local audio source. Relink it and try again.');
      const encodedAudio = await response.arrayBuffer();
      if (encodedAudio.byteLength > 20 * 1024 * 1024) throw new Error('Waveform preview is limited to local audio files up to 20 MB.');
      context = new AudioContextConstructor({ sampleRate: 24_000 });
      waveformContextRef.current = context;
      const decoded = await context.decodeAudioData(encodedAudio);
      if (decoded.duration > 180) throw new Error('Waveform preview is limited to audio clips up to 3 minutes.');
      if (decoded.numberOfChannels > 2 || decoded.length * decoded.numberOfChannels > 10_000_000) throw new Error('Waveform preview supports stereo sources within the size and duration limits.');
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      const peaks = calculateWaveformPeaks(channels, 120);
      if (!peaks.length) throw new Error('The browser decoded no audio samples for this file.');
      if (waveformGenerationRef.current[asset.id] !== requestId || currentSessionSourcesRef.current[key]?.url !== source.url) return;
      setAudioWaveforms((current) => ({ ...current, [asset.id]: { sourceUrl: source.url, peaks } }));
      onNotify(`Generated a session-only waveform for ${asset.name}.`);
    } catch (error) {
      if (waveformGenerationRef.current[asset.id] === requestId) onNotify(error instanceof Error ? error.message : 'Could not generate this audio waveform.', 'warning');
    } finally {
      if (waveformContextRef.current === context) waveformContextRef.current = null;
      if (context && context.state !== 'closed') await context.close().catch(() => undefined);
      if (waveformGenerationRef.current[asset.id] === requestId) setWaveformLoadingAssetId(null);
    }
  }

  function sourceDuration(sourceId: string, kind: Track['kind']) {
    const asset = assets.find((item) => item.id === sourceId);
    const stream = asset?.streams[kind];
    if (!stream) return 0;
    const duration = stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
    return sequence ? Math.floor(duration * frameRateValue + 1e-7) / frameRateValue : duration;
  }

  function activeVideoAt(time: number) {
    return selectActiveVideoClip(videoClips, tracks, time, hiddenTrackIds);
  }
  function activeAudioAt(time: number) {
    return audioClips
      .filter((clip) => {
        const track = tracks.find((item) => item.id === clip.trackId);
        return track && !track.muted && !hiddenTrackIds[track.id] && (!soloTrackIds.length || soloTrackIds.includes(track.id)) && time >= clip.start - 1e-7 && time < clipEnd(clip) - 1e-7;
      })
      .sort((a, b) => tracks.findIndex((track) => track.id === b.trackId) - tracks.findIndex((track) => track.id === a.trackId))[0] ?? null;
  }

  function nextActiveVideoChange(time: number, currentId: string | null) {
    const boundaries = [...new Set(videoClips.flatMap((clip) => [clip.start, clipEnd(clip)]).filter((boundary) => boundary > time + 1e-7))].sort((a, b) => a - b);
    for (const boundary of boundaries) {
      const next = activeVideoAt(boundary + 1e-6);
      if (next?.id !== currentId) return { clip: next, at: boundary };
    }
    return null;
  }

  function trackForMediaElement(element: HTMLMediaElement) {
    const audioClip = audioClips.find((clip) => audioElementRefs.current[clip.id] === element);
    const clip = audioClip ?? videoClips.find((candidate) => candidate.id === activeClipRef.current);
    return clip ? tracks.find((track) => track.id === clip.trackId) ?? null : null;
  }

  function syncExportAudioGain(element: HTMLMediaElement) {
    const graph = exportAudioGraphRef.current;
    const gain = graph?.gains.get(element);
    const panner = graph?.panners.get(element);
    const track = trackForMediaElement(element);
    if (gain) gain.gain.value = element.muted ? 0 : element.volume * (track?.gain ?? 1);
    if (panner) panner.pan.value = track?.pan ?? 0;
  }

  function ensureExportAudioGraph() {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return null;
    let graph = exportAudioGraphRef.current;
    try {
      if (!graph) {
        const context = new AudioContextConstructor();
        graph = { context, destination: context.createMediaStreamDestination(), gains: new Map(), panners: new Map() };
        exportAudioGraphRef.current = graph;
      }
      const mediaElements = [...videoRefs.map((ref) => ref.current).filter((element): element is HTMLVideoElement => Boolean(element)), ...Object.values(audioElementRefs.current).filter((element): element is HTMLAudioElement => Boolean(element))];
      for (const element of mediaElements) {
        if (!graph.gains.has(element)) {
          try {
            const source = graph.context.createMediaElementSource(element);
            const gain = graph.context.createGain();
            source.connect(gain);
            let panner: StereoPannerNode | null = null;
            try { panner = graph.context.createStereoPanner(); } catch { /* Gain and export remain available without pan support. */ }
            if (panner) {
              gain.connect(panner);
              panner.connect(graph.context.destination);
              panner.connect(graph.destination);
              graph.panners.set(element, panner);
            } else {
              gain.connect(graph.context.destination);
              gain.connect(graph.destination);
            }
            graph.gains.set(element, gain);
          } catch {
            // Keep browser-native playback available for elements the platform cannot route through Web Audio.
          }
        }
        const track = trackForMediaElement(element);
        element.volume = graph.gains.has(element) ? volume : Math.min(1, volume * (track?.gain ?? 1));
        syncExportAudioGain(element);
      }
      return graph;
    } catch {
      return null;
    }
  }

  function ensureDeckSource(index: number, sourceId: string, url: string, sourceTime: number, active: boolean, playing: boolean, muted = false, forceSeek = false) {
    const video = videoRefs[index].current;
    if (!video) return;
    const changed = deckUrlsRef.current[index] !== url || deckSourceIdsRef.current[index] !== sourceId;
    pendingSeekRef.current[index] = sourceTime;
    video.muted = !active || muted;
    video.volume = volume;
    syncExportAudioGain(video);
    if (changed) {
      deckUrlsRef.current[index] = url;
      deckSourceIdsRef.current[index] = sourceId;
      playRequestRef.current[index] = false;
      video.pause();
      setDeckReady((current) => current.map((ready, i) => i === index ? false : ready) as [boolean, boolean]);
      setDeckUrls((current) => current.map((currentUrl, i) => i === index ? url : currentUrl) as [string | null, string | null]);
      return;
    }
    if (video.readyState >= 1 && (forceSeek || Math.abs(video.currentTime - sourceTime) > 0.1)) {
      try { video.currentTime = Math.max(0, sourceTime); } catch { /* Metadata may not be ready; retry on load. */ }
    }
    if (active && playing && video.paused && !playRequestRef.current[index]) {
      playRequestRef.current[index] = true;
      void video.play().catch(() => { setPlaybackError(true); onPlaybackError(); }).finally(() => { playRequestRef.current[index] = false; });
    } else if ((!active || !playing) && !video.paused) {
      video.pause();
      playRequestRef.current[index] = false;
    }
  }

  function syncVideoFollower(time: number, playing: boolean, forceSeek = false) {
    const clip = activeVideoAt(time);
    if (!clip || !projectDocument) {
      activeClipRef.current = null;
      setTimelineVideoVisible(false);
      videoRefs.forEach((ref) => ref.current?.pause());
      playRequestRef.current = [false, false];
      const upcoming = nextActiveVideoChange(time, null);
      if (projectDocument && upcoming?.clip && upcoming.at - time <= 1) {
        const nextClip = upcoming.clip;
        const url = sessionSources[mediaKey(projectDocument.id, nextClip.sourceId)]?.url;
        if (url) ensureDeckSource(1 - activeDeckRef.current, nextClip.sourceId, url, nextClip.trimIn + upcoming.at - nextClip.start, false, false);
      }
      return;
    }
    const url = sessionSources[mediaKey(projectDocument.id, clip.sourceId)]?.url;
    if (!url) {
      activeClipRef.current = clip.id;
      setTimelineVideoVisible(false);
      videoRefs.forEach((ref) => ref.current?.pause());
      return;
    }
    const sourceTime = clip.trimIn + time - clip.start;
    const changedClip = activeClipRef.current !== clip.id;
    let deck = activeDeckRef.current;
    const currentMatches = deckUrlsRef.current[deck] === url && deckSourceIdsRef.current[deck] === clip.sourceId;
    if (changedClip && !currentMatches) {
      const previousDeck = deck;
      deck = 1 - deck;
      videoRefs[previousDeck].current?.pause();
      playRequestRef.current[previousDeck] = false;
      activeDeckRef.current = deck;
      setActiveDeck(deck);
    }
    activeClipRef.current = clip.id;
    setTimelineVideoVisible(true);
    const track = tracks.find((item) => item.id === clip.trackId);
    ensureDeckSource(deck, clip.sourceId, url, sourceTime, true, playing, Boolean(track?.muted || (track && soloTrackIds.length > 0 && !soloTrackIds.includes(track.id))), forceSeek);
    const upcoming = nextActiveVideoChange(time, clip.id);
    if (upcoming?.clip && upcoming.at - time <= 1) {
      const nextClip = upcoming.clip;
      const nextUrl = sessionSources[mediaKey(projectDocument.id, nextClip.sourceId)]?.url;
      if (nextUrl) ensureDeckSource(1 - deck, nextClip.sourceId, nextUrl, nextClip.trimIn + upcoming.at - nextClip.start, false, false);
    }
  }

  function syncAudioFollower(time: number, playing: boolean, forceSeek = false) {
    const activeIds = new Set(audioClips.filter((clip) => {
      const track = tracks.find((item) => item.id === clip.trackId);
      return track && !track.muted && !hiddenTrackIds[track.id] && (!soloTrackIds.length || soloTrackIds.includes(track.id)) && time >= clip.start - 1e-7 && time < clipEnd(clip) - 1e-7;
    }).map((clip) => clip.id));
    for (const clip of audioClips) {
      const audio = audioElementRefs.current[clip.id];
      if (!audio) continue;
      const track = tracks.find((item) => item.id === clip.trackId);
      const isActive = activeIds.has(clip.id) && Boolean(track) && Boolean(projectDocument?.assets.some((asset) => asset.id === clip.sourceId && asset.kind === 'audio'));
      const source = projectDocument ? sessionSources[mediaKey(projectDocument.id, clip.sourceId)] : undefined;
      audio.volume = exportAudioGraphRef.current?.gains.has(audio) ? volume : Math.min(1, volume * (track?.gain ?? 1));
      audio.muted = !isActive || !source;
      syncExportAudioGain(audio);
      if (!isActive || !source) {
        if (!audio.paused) audio.pause();
        audioPlayRequestRef.current.delete(clip.id);
        continue;
      }
      const sourceTime = Math.max(0, clip.trimIn + time - clip.start);
      if (audio.readyState >= 1 && (forceSeek || Math.abs(audio.currentTime - sourceTime) > 0.1)) {
        try { audio.currentTime = sourceTime; } catch { /* Retry from the next master-clock tick once metadata is available. */ }
      }
      if (playing && audio.paused && !audioPlayRequestRef.current.has(clip.id)) {
        audioPlayRequestRef.current.add(clip.id);
        void audio.play().catch(() => {
          setPlaybackError(true);
          onPlaybackError();
        }).finally(() => { if (!audio.paused) audioPlayRequestRef.current.delete(clip.id); });
      } else if ((!playing || !isActive) && !audio.paused) {
        audio.pause();
        audioPlayRequestRef.current.delete(clip.id);
      }
    }
  }

  function handleAudioReady(clipId: string) {
    if (audioClips.some((clip) => clip.id === clipId)) syncAudioFollower(timelineTimeRef.current, isPlaying, true);
  }

  function audioElementRefFor(clipId: string) {
    if (!audioElementRefCallbacks.current[clipId]) {
      audioElementRefCallbacks.current[clipId] = (element) => {
        if (element) audioElementRefs.current[clipId] = element;
        else {
          const previous = audioElementRefs.current[clipId];
          previous?.pause();
          delete audioElementRefs.current[clipId];
          audioPlayRequestRef.current.delete(clipId);
        }
      };
    }
    return audioElementRefCallbacks.current[clipId];
  }

  function seekTimelineTime(requested: number) {
    if (!sequence) return;
    const clamped = Math.max(0, Math.min(sequenceLength, quantizeTimelineTime(requested, sequence)));
    timelineTimeRef.current = clamped;
    setTimelineTimeState(clamped);
    syncVideoFollower(clamped, isPlaying, true);
    syncAudioFollower(clamped, isPlaying, true);
  }

  function togglePlayback() {
    if (!sequenceLength || isExportingRef.current) return;
    if (isPlaying) {
      syncVideoFollower(timelineTimeRef.current, false);
      syncAudioFollower(timelineTimeRef.current, false);
      setIsPlaying(false);
    } else {
      if (timelineTimeRef.current >= sequenceLength - 1 / frameRateValue) seekTimelineTime(0);
      autoFollowRef.current = true;
      setPlaybackError(false);
      audioPlayRequestRef.current.clear();
      const audioGraph = ensureExportAudioGraph();
      if (audioGraph?.context.state === 'suspended') void audioGraph.context.resume().catch(() => { setPlaybackError(true); onPlaybackError(); });
      // Start already-loaded media inside the user's click/key gesture before relying on RAF.
      syncVideoFollower(timelineTimeRef.current, true);
      syncAudioFollower(timelineTimeRef.current, true);
      setIsPlaying(true);
    }
  }

  function cancelVideoExport() {
    if (!isExportingRef.current) return;
    exportAbortControllerRef.current?.abort();
  }

  async function chooseExportFolder() {
    const exportFiles = window.clipwright?.exportFiles;
    if (!exportFiles) return;
    try {
      const choice = await exportFiles.chooseFolder();
      if (choice.canceled) return;
      exportFolderChosenByUserRef.current = true;
      setExportFolder({ handle: choice.handle, folderName: choice.folderName });
      setExportSaveError(null);
      setExportSavedFile(null);
    } catch (error) {
      setExportSaveError(error instanceof Error ? error.message : 'Could not choose an export folder.');
    }
  }

  async function openExportFolder() {
    if (!exportSavedFile || !window.clipwright?.exportFiles) return;
    try { await window.clipwright.exportFiles.openFolder(exportSavedFile.handle); }
    catch (error) { onNotify(error instanceof Error ? error.message : 'Could not open the export folder.', 'error'); }
  }

  async function startVideoExport() {
    if (!sequence || sequenceLength <= 0 || isPlaying || isExportingRef.current || !projectDocument) return;
    if (missingMediaAssets.length) {
      onNotify(`Export is disabled: relink ${missingMediaAssets.length} missing media ${missingMediaAssets.length === 1 ? 'file' : 'files'} first.`, 'error');
      return;
    }
    let targetExportFolder = exportFolder;
    if (window.clipwright?.exportFiles && !targetExportFolder) {
      const savedFolder = await window.clipwright.exportFiles.getDefaultFolder().catch(() => ({ canceled: true as const }));
      let choice = savedFolder;
      if (choice.canceled) choice = await window.clipwright.exportFiles.chooseFolder();
      if (choice.canceled) return;
      targetExportFolder = { handle: choice.handle, folderName: choice.folderName };
      exportFolderChosenByUserRef.current = true;
      setExportFolder(targetExportFolder);
    }
    if (exportContainer === 'mp4' && !mp4Capability.supported) {
      onNotify(mp4Capability.reason ? `MP4 export is unavailable: ${mp4Capability.reason}` : 'MP4 capability checks have not passed for the selected dimensions and tracks. No alternate format was selected.', 'error');
      return;
    }
    const exportStartedAt = performance.now();
    const activeSequence = sequence;
    const activeProjectDocument = projectDocument;
    const activeSessionSources = { ...sessionSources };
    const activeHiddenTracks = { ...hiddenTrackIds };
    const activeSoloTracks = [...soloTrackIds];
    const missingVideo = videoClips.some((clip) => !activeHiddenTracks[clip.trackId] && !activeSessionSources[mediaKey(activeProjectDocument.id, clip.sourceId)]);
    const missingAudio = audioClips.some((clip) => {
      const track = tracks.find((item) => item.id === clip.trackId);
      return track && !track.muted && !activeHiddenTracks[track.id] && !activeSessionSources[mediaKey(activeProjectDocument.id, clip.sourceId)];
    });
    if (missingVideo || missingAudio) {
      onNotify('Export is disabled because one or more timeline sources are offline. Relink the missing media first.', 'error');
      onExportDialogOpenChange(true);
      return;
    }

    const controller = new AbortController();
    exportAbortControllerRef.current = controller;
    isExportingRef.current = true;
    setIsExporting(true);
    setIsSavingExport(false);
    setExportProgress(0);
    setIsPlaying(false);
    videoRefs.forEach((ref) => ref.current?.pause());
    Object.values(audioElementRefs.current).forEach((audio) => audio?.pause());

    let exportStage = 'validating project snapshot';
    let result: TimelineExportResult | null = null;
    let videoEncoderConfig: EncoderConfigDiagnostic | null = null;
    let audioEncoderConfig: EncoderConfigDiagnostic | null = null;
    let latestExportCounts: (FramePipelineCounts & { encoded: number }) | null = null;
    const expectedDuration = activeSequence.durationFrames * activeSequence.frameRate.denominator / activeSequence.frameRate.numerator;
    const expectedFrames = activeSequence.durationFrames;
    const downloadDiagnostic = (error: unknown) => {
      const diagnostic = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        stage: exportStage,
        projectId: activeProjectDocument.id,
        sequenceId: activeSequence.id,
        container: exportContainer,
        expected: {
          frameCount: expectedFrames,
          frameRate: activeSequence.frameRate,
          durationSeconds: expectedDuration,
        },
        actual: {
          counts: result?.counts ?? latestExportCounts,
          measurements: result?.measurements ?? null,
          expectedAudioTrack: result?.expectedAudioTrack ?? null,
          outputDimensions: result?.outputDimensions ?? null,
          encoderConfiguration: result?.encoderConfiguration ?? { video: videoEncoderConfig, audio: audioEncoderConfig },
          durationValidation: result?.durationValidation ?? null,
        },
        localValidationDiagnostics: error && typeof error === 'object' && 'exportDiagnostics' in error
          ? (error as Error & { exportDiagnostics?: unknown }).exportDiagnostics ?? null
          : null,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack ?? null : null,
        },
        playbackCallbacks: null,
        sourceMediaIncluded: false,
      };
      const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `ClipWright-export-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    try {
      const sourceBlobs = new Map<string, Blob>();
      const exportSourceIds = new Set(activeSequence.tracks.flatMap((track) => track.clips.map((clip) => clip.sourceId)));
      for (const asset of activeProjectDocument.assets) {
        if (!exportSourceIds.has(asset.id)) continue;
        const source = activeSessionSources[mediaKey(activeProjectDocument.id, asset.id)];
        if (!source) continue;
        if (source.blob) sourceBlobs.set(asset.id, source.blob);
        else {
          const response = await fetch(source.url);
          if (!response.ok) throw new Error(`Could not read “${asset.name}” for export; relink the media and try again.`);
          sourceBlobs.set(asset.id, await response.blob());
        }
      }
      result = await exportTimelineProject({
        projectSnapshot: activeProjectDocument,
        sourceBlobs,
        sequenceId: activeSequence.id,
        container: exportContainer,
        resolution: exportResolution,
        quality: exportQuality,
        hiddenTrackIds: activeHiddenTracks,
        soloTrackIds: activeSoloTracks,
        signal: controller.signal,
        onStage: (stage) => { exportStage = stage; },
        onVideoEncoderConfig: (config) => { videoEncoderConfig = config; },
        onAudioEncoderConfig: (config) => { audioEncoderConfig = config; },
        onProgress: (counts) => {
          latestExportCounts = counts;
          if (counts.submitted && (counts.submitted % 10 === 0 || counts.submitted === expectedFrames)) {
            setExportProgress(Math.min(99, Math.floor(counts.submitted * 100 / expectedFrames)));
          }
        },
      });
      if (controller.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');

      const extension = exportContainer === 'mp4' ? 'mp4' : 'webm';
      const outputName = (exportFilename.trim() || defaultExportFilename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 150) || 'ClipWright-export';
      setExportSaveError(null);
      setExportSavedFile(null);
      setIsSavingExport(true);
      if (window.clipwright?.exportFiles) {
        if (!targetExportFolder) throw new Error('Choose an export folder before saving the encoded file.');
        const saved = await window.clipwright.exportFiles.save({ handle: targetExportFolder.handle, fileName: outputName, extension, bytes: new Uint8Array(result.buffer) });
        setExportSavedFile({ handle: saved.fileHandle, fileName: saved.fileName, folderName: saved.folderName });
        onNotify(`Saved ${saved.fileName} to ${saved.folderName}.`, 'success');
      } else {
        const blob = new Blob([result.buffer], { type: result.measurements.mimeType || (exportContainer === 'mp4' ? 'video/mp4' : 'video/webm') });
        const objectUrl = URL.createObjectURL(blob);
        const link = window.document.createElement('a');
        link.href = objectUrl;
        link.download = `${outputName}.${extension}`;
        window.document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        onNotify(`Exported ${outputName}.${extension} using the browser download location.`, 'success');
      }
      setIsSavingExport(false);
      const elapsedSeconds = Math.max(0.01, (performance.now() - exportStartedAt) / 1000);
      const speedFactor = elapsedSeconds / Math.max(sequenceLength, 0.01);
      setLastExportSpeedFactor(speedFactor);
      try { window.localStorage.setItem('clipwright.export.speed-factor', String(speedFactor)); } catch { /* Estimate remains available for this session. */ }
      const configuredFrameRate = activeSequence.frameRate.numerator / activeSequence.frameRate.denominator;
      const audioMeasurement = result.measurements.outputAudioDurationSeconds === null
        ? 'no audio track'
        : `audio ${result.measurements.outputAudioDurationSeconds.toFixed(6)}s (Δ ${result.durationValidation.audioDeltaSeconds?.toFixed(6)}s, tol ${result.durationValidation.audioToleranceSeconds.toFixed(6)}s)`;
      const videoConfig = result.encoderConfiguration.video;
      const audioConfig = result.encoderConfiguration.audio;
      const encoderSummary = `WebCodecs ${videoConfig?.codec ?? 'unknown'}${audioConfig ? `/${audioConfig.codec}` : ''}; hardware acceleration preference ${videoConfig?.hardwareAcceleration ?? 'default'} (actual hardware/software backend is not exposed by WebCodecs)`;
      onNotify(`Exported ${outputName}.${extension}: requested ${result.counts.requested}, rendered ${result.counts.rendered}, submitted ${result.counts.submitted}, encoded ${result.counts.encoded}, output packets ${result.measurements.outputVideoPackets} (expected ${expectedFrames}); ${result.measurements.decodedSampleFrames} decoded validation samples passed; video ${result.measurements.outputVideoDurationSeconds.toFixed(6)}s (Δ ${result.durationValidation.videoDeltaSeconds.toFixed(6)}s, tol ${result.durationValidation.videoToleranceSeconds.toFixed(6)}s) at ${result.measurements.outputVideoPacketRate.toFixed(6)} packets/s (sequence ${configuredFrameRate.toFixed(6)} fps); ${audioMeasurement}; container ${result.measurements.outputContainerDurationSeconds.toFixed(6)}s (Δ ${result.durationValidation.containerDeltaSeconds.toFixed(6)}s, tol ${result.durationValidation.containerToleranceSeconds.toFixed(6)}s); ${encoderSummary}.`, 'success');
      setExportProgress(100);
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      if (isAbort || controller.signal.aborted) onNotify('Export cancelled; no file was downloaded.', 'warning');
      else if (result) {
        const message = error instanceof Error ? error.message : 'Could not save the encoded export.';
        setExportSaveError(`The render completed but the file was not saved: ${message}`);
        setExportProgress(100);
        onNotify(`The render completed, but saving failed: ${message}`, 'error');
      } else {
        let diagnosticStatus = 'A diagnostic report was downloaded without source media.';
        try { downloadDiagnostic(error); }
        catch (diagnosticError) {
          diagnosticStatus = 'The diagnostic report could not be downloaded.';
          console.error('ClipWright export diagnostic download failed:', diagnosticError);
        }
        const message = error instanceof Error ? error.message : 'Could not export the active sequence.';
        onNotify(`${message} ${diagnosticStatus}`, 'error');
      }
      setExportProgress(0);
    } finally {
      controller.abort();
      if (exportAbortControllerRef.current === controller) exportAbortControllerRef.current = null;
      isExportingRef.current = false;
      setIsExporting(false);
      setIsSavingExport(false);
    }
  }

  function skipTimeline(seconds: number) { seekTimelineTime(timelineTimeRef.current + seconds); }
  function setTimelineTimeFromClientX(clientX: number) {
    const area = timelineScrollRef.current;
    if (!area) return;
    seekTimelineTime((area.scrollLeft + clientX - area.getBoundingClientRect().left) / timelineScale);
  }
  function beginRulerScrub(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    rulerPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setTimelineTimeFromClientX(event.clientX);
  }
  function moveRulerScrub(event: React.PointerEvent<HTMLDivElement>) {
    if (rulerPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    setTimelineTimeFromClientX(event.clientX);
  }
  function endRulerScrub(event: React.PointerEvent<HTMLDivElement>) {
    if (rulerPointerRef.current !== event.pointerId) return;
    rulerPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function beginPlayheadDrag(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    beginRulerScrub(event as unknown as React.PointerEvent<HTMLDivElement>);
  }
  function movePlayheadDrag(event: React.PointerEvent<HTMLButtonElement>) { moveRulerScrub(event as unknown as React.PointerEvent<HTMLDivElement>); }
  function endPlayheadDrag(event: React.PointerEvent<HTMLButtonElement>) { endRulerScrub(event as unknown as React.PointerEvent<HTMLDivElement>); }
  function handlePlayheadKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (direction) { event.preventDefault(); event.stopPropagation(); seekTimelineTime(timelineTimeRef.current + direction * (event.shiftKey ? 1 : 1 / frameRateValue)); }
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); seekTimelineTime(0); }
    if (event.key === 'End') { event.preventDefault(); event.stopPropagation(); seekTimelineTime(sequenceLength); }
  }

  function updateTimelinePlayheadVisual(time: number) {
    const pixelX = time * timelineScale;
    if (timelinePlayheadRef.current) timelinePlayheadRef.current.style.transform = `translateX(${pixelX}px)`;
    if (timelineRulerPlayheadRef.current) {
      const scrollLeft = timelineScrollRef.current?.scrollLeft ?? timelineScrollOffsets.left;
      timelineRulerPlayheadRef.current.style.transform = `translateX(${pixelX - scrollLeft}px)`;
    }
  }
  function programmaticScroll(left: number, top?: number) {
    const area = timelineScrollRef.current;
    if (!area) return;
    suppressProgrammaticScrollRef.current = true;
    area.scrollLeft = Math.max(0, left);
    if (top !== undefined) area.scrollTop = Math.max(0, top);
    window.requestAnimationFrame(() => { suppressProgrammaticScrollRef.current = false; });
  }
  function handleTimelineScroll(event: React.UIEvent<HTMLDivElement>) {
    const { scrollLeft, scrollTop } = event.currentTarget;
    if (timelineTrackHeaderRowsRef.current) timelineTrackHeaderRowsRef.current.style.transform = `translateY(-${scrollTop}px)`;
    if (timelineRulerContentRef.current) timelineRulerContentRef.current.style.transform = `translateX(-${scrollLeft}px)`;
    updateTimelinePlayheadVisual(timelineTimeRef.current);
    setTimelineScrollOffsets({ left: scrollLeft, top: scrollTop });
    if (suppressProgrammaticScrollRef.current) suppressProgrammaticScrollRef.current = false;
    else autoFollowRef.current = false;
  }
  function zoomTimeline(next: number, anchorClientX?: number) {
    const scale = Math.max(minimumPxPerSecond, Math.min(maximumPxPerSecond, next));
    const area = timelineScrollRef.current;
    const bounds = area?.getBoundingClientRect();
    const anchorX = area && bounds ? (anchorClientX === undefined ? area.clientWidth / 2 : anchorClientX - bounds.left) : 0;
    const anchorTime = area ? (area.scrollLeft + anchorX) / timelineScale : 0;
    setPxPerSecond(scale);
    storeTimelinePxPerSecond(scale);
    if (area) window.requestAnimationFrame(() => programmaticScroll(anchorTime * scale - anchorX));
  }
  function handleTimelineWheel(event: React.WheelEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('.timeline-corner, .timeline-track-header-column')) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomTimeline(timelineScale * (event.deltaY > 0 ? 1 / 1.12 : 1.12), event.clientX);
    } else if (event.shiftKey) {
      event.preventDefault();
      const area = timelineScrollRef.current;
      if (area) area.scrollLeft += Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
    }
  }
  function fitTimeline() {
    setPxPerSecond(minimumPxPerSecond);
    storeTimelinePxPerSecond(minimumPxPerSecond);
    programmaticScroll(0, 0);
  }

  function getTrackAtClientY(clientY: number) {
    const area = timelineScrollRef.current;
    if (!area) return null;
    const rect = area.getBoundingClientRect();
    return tracks[Math.floor((clientY - rect.top + area.scrollTop) / 60)] ?? null;
  }
  function snapTime(raw: number, candidates: number[]) {
    if (!snapEnabled || !sequence) return { time: sequence ? quantizeTimelineTime(raw, sequence) : raw, guide: null as number | null };
    let time = raw; let guide: number | null = null; let best = preferences.editor.snapStrength / timelineScale;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - raw);
      if (distance <= best) { best = distance; time = candidate; guide = candidate; }
    }
    return { time: quantizeTimelineTime(time, sequence), guide };
  }
  function snapCandidates(excludedIds: string[]) {
    return [0, timelineTimeRef.current, ...allClips.filter((clip) => !excludedIds.includes(clip.id)).flatMap((clip) => [clip.start, clipEnd(clip)])];
  }
  function snapClipStart(rawStart: number, duration: number, excludedIds: string[] = []) {
    const frameAligned = sequence ? quantizeTimelineTime(rawStart, sequence) : rawStart;
    if (!snapEnabled || !sequence) return { start: frameAligned, guide: null as number | null };
    let start = rawStart; let guide: number | null = null; let best = preferences.editor.snapStrength / timelineScale;
    for (const edge of [rawStart, rawStart + duration]) for (const point of snapCandidates(excludedIds)) {
      const distance = Math.abs(point - edge);
      if (distance <= best) { best = distance; start = rawStart + point - edge; guide = point; }
    }
    return { start: Math.max(0, quantizeTimelineTime(start, sequence)), guide };
  }
  function selectClip(clip: TimelineClip, event?: React.MouseEvent<HTMLButtonElement>) {
    const multi = Boolean(event?.shiftKey || event?.ctrlKey || event?.metaKey);
    setSelectedClipIds((current) => multi ? current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id] : [clip.id]);
    if (event) {
      const bounds = event.currentTarget.getBoundingClientRect();
      seekTimelineTime(clip.start + Math.max(0, Math.min(clipDuration(clip), (event.clientX - bounds.left) / timelineScale)));
    }
  }
  function beginClipDrag(event: React.PointerEvent<HTMLElement>, clip: TimelineClip, mode: 'move' | 'trim-left' | 'trim-right' = 'move') {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const modifiedSelection = Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
    const ids = mode !== 'move' ? [clip.id]
      : modifiedSelection ? selectedClipIds.includes(clip.id) ? selectedClipIds : [...selectedClipIds, clip.id]
      : selectedClipIds.includes(clip.id) ? selectedClipIds : [clip.id];
    const originals = allClips.filter((item) => ids.includes(item.id));
    const track = tracks.find((item) => item.id === clip.trackId);
    if (!track || track.locked || ids.some((id) => tracks.find((item) => item.clips.some((entry) => entry.id === id))?.locked)) return;
    if (mode !== 'move') setSelectedClipIds([clip.id]);
    dragRef.current = { pointerId: event.pointerId, mode, primaryId: clip.id, ids, originals, startX: event.clientX, startY: event.clientY, moved: false, targetTrackId: clip.trackId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function moveClipDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !sequence) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.hypot(dx, event.clientY - drag.startY) < 3) return;
    drag.moved = true;
    if (drag.mode === 'move') setSelectedClipIds(drag.ids);
    const primary = drag.originals.find((clip) => clip.id === drag.primaryId)!;
    const sourceTrack = tracks.find((track) => track.id === primary.trackId)!;
    let items: TimelineClip[]; let guide: number | null = null;
    if (drag.mode === 'move') {
      const hit = getTrackAtClientY(event.clientY);
      const target = hit && hit.kind === sourceTrack.kind && !hit.locked ? hit : sourceTrack;
      drag.targetTrackId = target.id;
      const starts = drag.originals.map((clip) => clip.start);
      const ends = drag.originals.map(clipEnd);
      const rawStart = Math.min(...starts) + dx / timelineScale;
      const rawEnd = Math.max(...ends) + dx / timelineScale;
      let nextStart = rawStart; let best = preferences.editor.snapStrength / timelineScale;
      for (const edge of [rawStart, rawEnd]) for (const point of snapCandidates(drag.ids)) {
        const distance = Math.abs(point - edge);
        if (distance <= best) { best = distance; nextStart = rawStart + point - edge; guide = point; }
      }
      if (nextStart < 0) { nextStart = 0; guide = 0; }
      const shift = quantizeTimelineTime(nextStart, sequence) - Math.min(...starts);
      items = drag.originals.map((clip) => ({ ...clip, trackId: target.id, start: quantizeTimelineTime(clip.start + shift, sequence) }));
    } else {
      drag.targetTrackId = primary.trackId;
      const delta = dx / timelineScale;
      const minDuration = 1 / frameRateValue;
      const sourceLength = sourceDuration(primary.sourceId, sourceTrack.kind);
      if (drag.mode === 'trim-left') {
        let trimIn = Math.max(0, Math.min(primary.trimOut - minDuration, primary.trimIn + delta));
        let start = primary.start + trimIn - primary.trimIn;
        const snap = snapTime(start, snapCandidates([primary.id]));
        if (snap.guide !== null) { trimIn = Math.max(0, Math.min(primary.trimOut - minDuration, trimIn + snap.time - quantizeTimelineTime(start, sequence))); start = primary.start + trimIn - primary.trimIn; guide = snap.guide; }
        items = [{ ...primary, start: quantizeTimelineTime(start, sequence), trimIn: quantizeTimelineTime(trimIn, sequence) }];
      } else {
        let trimOut = Math.max(primary.trimIn + minDuration, Math.min(sourceLength, primary.trimOut + delta));
        const edge = primary.start + trimOut - primary.trimIn;
        const snap = snapTime(edge, snapCandidates([primary.id]));
        if (snap.guide !== null) { trimOut = Math.max(primary.trimIn + minDuration, Math.min(sourceLength, trimOut + snap.time - quantizeTimelineTime(edge, sequence))); guide = snap.guide; }
        items = [{ ...primary, trimOut: Math.min(sourceLength, quantizeTimelineTime(trimOut, sequence)) }];
      }
    }
    setDragPreview({ items, guide });
  }
  function finishClipDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const preview = dragPreview;
    if (drag.moved && preview && sequence) {
      if (drag.mode === 'move') {
        const earliestMovedStart = Math.min(...preview.items.map((item) => item.start));
        if (persistTimelineEdit((doc) => moveTimelineClips(doc, sequence.id, drag.ids, drag.targetTrackId, earliestMovedStart, rippleMode), 'Moved timeline clip.')) setSelectedClipIds(drag.ids);
      } else {
        const item = preview.items[0];
        persistTimelineEdit((doc) => resizeTimelineClip(doc, sequence.id, item.id, item.start, item.trimIn, item.trimOut, rippleMode), 'Trimmed timeline clip.');
      }
      suppressClipClickRef.current = true;
      window.setTimeout(() => { suppressClipClickRef.current = false; }, 0);
    }
    setDragPreview(null);
  }

  function beginMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.timeline-clip, .timeline-playhead-grab, button')) return;
    const area = timelineScrollRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect(); const x = event.clientX - rect.left + area.scrollLeft; const y = event.clientY - rect.top + area.scrollTop;
    marqueeRef.current = { pointerId: event.pointerId, x0: x, y0: y, x1: x, y1: y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function moveMarquee(event: React.PointerEvent<HTMLDivElement>) {
    const active = marqueeRef.current; const area = timelineScrollRef.current;
    if (!active || active.pointerId !== event.pointerId || !area) return;
    const rect = area.getBoundingClientRect(); active.x1 = event.clientX - rect.left + area.scrollLeft; active.y1 = event.clientY - rect.top + area.scrollTop;
    setMarquee({ ...active });
  }
  function finishMarquee(event: React.PointerEvent<HTMLDivElement>) {
    const active = marqueeRef.current;
    if (!active || active.pointerId !== event.pointerId || !sequence) return;
    marqueeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const left = Math.min(active.x0, active.x1); const right = Math.max(active.x0, active.x1); const top = Math.min(active.y0, active.y1); const bottom = Math.max(active.y0, active.y1);
    if (right - left < 4 && bottom - top < 4) setSelectedClipIds([]);
    else setSelectedClipIds(tracks.flatMap((track, row) => track.clips.filter((clip) => clip.start * timelineScale < right && clipEnd(clip) * timelineScale > left && row * 60 < bottom && (row + 1) * 60 > top).map((clip) => clip.id)));
    suppressClearClickRef.current = true; window.setTimeout(() => { suppressClearClickRef.current = false; }, 0); setMarquee(null);
  }
  function clearSelectionOnEmptyClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!suppressClearClickRef.current && !(event.target as HTMLElement).closest('.timeline-clip, button')) setSelectedClipIds([]);
  }
  function getTimeAndTrack(clientX: number, clientY: number) {
    const area = timelineScrollRef.current; const track = getTrackAtClientY(clientY);
    if (!area || !track) return null;
    return { track, time: (area.scrollLeft + clientX - area.getBoundingClientRect().left) / timelineScale };
  }
  function handleMediaDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('application/x-clipwright-source')) return;
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('application/x-clipwright-source') || mediaDragSourceRef.current || ''; const asset = assets.find((item) => item.id === sourceId); const pos = getTimeAndTrack(event.clientX, event.clientY);
    if (!asset || !pos || asset.kind !== pos.track.kind || pos.track.locked || !sequence) { setDropPreview(null); return; }
    const duration = Math.max(1 / frameRateValue, sourceDuration(sourceId, pos.track.kind));
    const snap = snapClipStart(pos.time, duration);
    setDropPreview({ trackId: pos.track.id, start: snap.start, duration, guide: snap.guide });
  }
  function handleMediaDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('application/x-clipwright-source') || mediaDragSourceRef.current || ''; const pos = getTimeAndTrack(event.clientX, event.clientY); setDropPreview(null); mediaDragSourceRef.current = null;
    if (!sourceId || !pos || pos.track.locked || !sequence || assets.find((item) => item.id === sourceId)?.kind !== pos.track.kind) return;
    const length = sourceDuration(sourceId, pos.track.kind);
    const start = snapClipStart(pos.time, length).start;
    const id = crypto.randomUUID();
    if (persistTimelineEdit((doc) => addTimelineClip(doc, sequence.id, sourceId, pos.track.id, start, id), 'Added clip to the timeline.')) { setSelectedClipIds([id]); seekTimelineTime(start); }
  }
  function addSelectedSourceAtPlayhead() {
    const asset = activeMediaAsset;
    if (!asset || !sequence) return;
    const track = tracks.find((item) => item.kind === asset.kind && !item.locked); if (!track) return;
    const id = crypto.randomUUID();
    if (persistTimelineEdit((doc) => addTimelineClip(doc, sequence.id, asset.id, track.id, timelineTimeRef.current, id), 'Added source at the playhead.')) setSelectedClipIds([id]);
  }
  function splitAtPlayhead() {
    if (!sequence) return;
    const clip = selectedClip && timelineTime >= selectedClip.start && timelineTime < clipEnd(selectedClip) ? selectedClip : activeVideoAt(timelineTime) ?? activeAudioAt(timelineTime);
    if (!clip) return;
    const rightId = crypto.randomUUID();
    if (persistTimelineEdit((doc) => splitTimelineClip(doc, sequence.id, clip.id, timelineTimeRef.current, rightId), 'Split clip at the playhead.')) setSelectedClipIds([clip.id, rightId]);
  }
  function closeContextMenu(restoreFocus = true) {
    contextMenuRestoreFocusRef.current = restoreFocus;
    setContextMenu(null);
  }
  function showContextMenu(x: number, y: number, clipId: string | null, invoker: HTMLElement) {
    if (clipId && !selectedClipIds.includes(clipId)) setSelectedClipIds([clipId]);
    contextMenuInvokerRef.current = invoker;
    contextMenuRestoreFocusRef.current = true;
    setContextMenu({ x, y, clipId });
  }
  function deleteSelected(ripple = rippleMode) {
    if (!sequence || !selectedClipIds.length) return;
    const ids = [...selectedClipIds];
    if (persistTimelineEdit((doc) => removeTimelineClips(doc, sequence.id, ids, ripple), ripple ? 'Ripple deleted clips.' : 'Deleted clips.')) setSelectedClipIds([]);
    closeContextMenu();
  }
  function copySelected() {
    clipboardRef.current = selectedClips.map((clip) => ({ ...clip })); setClipboardClips(clipboardRef.current); closeContextMenu();
  }
  function pasteAtPlayhead() {
    if (!sequence || !clipboardRef.current.length) return;
    const ids = clipboardRef.current.map(() => crypto.randomUUID());
    if (persistTimelineEdit((doc) => pasteTimelineClips(doc, sequence.id, clipboardRef.current, timelineTimeRef.current, ids), 'Pasted clips at the playhead.')) setSelectedClipIds(ids);
    closeContextMenu();
  }
  function duplicateSelected() {
    if (!sequence || !selectedClipIds.length) return;
    const ordered = tracks.flatMap((track) => track.clips.filter((clip) => selectedClipIds.includes(clip.id))); const ids = ordered.map(() => crypto.randomUUID());
    if (persistTimelineEdit((doc) => duplicateTimelineClips(doc, sequence.id, selectedClipIds, ids, timelineTimeRef.current), 'Duplicated clips at the playhead.')) setSelectedClipIds(ids);
    closeContextMenu();
  }
  function openContextMenu(event: React.MouseEvent, clipId: string | null) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const invoker = clipId ? target.querySelector<HTMLElement>('.timeline-clip-body') : target;
    if (invoker) showContextMenu(event.clientX, event.clientY, clipId, invoker);
  }
  function handleContextMenuKey(event: React.KeyboardEvent<HTMLElement>, clipId: string | null) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget;
    const invoker = clipId ? target.querySelector<HTMLElement>('.timeline-clip-body') : target;
    if (!invoker) return;
    const rect = target.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom, clipId, invoker);
  }
  function adjustTrimByKeyboard(clip: TimelineClip, edge: 'left' | 'right', delta: number) {
    if (!sequence) return; const track = tracks.find((item) => item.id === clip.trackId); if (!track || track.locked) return;
    const frame = 1 / frameRateValue;
    const next = edge === 'left'
      ? { ...clip, start: Math.max(0, clip.start + delta), trimIn: Math.max(0, Math.min(clip.trimOut - frame, clip.trimIn + delta)) }
      : { ...clip, trimOut: Math.max(clip.trimIn + frame, Math.min(sourceDuration(clip.sourceId, track.kind), clip.trimOut + delta)) };
    persistTimelineEdit((doc) => resizeTimelineClip(doc, sequence.id, clip.id, next.start, next.trimIn, next.trimOut, rippleMode), 'Trimmed timeline clip.');
  }
  function handleTrimKey(event: React.KeyboardEvent<HTMLSpanElement>, clip: TimelineClip, edge: 'left' | 'right') {
    const track = tracks.find((item) => item.id === clip.trackId);
    if (!track) return;
    const frame = 1 / frameRateValue;
    const minimum = edge === 'left' ? 0 : clip.trimIn + frame;
    const maximum = edge === 'left' ? Math.max(0, clip.trimOut - frame) : sourceDuration(clip.sourceId, track.kind);
    const current = edge === 'left' ? clip.trimIn : clip.trimOut;
    let next: number;
    if (event.key === 'Home') next = minimum;
    else if (event.key === 'End') next = maximum;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : frame);
    else if (event.key === 'PageDown' || event.key === 'PageUp') next = current + (event.key === 'PageDown' ? -1 : 1);
    else return;
    next = Math.max(minimum, Math.min(maximum, next));
    if (Math.abs(next - current) < 1e-9) return;
    event.preventDefault(); event.stopPropagation(); adjustTrimByKeyboard(clip, edge, next - current);
  }

  function handleTimelineResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const delta = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
    const next = event.key === 'Home' ? timelineMinHeight : event.key === 'End' ? timelineMaxHeight : effectiveTimelineHeight + delta;
    const clamped = Math.max(timelineMinHeight, Math.min(timelineMaxHeight, next)); timelineHeightRef.current = clamped; setTimelineHeight(clamped); storeTimelineHeight(clamped);
  }
  function beginTimelineResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return; event.preventDefault(); resizeStartRef.current = { y: event.clientY, height: effectiveTimelineHeight }; event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function moveTimelineResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    const next = Math.max(timelineMinHeight, Math.min(timelineMaxHeight, resizeStartRef.current.height + resizeStartRef.current.y - event.clientY)); timelineHeightRef.current = next; setTimelineHeight(next);
  }
  function endTimelineResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return; resizeStartRef.current = null; storeTimelineHeight(timelineHeightRef.current);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function beginPanelResize(event: React.PointerEvent<HTMLDivElement>, side: 'media' | 'properties') {
    if (event.button !== 0) return;
    event.preventDefault();
    panelResizeStartRef.current = { side, x: event.clientX, width: side === 'media' ? mediaPanelWidth : propertiesPanelWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function movePanelResize(event: React.PointerEvent<HTMLDivElement>) {
    const start = panelResizeStartRef.current;
    if (!start) return;
    const direction = start.side === 'media' ? 1 : -1;
    const value = Math.max(start.side === 'media' ? 200 : 200, Math.min(start.side === 'media' ? 420 : 440, start.width + (event.clientX - start.x) * direction));
    if (start.side === 'media') setMediaPanelWidth(value); else setPropertiesPanelWidth(value);
  }
  function endPanelResize(event: React.PointerEvent<HTMLDivElement>) {
    const start = panelResizeStartRef.current;
    if (!start) return;
    panelResizeStartRef.current = null;
    storePanelWidth(start.side === 'media' ? MEDIA_PANEL_WIDTH_KEY : PROPERTIES_PANEL_WIDTH_KEY, start.side === 'media' ? mediaPanelWidth : propertiesPanelWidth);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function handlePanelResizeKey(event: React.KeyboardEvent<HTMLDivElement>, side: 'media' | 'properties') {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const value = side === 'media' ? mediaPanelWidth : propertiesPanelWidth;
    const sign = side === 'media' ? (event.key === 'ArrowLeft' ? -1 : 1) : (event.key === 'ArrowLeft' ? 1 : -1);
    const next = event.key === 'Home' ? (side === 'media' ? 200 : 200) : event.key === 'End' ? (side === 'media' ? 420 : 440) : Math.max(200, Math.min(side === 'media' ? 420 : 440, value + sign * (event.shiftKey ? 32 : 12)));
    if (side === 'media') { setMediaPanelWidth(next); storePanelWidth(MEDIA_PANEL_WIDTH_KEY, next); }
    else { setPropertiesPanelWidth(next); storePanelWidth(PROPERTIES_PANEL_WIDTH_KEY, next); }
  }
  function applyPendingPreviewSeek(index: number) {
    const video = videoRefs[index].current; const target = pendingSeekRef.current[index];
    if (video && target !== null && video.readyState >= 1) {
      try { video.currentTime = Math.max(0, target); pendingSeekRef.current[index] = null; }
      catch { /* Keep the pending target until the source is seekable. */ }
    }
  }
  function handlePreviewMetadata(index: number) { applyPendingPreviewSeek(index); }
  function handlePreviewReady(index: number) {
    applyPendingPreviewSeek(index);
    setPlaybackError(false);
    setDeckReady((current) => current.map((ready, i) => i === index ? true : ready) as [boolean, boolean]);
    const video = videoRefs[index].current;
    if (video && index === activeDeckRef.current && isPlaying && video.paused && !playRequestRef.current[index]) {
      playRequestRef.current[index] = true;
      void video.play().catch(() => { setPlaybackError(true); onPlaybackError(); }).finally(() => { playRequestRef.current[index] = false; });
    }
  }
  function handleTimelineKeyboard(event: KeyboardEvent) {
    const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
    if (event.key === 'Escape' && contextMenu) { event.preventDefault(); closeContextMenu(); return; }
    if (event.key === 'Escape' && focusMode) { event.preventDefault(); onToggleFocusMode(); return; }
    const isTimelineClipButton = target instanceof HTMLElement && !!target.closest('.timeline-clip-body');
    const isTextInput = target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]');
    const isInteractiveControl = target instanceof HTMLElement && target.matches('button, a[href], [role="button"], [role="slider"]');
    const modifier = event.metaKey || event.ctrlKey;
    if (isTextInput || (isInteractiveControl && !isTimelineClipButton && !modifier) || (isTimelineClipButton && event.code === 'Space')) return;
    if (contextMenu || isExporting) return;
    if (matchesShortcut(event, preferences.shortcuts.undo)) { event.preventDefault(); undoTimelineEdit(); return; }
    if (matchesShortcut(event, preferences.shortcuts.redo)) { event.preventDefault(); redoTimelineEdit(); return; }
    if (matchesShortcut(event, preferences.shortcuts.copy)) { event.preventDefault(); copySelected(); return; }
    if (matchesShortcut(event, preferences.shortcuts.paste)) { event.preventDefault(); pasteAtPlayhead(); return; }
    if (matchesShortcut(event, preferences.shortcuts.duplicate)) { event.preventDefault(); duplicateSelected(); return; }
    if (modifier) return;
    if (matchesShortcut(event, preferences.shortcuts.playPause)) { event.preventDefault(); togglePlayback(); return; }
    if (matchesShortcut(event, preferences.shortcuts.split)) { event.preventDefault(); splitAtPlayhead(); return; }
    if (matchesShortcut(event, preferences.shortcuts.snap)) { event.preventDefault(); toggleSnapPreference(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(event.shiftKey || rippleMode); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); const direction = event.key === 'ArrowLeft' ? -1 : 1;
      seekTimelineTime(timelineTimeRef.current + direction * (event.shiftKey ? 1 : 1 / frameRateValue)); return;
    }
    if (event.key === 'Home') { event.preventDefault(); seekTimelineTime(0); }
    if (event.key === 'End') { event.preventDefault(); seekTimelineTime(sequenceLength); }
  }

  const timelineKeyboardHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  timelineKeyboardHandlerRef.current = handleTimelineKeyboard;

  useEffect(() => () => {
    exportAbortControllerRef.current?.abort();
    void exportAudioGraphRef.current?.context.close();
    for (const assetId of Object.keys(waveformGenerationRef.current)) waveformGenerationRef.current[assetId] += 1;
    const waveformContext = waveformContextRef.current;
    waveformContextRef.current = null;
    if (waveformContext && waveformContext.state !== 'closed') void waveformContext.close().catch(() => undefined);
    videoRefs.forEach((ref) => ref.current?.pause());
    Object.values(audioElementRefs.current).forEach((audio) => audio?.pause());
    audioPlayRequestRef.current.clear();
  }, []);
  useEffect(() => {
    const element = editorLayoutRef.current; if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setEditorLayoutSize({ width: Math.ceil(entry.contentRect.width), height: Math.ceil(entry.contentRect.height) }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = timelineScrollRef.current; if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setTimelineViewportSize({ width: Math.ceil(entry.contentRect.width), height: Math.ceil(entry.contentRect.height) }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (Math.abs(pxPerSecond - timelineScale) > 0.001) setPxPerSecond(timelineScale); }, [pxPerSecond, timelineScale]);
  useEffect(() => { timelineHeightRef.current = timelineHeight; }, [timelineHeight]);
  useEffect(() => {
    timelineTimeRef.current = Math.min(timelineTime, sequenceLength);
    if (timelineTime > sequenceLength) setTimelineTimeState(sequenceLength);
  }, [timelineTime, sequenceLength]);
  useEffect(() => { updateTimelinePlayheadVisual(timelineTime); }, [timelineTime, timelineScale, timelineScrollOffsets.left]);
  useEffect(() => {
    setStartFrameDraft(selectedClip ? String(Math.round(selectedClip.start * frameRateValue)) : '0');
    setSourceInDraft(selectedClip ? String(Number(selectedClip.trimIn.toFixed(3))) : '0');
    setSourceOutDraft(selectedClip ? String(Number(selectedClip.trimOut.toFixed(3))) : '0');
  }, [selectedClip?.id, selectedClip?.start, selectedClip?.trimIn, selectedClip?.trimOut, frameRateValue]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => timelineKeyboardHandlerRef.current(event);
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (!isPlaying || !sequence || isExportingRef.current) return;
    autoFollowRef.current = true; let previous = performance.now(); let previousUiUpdate = previous; let animationFrame = 0;
    const tick = (now: number) => {
      if (isExportingRef.current) return; // Ignore an already-queued playback tick after export takes ownership.
      const elapsed = Math.max(0, (now - previous) / 1000); previous = now;
      const next = Math.min(sequenceLength, timelineTimeRef.current + elapsed);
      if (next >= sequenceLength - 1e-7) {
        if (preferences.editor.playbackLoop && sequenceLength > 0) {
          timelineTimeRef.current = 0;
          setTimelineTimeState(0);
          syncVideoFollower(0, false, true);
          syncAudioFollower(0, false, true);
          previous = now;
          animationFrame = window.requestAnimationFrame(tick);
          return;
        }
        timelineTimeRef.current = sequenceLength; setTimelineTimeState(sequenceLength); syncVideoFollower(sequenceLength, false); syncAudioFollower(sequenceLength, false); setIsPlaying(false); videoRefs.forEach((ref) => ref.current?.pause()); return;
      }
      timelineTimeRef.current = next;
      // Keep the high-frequency clock in a ref; publish UI time at 20 Hz instead of rerendering the editor every RAF.
      const uiUpdateInterval = 50;
      if (now - previousUiUpdate >= uiUpdateInterval) {
        setTimelineTimeState(next);
        previousUiUpdate = now;
      }
      syncVideoFollower(next, true); syncAudioFollower(next, true); updateTimelinePlayheadVisual(next);
      const x = next * timelineScale; const area = timelineScrollRef.current;
      if (autoFollowRef.current && area && area.clientWidth > 0 && x > area.scrollLeft + area.clientWidth - 80) programmaticScroll(x - area.clientWidth * 0.7);
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick); return () => window.cancelAnimationFrame(animationFrame);
  }, [isPlaying, isExporting, sequence, sequenceLength, frameRateValue, timelineScale, sessionSources, hiddenTrackIds, soloTrackIds, preferences.editor.playbackLoop]);
  useEffect(() => {
    if (isPlaying || isExportingRef.current) return; // The active RAF owns media sync while playback or export is running.
    const forceSeek = forcePreviewSyncRef.current;
    forcePreviewSyncRef.current = false;
    syncVideoFollower(timelineTime, false, forceSeek);
    syncAudioFollower(timelineTime, false, forceSeek);
  }, [sequence, timelineTime, isPlaying, sessionSources, hiddenTrackIds, soloTrackIds, volume, previewSyncRevision]);
  useEffect(() => { videoRefs.forEach((ref, index) => { if (ref.current) { ref.current.volume = volume; ref.current.muted = index !== activeDeck || activeTimelineTrackMuted; } }); }, [volume, activeDeck, activeTimelineTrackMuted]);
  useEffect(() => { setSnapEnabled(preferences.editor.snapEnabled); }, [preferences.editor.snapEnabled]);
  useEffect(() => { setRippleMode(preferences.editor.rippleMode); }, [preferences.editor.rippleMode]);
  useEffect(() => { setVolume(preferences.audio.masterVolume); }, [preferences.audio.masterVolume]);
  useEffect(() => {
    const clearWaveformCache = () => {
      for (const assetId of Object.keys(waveformGenerationRef.current)) waveformGenerationRef.current[assetId] += 1;
      setAudioWaveforms({});
      setWaveformLoadingAssetId(null);
      const context = waveformContextRef.current;
      waveformContextRef.current = null;
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    };
    window.addEventListener('clipwright:clear-waveform-cache', clearWaveformCache);
    return () => window.removeEventListener('clipwright:clear-waveform-cache', clearWaveformCache);
  }, []);
  useEffect(() => {
    const firstApply = !zoomPreferenceMountedRef.current;
    zoomPreferenceMountedRef.current = true;
    if (firstApply && pxPerSecond > 0) return;
    const minimum = Math.max(1, minimumPxPerSecond);
    const next = Math.max(minimum, Math.min(maximumPxPerSecond, minimum * preferences.editor.zoomPercent / 100));
    setPxPerSecond(next);
    storeTimelinePxPerSecond(next);
  }, [preferences.editor.zoomPercent]);
  useEffect(() => {
    if (!contextMenu) return;
    const invoker = contextMenuInvokerRef.current;
    contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (contextMenuRestoreFocusRef.current && invoker?.isConnected) invoker.focus();
      contextMenuRestoreFocusRef.current = true;
    };
  }, [contextMenu]);
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnClick = () => closeContextMenu(false);
    const closeOnScroll = () => closeContextMenu();
    window.addEventListener('click', closeOnClick); window.addEventListener('scroll', closeOnScroll, true);
    return () => { window.removeEventListener('click', closeOnClick); window.removeEventListener('scroll', closeOnScroll, true); };
  }, [contextMenu]);

  const sliderValue = maximumPxPerSecond > minimumPxPerSecond ? Math.round(Math.log(timelineScale / minimumPxPerSecond) / Math.log(maximumPxPerSecond / minimumPxPerSecond) * 100) : 0;
  const currentTimecode = formatRulerTime(timecodeFrame, sequence?.frameRate ?? { numerator: Math.round(frameRateValue), denominator: 1 });
  const snapGuide = dragPreview?.guide ?? null;
  const marqueeStyle = marquee ? { left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) } : undefined;

  return <section className={`editor-foundation${isExporting ? ' is-exporting' : ''}`}>
    {missingMediaAssets.length > 0 && <div className="missing-media-banner" role="alert"><div><strong>{missingMediaAssets.length} missing media {missingMediaAssets.length === 1 ? 'file' : 'files'}</strong><span>Offline clips are marked on the timeline. Relink each source before exporting; export is disabled while media is missing.</span></div><button className="button button-secondary button-small" type="button" onClick={() => { const asset = missingMediaAssets[0]; if (asset.kind === 'audio') onRelinkAudio(asset.id); else onRelinkVideo(asset.id); }} disabled={isReadingMedia}><Upload size={14} />Relink {missingMediaAssets[0].name}</button></div>}
    <div className="editor-layout" ref={editorLayoutRef}>
      <div className={`editor-main-row${mediaPanelCollapsed ? ' media-panel-collapsed' : ''}${propertiesPanelCollapsed ? ' properties-panel-collapsed' : ''}`} style={{ '--media-panel-width': `${mediaPanelWidth}px`, '--properties-panel-width': `${propertiesPanelWidth}px` } as React.CSSProperties}>
        <aside className={`editor-media-panel${mediaPanelCollapsed ? ' is-collapsed' : ''}`} aria-label="Project media" data-tour="media-bin" aria-busy={isReadingMedia}>
          <div className="panel-title">
            {!mediaPanelCollapsed && <span>Project media</span>}
            <div className="panel-title-tools">
              <button className="icon-button small" type="button" title={mediaPanelCollapsed ? 'Expand media panel' : 'Collapse media panel'} aria-label={mediaPanelCollapsed ? 'Expand media panel' : 'Collapse media panel'} aria-expanded={!mediaPanelCollapsed} onClick={() => setMediaPanelCollapsed((collapsed) => !collapsed)}>{mediaPanelCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>
              {!mediaPanelCollapsed && <button className="icon-button small" title="Import a local video" aria-label="Import a local video" onClick={onImportVideo} disabled={isReadingMedia || !project}><Plus size={16} /></button>}
              {!mediaPanelCollapsed && <button className="icon-button small" title="Import a local audio file" aria-label="Import a local audio file" onClick={onImportAudio} disabled={isReadingMedia || !project}><Volume2 size={14} /></button>}
              {!mediaPanelCollapsed && <button className="icon-button small" title="Import a local image" aria-label="Import a local image" onClick={onImportImage} disabled={isReadingMedia || !project}><ImageIcon size={14} /></button>}
            </div>
          </div>
          {!mediaPanelCollapsed && <>
            <label className="media-storage-mode"><span>New media storage</span><select className="select-input" aria-label="New media storage mode" value={mediaImportMode} onChange={(event) => onMediaImportModeChange(event.target.value as 'managed' | 'linked')}><option value="managed" disabled={!hasPersistentLibrary}>Managed copy · stays with project</option><option value="linked">{hasPersistentLibrary ? 'Link external original' : 'Session only · browser'}</option></select></label>
            {isReadingMedia && <div className="media-reading-status" role="status" aria-live="polite">Reading local media metadata…</div>}
            {assets.length ? <div className="media-asset-list" aria-label="Media assets">
              {assets.map((asset) => {
                const key = projectDocument ? mediaKey(projectDocument.id, asset.id) : '';
                const available = Boolean(sessionSources[key]);
                const supported = Boolean(asset.streams[asset.kind === 'audio' ? 'audio' : 'video']);
                const storageLabel = asset.pathKind === 'project-relative' ? 'Managed copy' : asset.pathKind === 'absolute' ? 'Linked original' : 'Session only';
                return <div className={`media-asset-row ${key === activeKey ? 'is-selected' : ''}`} key={asset.id}>
                  <button className="media-asset-select" type="button" aria-pressed={key === activeKey} onClick={() => onSelectMedia(key)} disabled={!projectDocument} title={asset.name} draggable={supported} onDragStart={(event) => {
                    mediaDragSourceRef.current = asset.id;
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('application/x-clipwright-source', asset.id);
                    event.dataTransfer.setData('text/plain', asset.id);
                  }} onDragEnd={() => { mediaDragSourceRef.current = null; setDropPreview(null); }}>
                    {asset.kind === 'image' && available ? <img className="media-asset-thumbnail" src={sessionSources[key]?.url} alt="" /> : asset.kind === 'audio' ? <Volume2 size={15} /> : asset.kind === 'image' ? <ImageIcon size={15} /> : <Film size={15} />}<span className="media-asset-copy"><strong>{asset.name}</strong><small>{storageLabel} · {asset.kind === 'image' ? (!available ? 'Relink required' : `${asset.imageDimensions?.width ?? 'Image'} × ${asset.imageDimensions?.height ?? ''} · library item`) : supported ? (!available ? 'Relink required' : `Drag to a ${asset.kind} track`) : `${asset.kind} · library item`}</small></span>
                  </button>
                  {asset.pathKind === 'project-relative' && available && <button className="icon-button small media-reveal" type="button" aria-label={`Reveal ${asset.name} in File Explorer`} title="Reveal managed copy in File Explorer" onClick={() => onRevealMedia(asset.id)}><FolderOpen size={14} /></button>}
                  {asset.kind === 'video' && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkVideo(asset.id)} disabled={isReadingMedia}>Relink</button>}
                  {asset.kind === 'audio' && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkAudio(asset.id)} disabled={isReadingMedia}>Relink</button>}
                  {asset.kind === 'image' && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkImage(asset.id)} disabled={isReadingMedia}>Relink</button>}
                </div>;
              })}
              <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportVideo} disabled={isReadingMedia || !project}><Plus size={13} />Add video</button>
              <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportAudio} disabled={isReadingMedia || !project}><Plus size={13} />Add audio</button>
              <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportImage} disabled={isReadingMedia || !project}><Plus size={13} />Add image</button>
            </div> : <div className="media-empty">
              <div className="media-icon"><Film size={20} /></div><strong>No media imported</strong><span>Choose local video, audio, or image files. Original files are not modified.</span><div className="media-empty-actions"><button className="button button-secondary button-small" onClick={onImportVideo} disabled={isReadingMedia || !project}><Plus size={14} />Import video</button><button className="button button-secondary button-small" onClick={onImportAudio} disabled={isReadingMedia || !project}><Plus size={14} />Import audio</button><button className="button button-secondary button-small" onClick={onImportImage} disabled={isReadingMedia || !project}><Plus size={14} />Import image</button></div>
            </div>}
            {isReadingMedia && <div className="media-reading" role="status">Reading metadata in your browser…</div>}
            <div className="panel-footnote"><HardDrive size={12} />Managed media is copied into this project; linked originals stay in place.</div>
          </>}
        </aside>
        <div className="panel-resize-handle" role="separator" aria-label="Resize Project media panel" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={420} aria-valuenow={mediaPanelWidth} tabIndex={0} onPointerDown={(event) => beginPanelResize(event, 'media')} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize} onKeyDown={(event) => handlePanelResizeKey(event, 'media')}><span /></div>
        <div className="editor-center">
          <div className="preview-stage">{focusMode && <button className="preview-focus-exit" type="button" aria-label="Exit focus mode" title="Exit focus mode (Esc)" onClick={onToggleFocusMode}><Minimize2 size={15} /><span>Exit focus mode</span></button>}<div className="preview-frame" data-tour="preview" style={{ aspectRatio: `${sequence?.width ?? 16} / ${sequence?.height ?? 9}`, width: 'auto', height: '100%', backgroundColor: sequence?.canvasBackground ?? '#000000' }}>
            <video ref={videoARef} className={`preview-video${activeDeck === 0 && timelineVideoVisible && deckReady[0] ? ' is-active' : ''}`} src={deckUrls[0] ?? undefined} playsInline preload="auto" aria-label={`${assets.find((asset) => asset.id === deckSourceIdsRef.current[0])?.name ?? 'Timeline'} source preview`} aria-hidden={activeDeck !== 0} style={{ objectFit: sequence?.canvasFit === 'fill' ? 'cover' : sequence?.canvasFit === 'stretch' ? 'fill' : 'contain', backgroundColor: sequence?.canvasBackground ?? '#000000' }} onLoadedMetadata={() => handlePreviewMetadata(0)} onLoadedData={() => handlePreviewReady(0)} onCanPlay={() => handlePreviewReady(0)} onPlay={() => { playRequestRef.current[0] = false; }} onError={() => { setPlaybackError(true); onPlaybackError(); }} />
            <video ref={videoBRef} className={`preview-video${activeDeck === 1 && timelineVideoVisible && deckReady[1] ? ' is-active' : ''}`} src={deckUrls[1] ?? undefined} playsInline preload="auto" aria-label={`${assets.find((asset) => asset.id === deckSourceIdsRef.current[1])?.name ?? 'Timeline'} source preview`} aria-hidden={activeDeck !== 1} style={{ objectFit: sequence?.canvasFit === 'fill' ? 'cover' : sequence?.canvasFit === 'stretch' ? 'fill' : 'contain', backgroundColor: sequence?.canvasBackground ?? '#000000' }} onLoadedMetadata={() => handlePreviewMetadata(1)} onLoadedData={() => handlePreviewReady(1)} onCanPlay={() => handlePreviewReady(1)} onPlay={() => { playRequestRef.current[1] = false; }} onError={() => { setPlaybackError(true); onPlaybackError(); }} />
            {audioClips.map((clip) => {
              const asset = assets.find((item) => item.id === clip.sourceId);
              const source = projectDocument ? sessionSources[mediaKey(projectDocument.id, clip.sourceId)] : undefined;
              const nearClip = timelineTime + 1 >= clip.start && timelineTime <= clipEnd(clip);
              return <audio key={clip.id} ref={audioElementRefFor(clip.id)} className="timeline-audio-preview" src={source?.url} preload={nearClip ? 'auto' : 'metadata'} aria-hidden="true" aria-label={`Timeline audio: ${asset?.name ?? 'Audio clip'}`} onLoadedMetadata={() => handleAudioReady(clip.id)} onCanPlay={() => handleAudioReady(clip.id)} onPlay={() => audioPlayRequestRef.current.delete(clip.id)} onError={() => { setPlaybackError(true); onPlaybackError(); }} />;
            })}
            {!timelineVideoVisible || !activeTimelineClip || !activeTimelineAsset ? <div className="preview-empty-state"><Film size={35} strokeWidth={1.15} /><span>{activeTimelineClip && activeTimelineAsset && !sessionSources[mediaKey(projectDocument?.id ?? '', activeTimelineClip.sourceId)] ? `Relink “${activeTimelineAsset.name}” to preview this clip` : activeTimelineAudioClip && activeTimelineAudioAsset && !sessionSources[mediaKey(projectDocument?.id ?? '', activeTimelineAudioClip.sourceId)] ? `Relink “${activeTimelineAudioAsset.name}” to play this audio clip` : activeTimelineAudioClip ? 'Audio clip under the playhead · no video image' : sequenceLength && timelineTime < sequenceLength ? 'No clip under the playhead' : 'Add media to the timeline to preview'}</span>{activeTimelineAsset?.kind === 'video' && !sessionSources[mediaKey(projectDocument?.id ?? '', activeTimelineAsset.id)] && <button className="button button-secondary button-small preview-relink" type="button" onClick={() => onRelinkVideo(activeTimelineAsset.id)} disabled={isReadingMedia}><Upload size={13} />Relink video</button>}{activeTimelineAudioAsset && !sessionSources[mediaKey(projectDocument?.id ?? '', activeTimelineAudioAsset.id)] && <button className="button button-secondary button-small preview-relink" type="button" onClick={() => onRelinkAudio(activeTimelineAudioAsset.id)} disabled={isReadingMedia}><Upload size={13} />Relink audio</button>}</div> : null}
            {playbackError && <span className="preview-error" role="status">Browser playback failed for this source.</span>}
            <div className="preview-corner tl"/><div className="preview-corner tr"/><div className="preview-corner bl"/><div className="preview-corner br"/>
            <small>{sequence?.name ?? 'Sequence 01'} · {ratio} · {frameRate}</small>
          </div></div>
          <div className="preview-controls" aria-label="Timeline playback controls">
            <button className="transport-button" type="button" disabled={!sequenceLength} title="Back 5 seconds" aria-label="Seek backward 5 seconds" onClick={() => skipTimeline(-5)}><SkipBack size={15} /></button>
            <button className="play-button" type="button" disabled={!sequenceLength || isExporting} aria-label={isPlaying ? 'Pause timeline playback' : 'Play timeline'} onClick={togglePlayback}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
            <button className="transport-button" type="button" disabled={!sequenceLength} title="Forward 5 seconds" aria-label="Seek forward 5 seconds" onClick={() => skipTimeline(5)}><SkipForward size={15} /></button>
            <span className="time-readout"><span><small>Current</small>{formatPlaybackTime(timelineTime)}</span><i>/</i><span><small>Total</small>{formatPlaybackTime(sequenceLength)}</span></span>
            <input className="preview-seek" aria-label="Seek timeline" type="range" min="0" max={Math.max(sequenceLength, 1 / frameRateValue)} step={1 / frameRateValue} value={Math.min(timelineTime, sequenceLength)} onChange={(event) => seekTimelineTime(Number(event.target.value))} disabled={!sequenceLength} />
            <button className="volume-button" type="button" aria-label={volume > 0 ? 'Mute preview audio' : 'Unmute preview audio'} onClick={() => setPreviewVolume(volume > 0 ? 0 : preferences.audio.masterVolume || 0.8)} disabled={!activeTimelineClip && activeTimelineAudioClips.length === 0}>{volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}</button>
            <input className="preview-volume" aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setPreviewVolume(Number(event.target.value))} disabled={!activeTimelineClip && activeTimelineAudioClips.length === 0} />
            <span className="preview-quality" title="Timeline time is the master clock. Browser video follows and is corrected when it drifts.">Timeline preview</span>
          </div>
        </div>
        <div className="panel-resize-handle" role="separator" aria-label="Resize Properties panel" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={440} aria-valuenow={propertiesPanelWidth} tabIndex={0} onPointerDown={(event) => beginPanelResize(event, 'properties')} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize} onKeyDown={(event) => handlePanelResizeKey(event, 'properties')}><span /></div>
        <aside className={`properties-panel${propertiesPanelCollapsed ? ' is-collapsed' : ''}`} aria-label="Properties" data-tour="properties">
          <div className="panel-title">{!propertiesPanelCollapsed && <span>Properties</span>}<button className="icon-button small" type="button" aria-label={propertiesPanelCollapsed ? 'Expand Properties panel' : 'Collapse Properties panel'} aria-expanded={!propertiesPanelCollapsed} title={propertiesPanelCollapsed ? 'Expand Properties panel' : 'Collapse Properties panel'} onClick={() => { setPropertiesPanelCollapsed((collapsed) => { const next = !collapsed; try { window.localStorage.setItem('clipwright.workspace.properties-collapsed', String(next)); } catch { /* Panel remains resizable for this session. */ } return next; }); }}>{propertiesPanelCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button></div>
          {!propertiesPanelCollapsed && <div className="properties-body">
            {sequence && <ProjectCanvasSettings sequence={sequence} onApply={applyCanvasSettings} />}
            {selectedClip && selectedClipAsset ? <div className="property-section selected-clip-properties">
              <span className="panel-kicker">TIMELINE CLIP</span><strong className="selected-clip-name">{selectedClipAsset.name}</strong>
              <div className="property-line"><span>Start</span><strong>{formatPlaybackTime(selectedClip.start)}</strong></div>
              <div className="property-line"><span>Duration</span><strong>{formatPlaybackTime(clipDuration(selectedClip))}</strong></div>
              <div className="property-line"><span>Source range</span><strong>{selectedClip.trimIn.toFixed(3)}–{selectedClip.trimOut.toFixed(3)} s</strong></div>
              <form className="frame-position-form" onSubmit={(event) => {
                event.preventDefault(); const start = Math.max(0, Number(startFrameDraft) / frameRateValue);
                persistTimelineEdit((doc) => moveTimelineClips(doc, sequence!.id, [selectedClip.id], selectedClip.trackId, start, rippleMode), 'Moved clip to the requested frame.');
              }}>
                <label htmlFor="clip-start-frame">Timeline start frame</label><div><input id="clip-start-frame" type="number" min="0" step="1" value={startFrameDraft} onChange={(event) => setStartFrameDraft(event.target.value)} disabled={!!selectedClipTrack?.locked} /><button className="button button-secondary button-small" type="submit" disabled={!!selectedClipTrack?.locked}>Set</button></div>
              </form>
              <form className="source-trim-form" onSubmit={(event) => {
                event.preventDefault(); persistTimelineEdit((doc) => resizeTimelineClip(doc, sequence!.id, selectedClip.id, selectedClip.start, Number(sourceInDraft), Number(sourceOutDraft), rippleMode), 'Updated clip source trim.');
              }}>
                <div><label htmlFor="clip-source-in">Source in (seconds)</label><input id="clip-source-in" type="number" min="0" max={sourceDuration(selectedClip.sourceId, selectedClipTrack?.kind ?? 'video')} step="any" value={sourceInDraft} onChange={(event) => setSourceInDraft(event.target.value)} disabled={!!selectedClipTrack?.locked} /></div>
                <div><label htmlFor="clip-source-out">Source out (seconds)</label><input id="clip-source-out" type="number" min="0" max={sourceDuration(selectedClip.sourceId, selectedClipTrack?.kind ?? 'video')} step="any" value={sourceOutDraft} onChange={(event) => setSourceOutDraft(event.target.value)} disabled={!!selectedClipTrack?.locked} /></div>
                <button className="button button-secondary button-small" type="submit" disabled={!!selectedClipTrack?.locked}>Apply trim</button>
              </form>
              <small>All edit times snap to the sequence frame rate. Original media is never changed.</small>
              {selectedClipTrack?.kind === 'audio' && <div className="audio-track-controls" role="group" aria-label={`${selectedClipTrack.name} audio controls`}>
                <span className="panel-kicker">AUDIO TRACK MIX</span>
                <div className="audio-control-label"><label htmlFor={`track-gain-${selectedClipTrack.id}`}>Gain</label><output>{Math.round((audioControlsDraft?.trackId === selectedClipTrack.id ? audioControlsDraft.gain : selectedClipTrack.gain ?? 1) * 100)}%</output></div>
                <input id={`track-gain-${selectedClipTrack.id}`} aria-label={`${selectedClipTrack.name} gain`} aria-valuetext={`${Math.round((audioControlsDraft?.trackId === selectedClipTrack.id ? audioControlsDraft.gain : selectedClipTrack.gain ?? 1) * 100)} percent`} type="range" min="0" max="2" step="0.01" value={audioControlsDraft?.trackId === selectedClipTrack.id ? audioControlsDraft.gain : selectedClipTrack.gain ?? 1} disabled={selectedClipTrack.locked} onChange={(event) => updateAudioControlDraft(selectedClipTrack, 'gain', Number(event.target.value))} onPointerUp={commitAudioControlDraft} onPointerCancel={commitAudioControlDraft} onKeyUp={commitAudioControlDraft} onBlur={commitAudioControlDraft} />
                <div className="audio-control-label"><label htmlFor={`track-pan-${selectedClipTrack.id}`}>Pan</label><output>{(() => { const pan = audioControlsDraft?.trackId === selectedClipTrack.id ? audioControlsDraft.pan : selectedClipTrack.pan ?? 0; return pan === 0 ? 'Center' : `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? 'left' : 'right'}`; })()}</output></div>
                <input id={`track-pan-${selectedClipTrack.id}`} aria-label={`${selectedClipTrack.name} pan`} aria-valuetext={(() => { const pan = audioControlsDraft?.trackId === selectedClipTrack.id ? audioControlsDraft.pan : selectedClipTrack.pan ?? 0; return pan === 0 ? 'Center' : `${Math.round(Math.abs(pan) * 100)} percent ${pan < 0 ? 'left' : 'right'}`; })()} type="range" min="-1" max="1" step="0.01" value={audioControlsDraft?.trackId === selectedClipTrack.id ? audioControlsDraft.pan : selectedClipTrack.pan ?? 0} disabled={selectedClipTrack.locked} onChange={(event) => updateAudioControlDraft(selectedClipTrack, 'pan', Number(event.target.value))} onPointerUp={commitAudioControlDraft} onPointerCancel={commitAudioControlDraft} onKeyUp={commitAudioControlDraft} onBlur={commitAudioControlDraft} />
                <small>Applied to timeline preview and WebM export.</small>
                {selectedClipAsset?.kind === 'audio' && (selectedAudioWaveform
                  ? <small className="waveform-session-status">Waveform ready for this page session.</small>
                  : selectedAudioSource
                    ? <button className="button button-secondary button-small waveform-generate-button" type="button" onClick={() => void generateAudioWaveform(selectedClipAsset)} disabled={isReadingMedia || waveformLoadingAssetId !== null}><Volume2 size={13} />{waveformLoadingAssetId === selectedClipAsset.id ? 'Generating waveform…' : 'Generate waveform'}</button>
                    : <small>Relink this source to generate its waveform.</small>)}
              </div>}
            </div> : <div className="properties-empty"><Settings2 size={20} /><strong>Nothing selected</strong><span>Select clips to edit their timeline position and trims.</span></div>}
          </div>}
        </aside>
      </div>
      <div className="timeline-resize-handle" role="separator" aria-label="Resize preview and timeline" aria-orientation="horizontal" aria-valuemin={timelineMinHeight} aria-valuemax={timelineMaxHeight} aria-valuenow={effectiveTimelineHeight} aria-valuetext={`${previewHeightPercent}% preview height`} tabIndex={0} onPointerDown={beginTimelineResize} onPointerMove={moveTimelineResize} onPointerUp={endTimelineResize} onPointerCancel={endTimelineResize} onKeyDown={handleTimelineResizeKey}><span /></div>
      <div className="timeline-panel" data-tour="timeline" style={{ height: effectiveTimelineHeight }}>
        <div className="timeline-heading">
          <div><span className="panel-kicker">TIMELINE</span><span className="timeline-sequence">{sequence?.name ?? 'Sequence 01'}</span></div>
          <div className="timeline-tools" role="group" aria-label="Timeline editing tools">
            <div className="timeline-tool-group" role="group" aria-label="History">
              <button type="button" aria-label="Undo timeline change" title={`Undo (${preferences.shortcuts.undo})`} disabled={!canUndo} onClick={undoTimelineEdit}><Undo2 size={15} /></button>
              <button type="button" aria-label="Redo timeline change" title={`Redo (${preferences.shortcuts.redo})`} disabled={!canRedo} onClick={redoTimelineEdit}><Redo2 size={15} /></button>
            </div>
            <span className="timeline-tool-divider" aria-hidden="true" />
            <div className="timeline-tool-group" role="group" aria-label="Clip editing">
              <button className="tool-add-at-playhead" type="button" aria-label="Add at playhead" title="Insert selected media at playhead" onClick={addSelectedSourceAtPlayhead} disabled={!activeKey || !sequence}><Plus size={15} /><span>Add at playhead</span></button>
              <button type="button" aria-label="Split clip at playhead" title={`Split at playhead (${preferences.shortcuts.split})`} disabled={!sequenceLength} onClick={splitAtPlayhead}><Scissors size={15} /></button>
              <button type="button" aria-label="Duplicate selected clips" title={`Duplicate (${preferences.shortcuts.duplicate})`} disabled={!selectedClipIds.length} onClick={duplicateSelected}><Copy size={15} /></button>
              <button type="button" aria-label="Copy selected clips" title={`Copy (${preferences.shortcuts.copy})`} disabled={!selectedClipIds.length} onClick={copySelected}><ClipboardPaste size={15} /></button>
              <button type="button" aria-label="Paste clips at playhead" title={`Paste (${preferences.shortcuts.paste})`} disabled={!clipboardClips.length} onClick={pasteAtPlayhead}><ClipboardPaste size={15} /></button>
              <button type="button" aria-label="Delete selected clips" title="Delete selected clips (Shift+Delete ripples)" disabled={!selectedClipIds.length} onClick={() => deleteSelected(false)}><Trash2 size={15} /></button>
            </div>
            <span className="timeline-tool-divider" aria-hidden="true" />
            <div className="timeline-tool-group" role="group" aria-label="Snapping and ripple">
              <button type="button" className={snapEnabled ? 'is-active' : ''} aria-pressed={snapEnabled} aria-label={snapEnabled ? 'Disable snapping' : 'Enable snapping'} title={`Snapping ${snapEnabled ? 'on' : 'off'} (${preferences.shortcuts.snap})`} onClick={toggleSnapPreference}><Magnet size={15} /></button>
              <button type="button" className={rippleMode ? 'is-active' : ''} aria-pressed={rippleMode} aria-label={rippleMode ? 'Disable ripple mode' : 'Enable ripple mode'} title={`Ripple mode ${rippleMode ? 'on' : 'off'} · affects clip moves, trims, and delete`} onClick={toggleRipplePreference}><ArrowLeftRight size={15} /></button>
            </div>
            <span className="timeline-tool-divider" aria-hidden="true" />
            <div className="timeline-zoom" role="group" aria-label="Timeline zoom controls">
              <button type="button" aria-label="Zoom timeline out" title="Zoom out" disabled={timelineScale <= minimumPxPerSecond + 0.001} onClick={() => zoomTimeline(timelineScale / 1.25)}><ZoomOut size={15} /></button>
              <input aria-label="Timeline zoom level" type="range" min="0" max="100" step="1" value={sliderValue} onChange={(event) => zoomTimeline(minimumPxPerSecond * Math.pow(maximumPxPerSecond / minimumPxPerSecond, Number(event.target.value) / 100))} />
              <button type="button" aria-label="Zoom timeline in" title="Zoom in" disabled={timelineScale >= maximumPxPerSecond - 0.001} onClick={() => zoomTimeline(timelineScale * 1.25)}><ZoomIn size={15} /></button>
              <button type="button" aria-label="Fit project in timeline" title="Fit project in view" onClick={fitTimeline}><Maximize2 size={15} /></button>
              <output aria-live="polite">{Math.round(timelineScale / minimumPxPerSecond * 100)}%</output>
            </div>
          </div>
        </div>
        {sequence ? <><div className="timeline-grid" onWheel={handleTimelineWheel}>
          <div className="timeline-corner" role="group" aria-label={`Playhead at ${currentTimecode}`}><span>{currentTimecode}</span></div>
          <div className="timeline-ruler-viewport" role="group" aria-label="Timeline ruler" onPointerDown={beginRulerScrub} onPointerMove={moveRulerScrub} onPointerUp={endRulerScrub} onPointerCancel={endRulerScrub}>
            <div ref={timelineRulerContentRef} className="timeline-ruler" style={{ width: timelineContentWidth, transform: `translateX(-${timelineScrollOffsets.left}px)` }}>
              {timelineTicks.map(({ index, seconds, major }) => <span className={`timeline-tick ${major ? 'is-major' : 'is-minor'}`} key={index} style={{ left: `${seconds * timelineScale}px` }}><i aria-hidden="true" />{major && <em>{formatRulerLabel(seconds, frameRateValue, rulerStepSeconds)}</em>}</span>)}
            </div>
            <div ref={timelineRulerPlayheadRef} className="timeline-ruler-playhead" style={{ transform: `translateX(${timelineTime * timelineScale - timelineScrollOffsets.left}px)` }}>
              <button className="timeline-playhead-grab" type="button" role="slider" aria-label="Timeline playhead" aria-valuemin={0} aria-valuemax={timelineCanvasFrames} aria-valuenow={timecodeFrame} aria-valuetext={currentTimecode} onPointerDown={beginPlayheadDrag} onPointerMove={movePlayheadDrag} onPointerUp={endPlayheadDrag} onPointerCancel={endPlayheadDrag} onKeyDown={handlePlayheadKeyDown} onClick={(event) => event.stopPropagation()} />
            </div>
          </div>
          <div className="timeline-track-header-column"><div className="timeline-track-header-rows" ref={timelineTrackHeaderRowsRef} style={{ gridTemplateRows: timelineTrackRowTemplate, height: timelineRowsContentHeight }}>
            {tracks.map((track, index) => <div className={`track-row${track.kind === 'audio' ? ' audio-track' : ''}${hiddenTrackIds[track.id] ? ' is-track-hidden' : ''}`} key={track.id}>
              <div className="track-header" title={track.kind === 'audio' ? `${track.name} · select an audio clip to adjust gain and pan` : track.name}>
                <span className={`track-badge ${track.kind === 'audio' ? 'audio-track-badge' : 'video-track-badge'}`}>{track.kind === 'audio' ? `A${tracks.filter((item, i) => item.kind === 'audio' && i <= index).length}` : `V${tracks.filter((item, i) => item.kind === 'video' && i <= index).length}`}</span>
                <span className="track-header-name">{track.name}</span>
                <div className="track-header-actions">
                  <button className="track-action" type="button" title={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} aria-pressed={track.muted} onClick={() => onToggleTrackState(track.id, 'muted')}>{track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>
                  {track.kind === 'audio' && <button className={`track-action track-solo-action${soloTrackIds.includes(track.id) ? ' is-soloed' : ''}`} type="button" title={soloTrackIds.includes(track.id) ? `Unsolo ${track.name} (saved; affects preview and export)` : `Solo ${track.name} (saved; affects preview and export)`} aria-label={soloTrackIds.includes(track.id) ? `Unsolo ${track.name}` : `Solo ${track.name}`} aria-pressed={soloTrackIds.includes(track.id)} disabled={isExporting} onClick={() => toggleTrackSolo(track.id)}><span>S</span></button>}
                  <button className="track-action" type="button" title={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`} aria-label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`} aria-pressed={track.locked} onClick={() => onToggleTrackState(track.id, 'locked')}>{track.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
                  <button className="track-action" type="button" title={hiddenTrackIds[track.id] ? `Show ${track.name} (saved; affects preview and export)` : `Hide ${track.name} (saved; affects preview and export)`} aria-label={hiddenTrackIds[track.id] ? `Show ${track.name}` : `Hide ${track.name}`} aria-pressed={!!hiddenTrackIds[track.id]} onClick={() => updateTrackRenderState(track.id, 'hidden')}>{hiddenTrackIds[track.id] ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                </div>
              </div>
            </div>)}
          </div></div>
          <div className="timeline-track-area" ref={timelineScrollRef} role="region" aria-label="Timeline tracks" tabIndex={0} onKeyDown={(event) => { if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && !(event.target as HTMLElement).closest('.timeline-clip')) handleContextMenuKey(event, null); }} onScroll={handleTimelineScroll} onClick={clearSelectionOnEmptyClick} onContextMenu={(event) => { if (!(event.target as HTMLElement).closest('.timeline-clip')) openContextMenu(event, null); }} onPointerDown={beginMarquee} onPointerMove={moveMarquee} onPointerUp={finishMarquee} onPointerCancel={finishMarquee} onDragOver={handleMediaDragOver} onDragLeave={() => setDropPreview(null)} onDrop={handleMediaDrop}>
            <div className="timeline-canvas" style={{ width: timelineContentWidth, minHeight: timelineRowsContentHeight }}>
              <div className="timeline-track-rows" style={{ gridTemplateRows: timelineTrackRowTemplate, height: timelineRowsContentHeight }}>
                {tracks.map((track) => <div className={`track-row${track.kind === 'audio' ? ' audio-track' : ''}${hiddenTrackIds[track.id] ? ' is-track-hidden' : ''}`} data-track-id={track.id} key={track.id}>
                  <div className={`track-space timeline-track-space${track.kind === 'audio' ? ' audio-track-space' : ''}`} title={track.kind === 'audio' ? 'Audio clips play in sync; select one to adjust its track gain and pan.' : undefined} style={{ width: timelineContentWidth, flex: '0 0 auto', backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)', backgroundSize: `${rulerStepSeconds * timelineScale}px 100%` }}>
                    {track.clips.map((clip) => {
                      const asset = assets.find((item) => item.id === clip.sourceId);
                      const waveformSource = projectDocument ? sessionSources[mediaKey(projectDocument.id, clip.sourceId)] : undefined;
                      const waveformPeaks = preferences.editor.showWaveforms && asset?.kind === 'audio' && waveformSource && audioWaveforms[asset.id]?.sourceUrl === waveformSource.url ? audioWaveforms[asset.id].peaks : null;
                      const clipOffline = Boolean(projectDocument && !sessionSources[mediaKey(projectDocument.id, clip.sourceId)]);
                      const preview = dragPreview?.items.find((item) => item.id === clip.id);
                      const shown = preview && preview.trackId === track.id ? preview : clip;
                      const movedAway = dragPreview?.items.some((item) => item.id === clip.id && item.trackId !== track.id);
                      return <div key={clip.id} className={`timeline-clip${selectedClipIds.includes(clip.id) ? ' is-selected' : ''}${track.kind === 'audio' ? ' is-audio-clip' : ''}${preview ? ' is-drag-preview' : ''}${clipOffline ? ' is-offline' : ''}`} style={{ left: shown.start * timelineScale, width: Math.max(8, clipDuration(shown) * timelineScale), opacity: movedAway ? .22 : undefined }} onContextMenu={(event) => openContextMenu(event, clip.id)} onKeyDown={(event) => handleContextMenuKey(event, clip.id)}>
                        <button className="timeline-clip-body" type="button" aria-label={`Select ${asset?.name ?? 'media'} clip`} aria-description={clipOffline ? 'Missing media source; relink before export.' : undefined} aria-pressed={selectedClipIds.includes(clip.id)} title={`${asset?.name ?? 'Media'} · ${formatPlaybackTime(clip.start)} · ${formatPlaybackTime(clipDuration(clip))}${clipOffline ? ' · Missing media: relink before export' : ''}`} onClick={(event) => { event.stopPropagation(); if (!suppressClipClickRef.current) selectClip(clip, event); }} onPointerDown={(event) => beginClipDrag(event, clip)} onPointerMove={moveClipDrag} onPointerUp={finishClipDrag} onPointerCancel={finishClipDrag}>
                          {waveformPeaks && <svg className="audio-waveform" aria-hidden="true" viewBox={`0 0 ${waveformPeaks.length * 2} 24`} preserveAspectRatio="none">{waveformPeaks.map((peak, index) => { const height = Math.max(2, peak * 20); return <rect key={index} x={index * 2 + 0.4} y={(24 - height) / 2} width="1.2" height={height} rx="0.6" />; })}</svg>}
                          <span className="timeline-clip-title">{asset?.name ?? 'Media clip'}</span>
                        </button>
                        <span className="clip-edge-handle clip-edge-left" role="slider" tabIndex={track.locked ? -1 : 0} aria-disabled={track.locked} aria-orientation="horizontal" aria-label={`Trim start of ${asset?.name ?? 'clip'}`} aria-valuemin={0} aria-valuemax={Math.max(0, clip.trimOut - 1 / frameRateValue)} aria-valuenow={clip.trimIn} aria-valuetext={`Source in ${formatPlaybackTime(clip.trimIn)}`} onPointerDown={(event) => beginClipDrag(event, clip, 'trim-left')} onPointerMove={moveClipDrag} onPointerUp={finishClipDrag} onPointerCancel={finishClipDrag} onKeyDown={(event) => handleTrimKey(event, clip, 'left')} />
                        <span className="clip-edge-handle clip-edge-right" role="slider" tabIndex={track.locked ? -1 : 0} aria-disabled={track.locked} aria-orientation="horizontal" aria-label={`Trim end of ${asset?.name ?? 'clip'}`} aria-valuemin={clip.trimIn + 1 / frameRateValue} aria-valuemax={sourceDuration(clip.sourceId, track.kind)} aria-valuenow={clip.trimOut} aria-valuetext={`Source out ${formatPlaybackTime(clip.trimOut)}`} onPointerDown={(event) => beginClipDrag(event, clip, 'trim-right')} onPointerMove={moveClipDrag} onPointerUp={finishClipDrag} onPointerCancel={finishClipDrag} onKeyDown={(event) => handleTrimKey(event, clip, 'right')} />
                      </div>;
                    })}
                    {dragPreview?.items.filter((item) => item.trackId === track.id && !track.clips.some((clip) => clip.id === item.id)).map((clip) => <div key={`ghost-${clip.id}`} className={`timeline-clip is-drag-ghost${track.kind === 'audio' ? ' is-audio-clip' : ''}`} style={{ left: clip.start * timelineScale, width: Math.max(8, clipDuration(clip) * timelineScale) }}><span>{assets.find((asset) => asset.id === clip.sourceId)?.name}</span></div>)}
                    {dropPreview?.trackId === track.id && <div className="timeline-drop-ghost" style={{ left: dropPreview.start * timelineScale, width: Math.max(8, dropPreview.duration * timelineScale) }}>Drop source</div>}
                    {!track.clips.length && track.kind === 'video' && <div className="empty-track"><span>Drag media here or add the selected source at the playhead</span></div>}
                  </div>
                </div>)}
              </div>
              <div ref={timelinePlayheadRef} className="timeline-playhead" style={{ transform: `translateX(${timelineTime * timelineScale}px)` }} />
              {snapGuide !== null && <div className="timeline-snap-guide" style={{ transform: `translateX(${snapGuide * timelineScale}px)` }} />}
              {dropPreview?.guide !== null && dropPreview && <div className="timeline-snap-guide is-drop-guide" style={{ transform: `translateX(${dropPreview.guide * timelineScale}px)` }} />}
              {marquee && <div className="timeline-marquee" style={marqueeStyle} />}
            </div>
          </div>
        </div><div className="timeline-track-footer"><div><strong>Build your track stack</strong><span>Drag local media from Project media onto the timeline, or add an empty track to organize a sequence.</span></div><div><button className="button button-secondary button-small" type="button" onClick={() => addTimelineTrack('video')}><Plus size={13} />Add video track</button><button className="button button-secondary button-small" type="button" onClick={() => addTimelineTrack('audio')}><Plus size={13} />Add audio track</button></div></div></> : <div className="timeline-empty">This project has no sequence to edit.</div>}
        {contextMenu && <div ref={contextMenuRef} className="timeline-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="group" aria-label={contextMenu.clipId ? 'Selected clip actions' : 'Timeline actions'} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContextMenu(); } }}>
          <button type="button" onClick={copySelected} disabled={!selectedClipIds.length}>Copy</button>
          <button type="button" onClick={pasteAtPlayhead} disabled={!clipboardClips.length}>Paste at playhead</button>
          <button type="button" onClick={duplicateSelected} disabled={!selectedClipIds.length}>Duplicate</button>
          <button type="button" onClick={() => { splitAtPlayhead(); closeContextMenu(); }} disabled={!sequenceLength}>Split at playhead</button>
          <button type="button" onClick={() => deleteSelected(false)} disabled={!selectedClipIds.length}>Delete</button>
          <button type="button" onClick={() => deleteSelected(true)} disabled={!selectedClipIds.length}>Ripple delete</button>
        </div>}
      </div>
    </div>
    {exportDialogOpen && <ExportDialog
      sequence={sequence}
      container={exportContainer}
      onContainerChange={(value) => { setExportContainer(value); onPreferenceChange((current) => ({ ...current, export: { ...current.export, container: value } })); }}
      resolution={exportResolution}
      onResolutionChange={(value) => { setExportResolution(value); onPreferenceChange((current) => ({ ...current, export: { ...current.export, resolution: value } })); }}
      quality={exportQuality}
      onQualityChange={(value) => { setExportQuality(value); onPreferenceChange((current) => ({ ...current, export: { ...current.export, quality: value } })); }}
      capability={mp4Capability}
      audioIncluded={mp4AudioRequired}
      sequenceLength={sequenceLength}
      estimatedBytes={exportEstimatedBytes}
      estimatedSeconds={lastExportSpeedFactor ? lastExportSpeedFactor * sequenceLength : null}
      missingMediaCount={missingMediaAssets.length}
      isPlaying={isPlaying}
      isExporting={isExporting}
      isSaving={isSavingExport}
      progress={exportProgress}
      filename={exportFilename}
      onFilenameChange={setExportFilename}
      folder={exportFolder}
      canChooseFolder={Boolean(window.clipwright?.exportFiles)}
      onChooseFolder={() => { void chooseExportFolder(); }}
      savedFile={exportSavedFile}
      saveError={exportSaveError}
      onStart={() => { void startVideoExport(); }}
      onCancel={cancelVideoExport}
      onOpenFolder={() => { void openExportFolder(); }}
      onClose={() => onExportDialogOpenChange(false)}
    />}
  </section>;
}

function ClippingFoundation({ onCreate }: { onCreate: () => void }) {
  return <section className="clipping-view"><div className="clipping-heading"><div><div className="eyebrow">AI-ASSISTED WORKFLOW</div><h1>Find the moments worth keeping.</h1><p>Turn long recordings into focused clips — with you in control of every cut.</p></div><div className="clipping-mark"><Sparkles size={23} /></div></div><div className="clipping-notice"><span className="notice-indicator" /><div><strong>Analysis is not available yet</strong><p>This build does not include a transcription model or highlight-analysis provider. Your media will not be uploaded or analyzed.</p></div><span className="planned-tag">FOUNDATION</span></div><div className="clipping-steps"><div className="step-card"><span className="step-number">01</span><div className="step-icon"><FolderOpen size={19} /></div><h3>Preview your source</h3><p>Import a local video from the Editor for browser-based metadata and preview.</p><span className="step-state">Available in Editor</span></div><div className="step-connector" /><div className="step-card"><span className="step-number">02</span><div className="step-icon"><Sparkles size={19} /></div><h3>Review moments</h3><p>Check transcript-backed suggestions and why they were selected.</p><span className="step-state">Provider required</span></div><div className="step-connector" /><div className="step-card"><span className="step-number">03</span><div className="step-icon"><Clapperboard size={19} /></div><h3>Edit & export</h3><p>Refine the cut in the editor and record a browser-native WebM export.</p><span className="step-state">WebM available · offline render upcoming</span></div></div><div className="clipping-footer"><div><span className="footer-label">DESIGNED FOR PRIVACY</span><strong>Local-first, by default</strong><span> Cloud processing will always require explicit consent.</span></div><button className="button button-secondary" onClick={onCreate}><Plus size={15} />Create a project</button></div></section>;
}

function RecoveryDialog({ projectName, points, restoring, onRestore, onClose }: { projectName: string; points: ClipWrightRecoveryPoint[]; restoring: boolean; onRestore: (point: ClipWrightRecoveryPoint) => void; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLElement>(() => closeButtonRef.current);
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !restoring) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="dialog recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <div className="dialog-head"><div className="dialog-icon"><History size={17} /></div><button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} disabled={restoring} aria-label="Close recovery"><X size={17} /></button></div>
      <div className="eyebrow">PROJECT RECOVERY</div><h2 id="recovery-title">Restore a checkpoint</h2><p className="dialog-copy">Choose an earlier saved version of “{projectName}”. The current disk file is checkpointed before it is replaced.</p>
      {points.length ? <div className="recovery-list">{points.map((point) => <div className="recovery-row" key={point.id}><div><strong>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(point.modifiedAt))}</strong><span>{new Intl.NumberFormat().format(point.sizeBytes)} bytes</span></div><button className="button button-secondary button-small" type="button" onClick={() => onRestore(point)} disabled={restoring}>Restore</button></div>)}</div> : <div className="recovery-empty"><History size={18} /><span>No earlier checkpoints yet. A checkpoint is created when the project file changes.</span></div>}
      <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={onClose} disabled={restoring}>Close</button></div>
    </section>
  </div>;
}

function ProjectCanvasSettings({ sequence, onApply, idPrefix = 'property-canvas' }: { sequence: Sequence; onApply: (width: number, height: number, fit: NonNullable<Sequence['canvasFit']>, background: string) => void; idPrefix?: string }) {
  const fit = sequence.canvasFit ?? 'fit';
  const background = sequence.canvasBackground ?? '#000000';
  const ratio = aspectRatioOf(sequence.width, sequence.height);
  const presets: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 },
    '4:3': { width: 1440, height: 1080 }, '3:4': { width: 1080, height: 1440 }, '4:5': { width: 1080, height: 1350 },
    '5:4': { width: 1350, height: 1080 }, '21:9': { width: 2520, height: 1080 },
  };
  return <section className="property-section project-canvas-settings" aria-labelledby="project-canvas-title">
    <span className="panel-kicker">PROJECT CANVAS</span>
    <strong id="project-canvas-title">{sequence.width} × {sequence.height} px · {ratio}</strong>
    <label className="canvas-setting-label" htmlFor={`${idPrefix}-aspect-preset`}>Aspect ratio preset</label>
    <select id={`${idPrefix}-aspect-preset`} className="select-input" value={presets[ratio] ? ratio : 'custom'} onChange={(event) => {
      const preset = presets[event.target.value];
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

function formatFileSize(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return 'Not available';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `~${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function ExportDialog({
  sequence, container, onContainerChange, resolution, onResolutionChange, quality, onQualityChange, capability, audioIncluded,
  sequenceLength, estimatedBytes, estimatedSeconds, missingMediaCount, isPlaying, isExporting, isSaving, progress, filename,
  onFilenameChange, folder, canChooseFolder, onChooseFolder, savedFile, saveError, onStart, onCancel, onOpenFolder, onClose,
}: {
  sequence: Sequence | null;
  container: 'webm' | 'mp4';
  onContainerChange: (value: 'webm' | 'mp4') => void;
  resolution: ExportResolutionPreset;
  onResolutionChange: (value: ExportResolutionPreset) => void;
  quality: ExportQualityPreset;
  onQualityChange: (value: ExportQualityPreset) => void;
  capability: { pending: boolean; supported: boolean; reason: string | null };
  audioIncluded: boolean;
  sequenceLength: number;
  estimatedBytes: number | null;
  estimatedSeconds: number | null;
  missingMediaCount: number;
  isPlaying: boolean;
  isExporting: boolean;
  isSaving: boolean;
  progress: number;
  filename: string;
  onFilenameChange: (value: string) => void;
  folder: { handle: string; folderName: string } | null;
  canChooseFolder: boolean;
  onChooseFolder: () => void;
  savedFile: { handle: string; fileName: string; folderName: string } | null;
  saveError: string | null;
  onStart: () => void;
  onCancel: () => void;
  onOpenFolder: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLElement>(() => closeRef.current);
  const dimensions = sequence ? getExportDimensions(sequence.width, sequence.height, resolution) : null;
  const formatName = container === 'mp4'
    ? (audioIncluded ? 'MP4 · H.264 video + AAC-LC audio' : 'MP4 · H.264 video only')
    : (audioIncluded ? 'WebM · VP9 video + Opus audio' : 'WebM · VP9 video only');
  const webmApiAvailable = typeof VideoEncoder !== 'undefined' && (!audioIncluded || typeof AudioEncoder !== 'undefined');
  const exportUnavailableReason = missingMediaCount
    ? `Relink ${missingMediaCount} missing timeline ${missingMediaCount === 1 ? 'source' : 'sources'} before exporting.`
    : !filename.trim() ? 'Enter a filename for the exported file.'
    : canChooseFolder && estimatedBytes !== null && estimatedBytes > 1024 * 1024 * 1024 ? 'The estimated output exceeds the desktop save bridge 1 GiB limit. Reduce resolution or quality, or export a shorter sequence.'
    : isPlaying ? 'Pause playback before exporting.'
      : !sequenceLength ? 'Add media to the sequence before exporting.'
        : container === 'mp4' && (capability.pending || !capability.supported)
          ? capability.pending ? 'Checking the exact H.264/AAC-LC configuration…' : capability.reason ?? 'MP4 is unavailable for this configuration.'
          : container === 'webm' && !webmApiAvailable
            ? 'WebM export requires WebCodecs video encoding and, when the sequence has audio, WebCodecs audio encoding.'
            : null;
  const exportDisabled = Boolean(exportUnavailableReason) && !isExporting;

  return <div className="overlay export-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isExporting) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" aria-describedby="export-description">
      <div className="dialog-head"><div className="dialog-icon"><Download size={17} /></div><button ref={closeRef} className="icon-button" type="button" onClick={onClose} disabled={isExporting} aria-label="Close export settings"><X size={17} /></button></div>
      <div className="eyebrow">LOCAL EXPORT</div><h2 id="export-title">Export sequence</h2><p id="export-description" className="dialog-copy">Render the current project sequence on this device. Source media stays local and is not copied into the project file.</p>
      <div className="export-dialog-grid">
        <label><span>Format and codec</span><select className="select-input" value={container} onChange={(event) => onContainerChange(event.target.value as 'webm' | 'mp4')} disabled={isExporting}>
          <option value="webm">{audioIncluded ? 'WebM · VP9 / Opus' : 'WebM · VP9 video only'}</option>
          <option value="mp4" disabled={capability.pending || !capability.supported}>{capability.pending ? 'MP4 · checking codec support…' : capability.supported ? (audioIncluded ? 'MP4 · H.264 / AAC-LC' : 'MP4 · H.264 video only') : 'MP4 · unavailable for this configuration'}</option>
        </select></label>
        <label><span>Quality target</span><select className="select-input" value={quality} onChange={(event) => onQualityChange(event.target.value as ExportQualityPreset)} disabled={isExporting}><option value="compact">Compact</option><option value="standard">Standard</option><option value="high">High</option></select></label>
        <label><span>Resolution</span><select className="select-input" value={resolution} onChange={(event) => onResolutionChange(event.target.value as ExportResolutionPreset)} disabled={isExporting}>
          <option value="sequence">Project canvas{sequence ? ` · ${sequence.width} × ${sequence.height}` : ''}</option>
          <option value="720p">{sequence ? exportResolutionLabel(sequence.width, sequence.height, '720p') : '720p'}</option>
          <option value="540p">{sequence ? exportResolutionLabel(sequence.width, sequence.height, '540p') : '540p'}</option>
          <option value="360p">{sequence ? exportResolutionLabel(sequence.width, sequence.height, '360p') : '360p'}</option>
        </select></label>
        <div className="export-readonly-field"><span>Frame rate</span><strong>{sequence ? formatFrameRate(sequence.frameRate.numerator / sequence.frameRate.denominator) : 'No sequence'}</strong><small>Uses the project frame rate to preserve frame indexing.</small></div>
      </div>
      <label className="export-filename-field"><span>Filename</span><div><input className="text-input" value={filename} onChange={(event) => onFilenameChange(event.target.value)} maxLength={150} disabled={isExporting} required /><b>.{container}</b></div></label>
      <div className="export-location-field"><div><strong>Save location</strong><span>{canChooseFolder ? folder ? `This device · ${folder.folderName}` : 'Choose a folder for this and future exports' : 'Browser download location (managed by browser settings)'}</span></div>{canChooseFolder && <button className="button button-secondary button-small" type="button" onClick={onChooseFolder} disabled={isExporting}><FolderOpen size={14} />{folder ? 'Change folder' : 'Choose folder'}</button>}</div>
      <div className="export-estimate-grid"><div><span>Sequence runtime</span><strong>{formatPlaybackTime(sequenceLength)}</strong></div><div><span>Estimated file size</span><strong>{formatFileSize(estimatedBytes)}</strong><small>Bitrate-based estimate; actual output varies.</small></div><div><span>Estimated render time</span><strong>{estimatedSeconds ? `~${formatPlaybackTime(estimatedSeconds)}` : 'Not available yet'}</strong><small>{estimatedSeconds ? 'Based on the last export on this device.' : 'A local estimate appears after the first export.'}</small></div><div><span>Output frame</span><strong>{dimensions ? `${dimensions.width} × ${dimensions.height}` : '—'}</strong><small>Canvas composition is preserved.</small></div></div>
      {!isExporting && exportUnavailableReason && <div className={`export-reason${missingMediaCount ? ' is-warning' : ''}`} role="status">{exportUnavailableReason}</div>}
      {container === 'mp4' && !capability.pending && !capability.supported && <div className="export-capability-detail" role="status">{capability.reason ?? 'This configuration cannot be encoded in the current browser environment. No format fallback will be selected.'}</div>}
      {saveError && <div className="export-reason is-warning" role="alert">{saveError}</div>}
      {isExporting && <div className="export-progress-block" role="status" aria-live="polite"><div><span>{isSaving ? 'Saving completed render…' : `Rendering ${formatName}`}</span><strong>{isSaving ? 'Saving' : `${progress}%`}</strong></div><progress max={100} value={isSaving ? 100 : progress} aria-label={isSaving ? 'Saving export file' : 'Export progress'} /></div>}
      {savedFile && <div className="export-saved-state" role="status"><Check size={16} /><span>Saved <strong>{savedFile.fileName}</strong> in {savedFile.folderName}.</span><button className="button button-secondary button-small" type="button" onClick={onOpenFolder}>Open folder</button></div>}
      {!canChooseFolder && <p className="export-browser-note">This browser download does not provide a programmatic “open folder” action. Use your browser’s download manager to locate the file.</p>}
      <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={isExporting ? onCancel : onClose} disabled={isSaving}>{isExporting ? (isSaving ? 'Saving file…' : 'Cancel export') : 'Close'}</button><button className={`button ${isExporting ? 'button-secondary export-cancel-button' : 'button-primary'}`} type="button" onClick={isExporting ? onCancel : onStart} disabled={exportDisabled || isSaving} title={isSaving ? 'The encoded file is being written to the selected folder.' : exportUnavailableReason ?? undefined}>{isExporting ? (isSaving ? 'Saving…' : 'Cancel render') : `Export ${container.toUpperCase()}`}</button></div>
    </section>
  </div>;
}

function SettingsDialog({
  initialTab, theme, onTheme, preferences, onPreferencesChange, project, projectDocument, onRenameProject,
  onApplyCanvas, onApplyFrameRate, storageRoot, storageIssue, onOpenStorageFolder, onCreateBackup, onRestoreBackup, onClearCache, onReset, onClose,
}: {
  initialTab: 'project' | 'editor' | 'audio' | 'export' | 'storage' | 'appearance' | 'shortcuts';
  theme: 'dark' | 'light';
  onTheme: (value: 'dark' | 'light') => void;
  preferences: EditorPreferences;
  onPreferencesChange: (update: (current: EditorPreferences) => EditorPreferences) => void;
  project: Project | null;
  projectDocument: ProjectDocument | null;
  onRenameProject: (name: string) => void;
  onApplyCanvas: (width: number, height: number, fit: NonNullable<Sequence['canvasFit']>, background: string) => void;
  onApplyFrameRate: (value: number) => void;
  storageRoot: string | null;
  storageIssue: string | null;
  onOpenStorageFolder: () => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onClearCache: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [projectName, setProjectName] = useState(project?.name ?? '');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLElement>(() => closeButtonRef.current);
  const sequence = projectDocument?.sequences.find((item) => item.id === projectDocument.projectSettings.defaultSequenceId) ?? null;
  const frameRates = [
    { value: 23.976, label: '23.976 fps (24000/1001)' }, { value: 24, label: '24 fps' }, { value: 25, label: '25 fps' },
    { value: 29.97, label: '29.97 fps (30000/1001)' }, { value: 30, label: '30 fps' }, { value: 50, label: '50 fps' },
    { value: 59.94, label: '59.94 fps (60000/1001)' }, { value: 60, label: '60 fps' },
  ];
  const updateEditor = (key: keyof EditorPreferences['editor'], value: boolean | number) => onPreferencesChange((current) => ({ ...current, editor: { ...current.editor, [key]: value } }));
  const updateAudio = (key: keyof EditorPreferences['audio'], value: boolean | number) => onPreferencesChange((current) => ({ ...current, audio: { ...current.audio, [key]: value } }));
  const updateExport = (key: keyof EditorPreferences['export'], value: string) => onPreferencesChange((current) => ({ ...current, export: { ...current.export, [key]: value } as EditorPreferences['export'] }));
  useEffect(() => { setProjectName(project?.name ?? ''); }, [project?.id, project?.name]);
  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'project', label: 'Project' }, { id: 'editor', label: 'Editor' }, { id: 'audio', label: 'Audio' },
    { id: 'export', label: 'Export' }, { id: 'storage', label: 'Storage' }, { id: 'appearance', label: 'Appearance' }, { id: 'shortcuts', label: 'Shortcuts' },
  ];

  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="dialog settings-dialog settings-dialog-large" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="dialog-head"><div className="dialog-icon"><Settings2 size={17} /></div><button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="Close settings"><X size={17} /></button></div>
      <div className="eyebrow">PREFERENCES · SAVED LOCALLY</div><h2 id="settings-title">Settings</h2>
      <div className="settings-layout">
        <nav className="settings-tabs" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
          {tabs.map((item) => <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </nav>
        <div className="settings-content">
          {tab === 'project' && <section id="settings-panel-project" role="tabpanel" aria-labelledby="settings-tab-project" className="settings-section">
            <h3>Current project</h3><p>Project settings are saved inside this project document. Canvas changes affect preview and export, not the application-wide preferences.</p>
            {project && sequence ? <>
              <form className="settings-project-name" onSubmit={(event) => { event.preventDefault(); if (projectName.trim()) onRenameProject(projectName.trim()); }}><label htmlFor="settings-project-name">Project name</label><div><input id="settings-project-name" className="text-input" value={projectName} maxLength={100} onChange={(event) => setProjectName(event.target.value)} /><button className="button button-secondary button-small" type="submit" disabled={!projectName.trim() || projectName.trim() === project.name}>Rename</button></div></form>
              <div className="settings-frame-rate"><label htmlFor="settings-project-fps">Project frame rate</label><select id="settings-project-fps" className="select-input" value={sequence.frameRate.numerator / sequence.frameRate.denominator} onChange={(event) => onApplyFrameRate(Number(event.target.value))}>{frameRates.map((rate) => <option key={rate.value} value={rate.value}>{rate.label}</option>)}</select><small>Changing frame rate preserves approximate sequence duration and frame-aligns clip positions.</small></div>
              <ProjectCanvasSettings sequence={sequence} onApply={onApplyCanvas} idPrefix="settings-canvas" />
              <div className="settings-info-row"><strong>Default still-image duration</strong><span>Coming soon · still-image timeline import is not available yet.</span></div>
            </> : <div className="settings-empty"><strong>No open project</strong><span>Open a project to edit its name, canvas, and frame rate.</span></div>}
          </section>}
          {tab === 'editor' && <section id="settings-panel-editor" role="tabpanel" aria-labelledby="settings-tab-editor" className="settings-section">
            <h3>Editor</h3><p>Timeline editing preferences take effect immediately.</p>
            <label className="settings-check-row"><span><strong>Snapping</strong><small>Snap clips to playhead and neighboring clip edges.</small></span><input type="checkbox" checked={preferences.editor.snapEnabled} onChange={(event) => updateEditor('snapEnabled', event.target.checked)} /></label>
            <label className="settings-range-row"><span><strong>Snap strength</strong><small>{preferences.editor.snapStrength} px · screen distance</small></span><input type="range" min="2" max="24" step="1" value={preferences.editor.snapStrength} onChange={(event) => updateEditor('snapStrength', Number(event.target.value))} /></label>
            <label className="settings-check-row"><span><strong>Ripple editing</strong><small>Shift following clips when moving, trimming, or deleting.</small></span><input type="checkbox" checked={preferences.editor.rippleMode} onChange={(event) => updateEditor('rippleMode', event.target.checked)} /></label>
            <label className="settings-check-row"><span><strong>Loop playback</strong><small>Restart playback at the end of the sequence.</small></span><input type="checkbox" checked={preferences.editor.playbackLoop} onChange={(event) => updateEditor('playbackLoop', event.target.checked)} /></label>
            <label className="settings-check-row"><span><strong>Show audio waveforms</strong><small>Show generated, session-only audio waveform peaks on timeline clips.</small></span><input type="checkbox" checked={preferences.editor.showWaveforms} onChange={(event) => updateEditor('showWaveforms', event.target.checked)} /></label>
            <label className="settings-select-row"><span><strong>Default timeline zoom</strong><small>Relative to Fit timeline.</small></span><select className="select-input" value={preferences.editor.zoomPercent} onChange={(event) => updateEditor('zoomPercent', Number(event.target.value))}><option value={50}>50%</option><option value={100}>100%</option><option value={150}>150%</option><option value={200}>200%</option></select></label>
            <div className="settings-info-row"><strong>Clip thumbnails</strong><span>Coming soon · current timeline uses labeled clips and does not generate frame thumbnails.</span></div>
          </section>}
          {tab === 'audio' && <section id="settings-panel-audio" role="tabpanel" aria-labelledby="settings-tab-audio" className="settings-section">
            <h3>Audio</h3><p>Preview volume applies to timeline playback. Track mute and gain remain project-level settings.</p>
            <label className="settings-range-row"><span><strong>Master preview volume</strong><small>{Math.round(preferences.audio.masterVolume * 100)}%</small></span><input type="range" min="0" max="1" step="0.05" value={preferences.audio.masterVolume} onChange={(event) => updateAudio('masterVolume', Number(event.target.value))} /></label>
            <label className="settings-check-row"><span><strong>Mute new audio tracks by default</strong><small>Applies only when adding new audio tracks.</small></span><input type="checkbox" checked={preferences.audio.defaultAudioMuted} onChange={(event) => updateAudio('defaultAudioMuted', event.target.checked)} /></label>
            <div className="settings-info-row"><strong>Default fades</strong><span>Coming soon · fade handles are not implemented, so no inactive control is shown.</span></div>
          </section>}
          {tab === 'export' && <section id="settings-panel-export" role="tabpanel" aria-labelledby="settings-tab-export" className="settings-section">
            <h3>Export defaults</h3><p>MP4 remains unavailable unless the selected H.264/AAC-LC encoder configuration passes its capability check.</p>
            <label className="settings-select-row"><span><strong>Default format</strong><small>Exact codec support is checked again for each sequence.</small></span><select className="select-input" value={preferences.export.container} onChange={(event) => updateExport('container', event.target.value)}><option value="webm">WebM · VP9 / Opus</option><option value="mp4">MP4 · H.264 / AAC-LC (when supported)</option></select></label>
            <label className="settings-select-row"><span><strong>Quality target</strong><small>Approximate bitrate preset, not a guaranteed visual quality.</small></span><select className="select-input" value={preferences.export.quality} onChange={(event) => updateExport('quality', event.target.value)}><option value="compact">Compact</option><option value="standard">Standard</option><option value="high">High</option></select></label>
            <label className="settings-select-row"><span><strong>Default resolution</strong><small>Project canvas is the default; alternate sizes preserve composition.</small></span><select className="select-input" value={preferences.export.resolution} onChange={(event) => updateExport('resolution', event.target.value)}><option value="sequence">Project canvas</option><option value="720p">720p</option><option value="540p">540p</option><option value="360p">360p</option></select></label>
            <div className="settings-info-row"><strong>Default save folder</strong><span>{window.clipwright?.exportFiles ? 'Native folder can be selected in the export dialog; the latest choice is remembered on this device.' : 'Browser download location, managed by browser settings.'}</span></div>
          </section>}
          {tab === 'storage' && <section id="settings-panel-storage" role="tabpanel" aria-labelledby="settings-tab-storage" className="settings-section">
            <h3>Autosave & storage</h3><p>Project manifests, managed media, settings, and caches stay in ClipWright’s per-user data directory. Managed copies do not modify the originals; linked media remains in its chosen location.</p>
            <label className="settings-select-row"><span><strong>Autosave after inactivity</strong><small>Debounce delay for edits before the validated project manifest is atomically saved.</small></span><select className="select-input" value={preferences.storage.autosaveIntervalSeconds} onChange={(event) => onPreferencesChange((current) => ({ ...current, storage: { ...current.storage, autosaveIntervalSeconds: Number(event.target.value) } }))}><option value={1}>1 second</option><option value={2}>2 seconds</option><option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option></select></label>
            <div className="settings-info-row"><strong>ClipWright data folder</strong><span>{storageRoot ?? (window.clipwright?.library ? 'Locating per-user app data…' : 'Browser build · local browser profile')}</span>{window.clipwright?.library && <button className="button button-secondary button-small" type="button" onClick={onOpenStorageFolder} disabled={!storageRoot}><FolderOpen size={13} />Open folder</button>}</div>
            {storageIssue && <div className="storage-recovery-warning" role="alert"><strong>Project library needs attention</strong><span>{storageIssue} Existing project files were not overwritten.</span></div>}
            <div className="settings-info-row"><strong>Project backups</strong><span>Backups contain the manifest and managed media. Linked media is listed separately unless you choose to collect it.</span><div className="storage-action-row"><button className="button button-secondary button-small" type="button" onClick={onCreateBackup} disabled={!project || !window.clipwright?.library}>Create project backup</button><button className="button button-secondary button-small" type="button" onClick={onRestoreBackup} disabled={!window.clipwright?.library}>Restore backup</button></div></div>
            <div className="settings-info-row"><strong>Temporary cache</strong><span>Cache cleanup is restricted to temporary cache content; projects, managed media, and completed exports are kept.</span><button className="button button-secondary button-small" type="button" onClick={onClearCache}>Clear temporary cache</button></div>
          </section>}
          {tab === 'appearance' && <section id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" className="settings-section">
            <h3>Appearance</h3><p>These options apply immediately and are stored in this browser profile.</p>
            <div className="settings-select-row"><span><strong>Theme</strong><small>Studio color scheme.</small></span><div className="theme-toggle"><button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}><Moon size={14} />Dark</button><button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}><Sun size={14} />Light</button></div></div>
            <label className="settings-select-row"><span><strong>Interface scale</strong><small>Applies to the full application window.</small></span><select className="select-input" value={preferences.appearance.uiScale} onChange={(event) => onPreferencesChange((current) => ({ ...current, appearance: { ...current.appearance, uiScale: Number(event.target.value) as EditorPreferences['appearance']['uiScale'] } }))}><option value={90}>90%</option><option value={100}>100%</option><option value={110}>110%</option><option value={125}>125%</option></select></label>
            <label className="settings-select-row"><span><strong>Accent color</strong><small>Selection and focus highlights.</small></span><select className="select-input" value={preferences.appearance.accent} onChange={(event) => onPreferencesChange((current) => ({ ...current, appearance: { ...current.appearance, accent: event.target.value as EditorPreferences['appearance']['accent'] } }))}><option value="orange">Orange</option><option value="blue">Blue</option><option value="violet">Violet</option></select></label>
            <div className="settings-info-row"><strong>Language</strong><span>English · additional languages are not included yet.</span></div>
          </section>}
          {tab === 'shortcuts' && <section id="settings-panel-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts" className="settings-section">
            <h3>Keyboard shortcuts</h3><p>Edit bindings as combinations such as <kbd>Ctrl+Z</kbd>, <kbd>Shift+Delete</kbd>, or single keys. Click an editor area before using a shortcut. Avoid assigning the same binding twice.</p>
            <div className="shortcut-edit-list">
              {([
                ['undo', 'Undo'], ['redo', 'Redo'], ['playPause', 'Play / pause'], ['split', 'Split at playhead'], ['snap', 'Toggle snapping'], ['copy', 'Copy clips'], ['paste', 'Paste clips'], ['duplicate', 'Duplicate clips'],
              ] as Array<[keyof EditorPreferences['shortcuts'], string]>).map(([key, label]) => <label key={key}><span>{label}</span><input className="text-input" value={preferences.shortcuts[key]} maxLength={24} onChange={(event) => onPreferencesChange((current) => ({ ...current, shortcuts: { ...current.shortcuts, [key]: event.target.value.trim() } }))} /></label>)}
            </div>
          </section>}
        </div>
      </div>
      <div className="settings-footer"><button className="button button-secondary button-small" type="button" onClick={onReset}>Reset defaults</button><span>Changes save automatically.</span><button className="button button-primary" type="button" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}

const EDITOR_TOUR_STEPS = [
  { selector: '[data-tour="media-bin"]', title: 'Project media', description: 'Import video and audio here. Managed assets are copied into the project library; linked assets stay at their original location.' },
  { selector: '[data-tour="preview"]', title: 'Preview', description: 'The preview follows the playhead and sequence canvas. Use the transport controls to review your edit.' },
  { selector: '[data-tour="timeline"]', title: 'Timeline', description: 'Drag media onto a compatible track, then select clips to move, trim, split, or remove them.' },
  { selector: '[data-tour="properties"]', title: 'Properties', description: 'Inspect the selected clip and adjust supported timing or audio settings. Export settings remain available from the Export action.' },
] as const;

function GuidedTour({ onClose }: { onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetUnavailable, setTargetUnavailable] = useState(false);
  const step = EDITOR_TOUR_STEPS[stepIndex];
  useEffect(() => {
    const target = document.querySelector<HTMLElement>(step.selector);
    if (!target) { setTargetUnavailable(true); return; }
    target.dataset.tourActive = 'true';
    target.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const bounds = target.getBoundingClientRect();
    setTargetUnavailable(bounds.width === 0 || bounds.height === 0);
    return () => { delete target.dataset.tourActive; };
  }, [step]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); finishTour(); } };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  function finishTour() {
    try { window.localStorage.setItem('clipwright.onboarding.tour-reviewed.v1', 'true'); }
    catch { /* The guided tour remains dismissible if profile storage is unavailable. */ }
    onClose();
  }
  return <aside className="guided-tour-card" aria-label="Guided editor tour" aria-live="polite">
    <div className="guided-tour-progress"><span>EDITOR TOUR · STEP {stepIndex + 1} OF {EDITOR_TOUR_STEPS.length}</span><button type="button" className="icon-button small" aria-label="Close guided tour" onClick={finishTour}><X size={14} /></button></div>
    <h2>{step.title}</h2><p>{targetUnavailable ? 'This area is hidden in the current layout. You can continue the tour or change the panel layout later.' : step.description}</p>
    <div className="guided-tour-actions"><button type="button" className="button button-ghost" onClick={finishTour}>Skip tour</button><span />{stepIndex > 0 && <button type="button" className="button button-secondary button-small" onClick={() => setStepIndex((current) => current - 1)}>Back</button>}{stepIndex < EDITOR_TOUR_STEPS.length - 1 ? <button type="button" className="button button-primary button-small" onClick={() => setStepIndex((current) => current + 1)}>Next</button> : <button type="button" className="button button-primary button-small" onClick={finishTour}>Finish</button>}</div>
  </aside>;
}

function HelpDialog({ onClose, canTour, onStartTour }: { onClose: () => void; canTour: boolean; onStartTour: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLElement>(() => closeButtonRef.current);
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="dialog help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div className="dialog-head"><div className="dialog-icon"><CircleHelp size={17} /></div><button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="Close help"><X size={17} /></button></div>
      <div className="eyebrow">QUICK REFERENCE</div><h2 id="help-title">Keyboard shortcuts</h2>
      <p className="dialog-copy">Shortcuts are available while editing. Focused controls keep their normal keyboard behavior.</p>
      <section className="help-getting-started" aria-labelledby="help-started-title">
        <div><h3 id="help-started-title">Getting started</h3><p>Create or open a project, import video or audio, drag a clip to its matching track, then preview and export. Image files can be stored in the media bin; image timeline clips are not available yet.</p></div>
        <button type="button" className="button button-secondary button-small" onClick={onStartTour} disabled={!canTour} title={!canTour ? 'Open a project in the Editor to start the tour.' : 'Tour the media bin, preview, timeline, and properties.'}>Start editor tour</button>
      </section>
      <div className="help-shortcut-grid">
        <section className="help-shortcut-group"><h3>Workspace</h3><dl>
          <div><dt>Command palette</dt><dd><kbd>Ctrl/Cmd</kbd><kbd>K</kbd></dd></div>
          <div><dt>New project</dt><dd><kbd>Ctrl/Cmd</kbd><kbd>N</kbd></dd></div>
          <div><dt>Save project (Editor)</dt><dd><kbd>Ctrl/Cmd</kbd><kbd>S</kbd></dd></div>
        </dl></section>
        <section className="help-shortcut-group"><h3>Timeline</h3><dl>
          <div><dt>Play or pause</dt><dd><kbd>Space</kbd></dd></div>
          <div><dt>Seek one frame</dt><dd><kbd>←</kbd><kbd>→</kbd></dd></div>
          <div><dt>Seek one second</dt><dd><kbd>Shift</kbd><kbd>←/→</kbd></dd></div>
          <div><dt>Split at playhead</dt><dd><kbd>S</kbd></dd></div>
          <div><dt>Delete / ripple delete</dt><dd><kbd>Delete</kbd><kbd>Shift+Delete</kbd></dd></div>
        </dl></section>
        <section className="help-shortcut-group"><h3>Editing</h3><dl>
          <div><dt>Undo / redo</dt><dd><kbd>Ctrl/Cmd+Z</kbd><kbd>Ctrl/Cmd+Shift+Z</kbd></dd></div>
          <div><dt>Copy / paste / duplicate</dt><dd><kbd>Ctrl/Cmd+C/V/D</kbd></dd></div>
          <div><dt>Toggle snapping</dt><dd><kbd>N</kbd></dd></div>
          <div><dt>Clip actions</dt><dd><kbd>Shift+F10</kbd><kbd>Context Menu</kbd></dd></div>
        </dl></section>
        <section className="help-shortcut-group"><h3>Trim controls</h3><dl>
          <div><dt>Adjust by frame</dt><dd><kbd>←</kbd><kbd>→</kbd></dd></div>
          <div><dt>Adjust by second</dt><dd><kbd>Shift+←/→</kbd><kbd>PageUp/Down</kbd></dd></div>
          <div><dt>Jump to trim limit</dt><dd><kbd>Home</kbd><kbd>End</kbd></dd></div>
        </dl></section>
      </div>
      <p className="help-disclaimer">Media remains local. Linked sources may need relinking if they move. Export format support is checked on this device, but source codecs and performance can vary.</p>
    </section>
  </div>;
}

type CommandAction = { label: string; shortcut?: string; icon: LucideIcon; run: () => void };
function CommandDialog({ actions, onClose, inputRef }: { actions: CommandAction[]; onClose: () => void; inputRef: React.RefObject<HTMLInputElement> }) {
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = actions.filter((action) => action.label.toLowerCase().includes(search.toLowerCase()));
  const dialogRef = useDialogFocusTrap<HTMLElement>(() => inputRef.current);
  useEffect(() => { setActiveIndex(0); }, [search]);
  return <div className="overlay command-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} tabIndex={-1} className="command-dialog" role="dialog" aria-modal="true" aria-label="Command palette"><div className="command-search"><Search size={17} /><input ref={inputRef} aria-label="Search commands" aria-autocomplete="list" aria-controls="command-options" aria-activedescendant={filtered[activeIndex] ? `command-option-${activeIndex}` : undefined} placeholder="Type a command…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (filtered.length) setActiveIndex((index) => (index + 1) % filtered.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); if (filtered.length) setActiveIndex((index) => index <= 0 ? filtered.length - 1 : index - 1); }
    if (event.key === 'Home' && filtered.length) { event.preventDefault(); setActiveIndex(0); }
    if (event.key === 'End' && filtered.length) { event.preventDefault(); setActiveIndex(filtered.length - 1); }
    if (event.key === 'Enter' && filtered[activeIndex]) filtered[activeIndex].run();
  }} /><kbd>ESC</kbd><button onClick={onClose} aria-label="Close command palette"><X size={15} /></button></div><div id="command-options" className="command-list" role="listbox" aria-label="Available commands">{filtered.map((action, index) => { const Icon = action.icon; return <button key={action.label} id={`command-option-${index}`} role="option" aria-selected={activeIndex === index} className={`command-item ${activeIndex === index ? 'is-highlighted' : ''}`} onMouseEnter={() => setActiveIndex(index)} onClick={action.run}><Icon size={16} /><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>; })}{filtered.length === 0 && <div className="command-empty">No matching commands</div>}</div><div className="command-footer"><span><Keyboard size={13} />↑ ↓ to navigate · Home/End to jump · Enter to run</span><span>CLIPWRIGHT STUDIO</span></div></section></div>;
}

function TaskDrawer({ onClose }: { onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useDialogFocusTrap<HTMLElement>(() => closeButtonRef.current);
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={drawerRef} tabIndex={-1} className="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title"><div className="drawer-head"><div><div className="eyebrow">BACKGROUND WORK</div><h2 id="task-drawer-title">Task centre</h2></div><button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="Close task centre"><X size={17} /></button></div><div className="task-empty"><div className="empty-icon"><Clock3 size={20} /></div><h3>No active tasks</h3><p>Imports, renders, and analysis jobs will be listed here when those systems are available.</p><span className="task-disclaimer">No background processing is running.</span></div><div className="drawer-bottom"><span className="status-dot" />Tasks run only when you start them</div></aside></div>;
}
