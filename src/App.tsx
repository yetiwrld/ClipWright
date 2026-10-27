import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowLeft, ArrowRight, Check, ChevronDown,
  CircleHelp, Clapperboard, Clock3, Command, FilePlus2, Film, FolderOpen,
  Grid2X2, HardDrive, Heart, Home, Keyboard, LayoutPanelLeft, ListFilter,
  MoreHorizontal, Plus, Search, Settings2, Sparkles, Sun, Moon, Trash2,
  X, type LucideIcon,
} from 'lucide-react';
import { createProject, PROJECTS_KEY, readProjectStore, writeProjects } from './lib/projects';
import type { AspectRatio, Project } from './lib/projects';

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

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>('home');
  const [initialProjectStore] = useState(() => readProjectStore(window.localStorage));
  const [projects, setProjects] = useState<Project[]>(initialProjectStore.projects);
  const [storageWarning, setStorageWarning] = useState(initialProjectStore.issue);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => window.localStorage.getItem('clipwright.theme') === 'light' ? 'light' : 'dark');
  const searchRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
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
    try { window.localStorage.setItem('clipwright.theme', theme); }
    catch { /* Theme remains usable for this session even if browser storage is blocked. */ }
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setShowCommands((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault(); setShowCreate(true);
      }
      if (event.key === 'Escape') {
        setShowCreate(false); setShowSettings(false); setShowCommands(false); setShowTasks(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function notify(message: string, kind: Toast['kind'] = 'success') {
    const id = Date.now();
    setToast({ id, message, kind });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 3200);
  }

  function createNewProject(name: string, ratio: AspectRatio, fps: Project['frameRate']) {
    if (storageWarning) {
      notify('Resolve the project-list storage warning before creating a project.', 'error');
      return;
    }
    try {
      const project = createProject(name, ratio, fps);
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

  function openProject(project: Project) {
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, updatedAt: new Date().toISOString() } : item));
    setActiveProjectId(project.id);
    setWorkspace('editor');
  }

  function updateProject(id: string, patch: Partial<Project>) {
    setProjects((current) => current.map((project) => project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project));
  }

  function duplicateProject(project: Project) {
    const copy = { ...project, id: crypto.randomUUID(), name: `${project.name} copy`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), favorite: false, archived: false };
    setProjects((current) => [copy, ...current]);
    notify('Project entry duplicated. Source media is not copied.');
  }

  function deleteProject(project: Project) {
    const confirmed = window.confirm(`Delete “${project.name}” from this project list? This removes only its local project entry; it does not delete source media.`);
    if (!confirmed) return;
    setProjects((current) => current.filter((item) => item.id !== project.id));
    if (activeProjectId === project.id) { setActiveProjectId(null); setWorkspace('home'); }
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
          <div className="head-status"><span className={`status-dot ${storageWarning ? 'status-warning' : ''}`} />{storageWarning ? 'Storage needs attention' : 'All changes saved locally'}</div>
        </div>

        <main className="content-area">
          {workspace === 'home' && (
            <section className="dashboard-view">
              <div className="welcome-row">
                <div><div className="eyebrow">YOUR CREATIVE WORKSPACE</div><h1>Projects</h1><p className="page-description">Pick up where you left off, or start something new.</p></div>
                <button className="button button-primary" onClick={() => setShowCreate(true)}><Plus size={17} />New project</button>
              </div>
              {storageWarning && <div className="storage-warning" role="alert"><div><strong>{storageWarning === 'invalid-data' ? 'Project list could not be read' : 'Browser storage is unavailable'}</strong><p>{storageWarning === 'invalid-data' ? 'The existing data has not been overwritten. You can preserve a recovery copy before starting a fresh list.' : 'This browser profile cannot currently read local storage, so project entries cannot be saved.'}</p></div>{storageWarning === 'invalid-data' && <button className="button button-secondary button-small" onClick={startFreshProjectList}>Preserve & start fresh</button>}</div>}
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
                    if (name?.trim()) { updateProject(project.id, { name: name.trim() }); notify('Project renamed.'); }
                  }} onDuplicate={() => duplicateProject(project)} onArchive={() => { updateProject(project.id, { archived: !project.archived }); notify(project.archived ? 'Project restored.' : 'Project archived.'); }} onFavorite={() => updateProject(project.id, { favorite: !project.favorite })} onDelete={() => deleteProject(project)} />)}
                </div>
              ) : query ? (
                <div className="empty-state compact-empty"><div className="empty-icon"><Search size={20} /></div><h2>No projects found</h2><p>Try another search term or clear the search.</p><button className="button button-secondary" onClick={() => setQuery('')}>Clear search</button></div>
              ) : showArchived ? (
                <div className="empty-state compact-empty"><div className="empty-icon"><Archive size={20} /></div><h2>No archived projects</h2><p>Archived project entries will appear here. Source media is never removed by archiving.</p></div>
              ) : (
                <div className="empty-state">
                  <div className="empty-art"><div className="art-window"><div className="art-topline" /><div className="art-preview"><Film size={28} strokeWidth={1.2} /></div><div className="art-timeline"><i /><i /><i /></div></div><span className="art-spark spark-one" /><span className="art-spark spark-two" /></div>
                  <div className="eyebrow">A CLEAR START</div><h2>Make room for your next story.</h2><p>Create a project to begin. Your workspace stays on this device, and your original media remains untouched.</p>
                  <button className="button button-primary" onClick={() => setShowCreate(true)}><Plus size={17} />Create your first project</button>
                  <span className="empty-footnote"><HardDrive size={13} />Project list stored in this browser profile</span>
                </div>
              )}
              <div className="dashboard-footer"><div><span className="footer-label">WORKSPACE</span><strong>Local-first</strong><span> · Your files stay on this device</span></div><button onClick={() => setShowSettings(true)}>Preferences <ArrowRight size={13} /></button></div>
            </section>
          )}

          {workspace === 'editor' && <EditorFoundation project={activeProject} onBack={() => navigate('home')} onImportUnavailable={() => notify('Media import is the next implementation milestone; no files have been changed.', 'error')} />}
          {workspace === 'clipping' && <ClippingFoundation onCreate={() => setShowCreate(true)} />}
        </main>
      </div>

      {showCreate && <CreateProjectDialog onClose={() => setShowCreate(false)} onCreate={createNewProject} />}
      {showSettings && <SettingsDialog theme={theme} onTheme={setTheme} onClose={() => setShowSettings(false)} />}
      {showCommands && <CommandDialog inputRef={searchRef} onClose={() => setShowCommands(false)} actions={[
        { label: 'Create a new project', shortcut: 'Ctrl+N', icon: FilePlus2, run: () => { setShowCommands(false); setShowCreate(true); } },
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

function ProjectCard({ project, index, onOpen, onRename, onDuplicate, onArchive, onFavorite, onDelete }: { project: Project; index: number; onOpen: () => void; onRename: () => void; onDuplicate: () => void; onArchive: () => void; onFavorite: () => void; onDelete: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <article className="project-card" style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}>
    <button className={`project-thumb thumb-${index % 4}`} onClick={onOpen} aria-label={`Open ${project.name}`}>
      <span className="thumb-frame"><Film size={24} strokeWidth={1.25} /></span><span className="thumb-empty">No media yet</span>
      <span className="aspect-pill">{project.aspectRatio}</span>
    </button>
    <div className="project-card-info">
      <div className="project-name-row"><button className="project-name" onClick={onOpen}>{project.name}</button>{project.favorite && <Heart size={13} fill="currentColor" className="favorite-mark" />}</div>
      <div className="project-meta">Edited {readableDate(project.updatedAt)} <span>·</span> {project.frameRate} fps</div>
    </div>
    <button className="card-menu-trigger" aria-label={`More actions for ${project.name}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
    {menuOpen && <><button className="click-away" aria-label="Close project menu" onClick={() => setMenuOpen(false)} /><div className="project-menu">
      <button onClick={() => { onOpen(); setMenuOpen(false); }}><FolderOpen size={14} />Open project</button>
      <button onClick={() => { onRename(); setMenuOpen(false); }}><FilePlus2 size={14} />Rename</button>
      <button onClick={() => { onDuplicate(); setMenuOpen(false); }}><Grid2X2 size={14} />Duplicate entry</button>
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

function EditorFoundation({ project, onBack, onImportUnavailable }: { project: Project | null; onBack: () => void; onImportUnavailable: () => void }) {
  return <section className="editor-foundation">
    <div className="editor-project-bar"><div><div className="eyebrow">EDITOR WORKSPACE</div><h1>{project?.name ?? 'No project selected'}</h1></div><div className="project-specs"><span>{project?.aspectRatio ?? '—'}</span><span>{project ? `${project.frameRate} fps` : 'No sequence'}</span><span className="save-pill"><Check size={12} />Saved locally</span></div></div>
    <div className="editor-layout">
      <aside className="editor-media-panel"><div className="panel-title"><span>Project media</span><button className="icon-button small" title="Import media (not available yet)" onClick={onImportUnavailable}><Plus size={16} /></button></div><div className="media-empty"><div className="media-icon"><Film size={20} /></div><strong>No media imported</strong><span>Media import and metadata inspection are not implemented in this foundation build.</span><button className="button button-secondary button-small" onClick={onImportUnavailable}><Plus size={14} />Import media</button></div><div className="panel-footnote"><HardDrive size={12} />Original files are never modified</div></aside>
      <div className="editor-center"><div className="preview-stage"><div className="preview-frame"><div className="preview-corner tl"/><div className="preview-corner tr"/><div className="preview-corner bl"/><div className="preview-corner br"/><Film size={35} strokeWidth={1.15} /><span>Preview will appear when media is imported</span><small>Sequence {project?.aspectRatio ?? '16:9'} · {project?.frameRate ?? 30} fps</small></div></div><div className="preview-controls"><button className="transport-button" disabled title="No media loaded"><ArrowLeft size={15} /></button><button className="play-button" disabled aria-label="Play"><span /></button><button className="transport-button" disabled title="No media loaded"><ArrowRight size={15} /></button><span className="time-readout">00:00:00:00 <i>/</i> 00:00:00:00</span><span className="preview-quality">Balanced <ChevronDown size={12} /></span></div><div className="timeline-panel"><div className="timeline-heading"><div><span className="panel-kicker">TIMELINE</span><span className="timeline-sequence">Sequence 01</span></div><div className="timeline-tools"><button disabled title="Split clip unavailable"><Keyboard size={14} /></button><button disabled title="Fit timeline unavailable"><LayoutPanelLeft size={14} /></button></div></div><div className="timeline-ruler"><span>00:00</span><span>00:10</span><span>00:20</span><span>00:30</span><span>00:40</span><span>00:50</span></div><div className="track-row"><span className="track-name">V1</span><div className="track-space"><div className="empty-track"><span>Add video to start editing</span><Plus size={14} /></div></div></div><div className="track-row audio-track"><span className="track-name">A1</span><div className="track-space"><div className="empty-audio"><span>Audio track</span></div></div></div><div className="timeline-note">Timeline editing, playback, and export are upcoming milestones.</div></div></div>
      <aside className="properties-panel"><div className="panel-title">Properties</div><div className="properties-empty"><Settings2 size={20} /><strong>Nothing selected</strong><span>Select a clip in the timeline to view its properties.</span></div><div className="properties-divider"/><div className="property-section"><span className="panel-kicker">SEQUENCE</span><div className="property-line"><span>Aspect ratio</span><strong>{project?.aspectRatio ?? '16:9'}</strong></div><div className="property-line"><span>Frame rate</span><strong>{project?.frameRate ?? 30} fps</strong></div><div className="property-line"><span>Resolution</span><strong>1920 × 1080</strong></div><small>Sequence settings are saved with this project entry.</small></div></aside>
    </div>
    <button className="subtle-back" onClick={onBack}><ArrowLeft size={14} />Back to projects</button>
  </section>;
}

function ClippingFoundation({ onCreate }: { onCreate: () => void }) {
  return <section className="clipping-view"><div className="clipping-heading"><div><div className="eyebrow">AI-ASSISTED WORKFLOW</div><h1>Find the moments worth keeping.</h1><p>Turn long recordings into focused clips — with you in control of every cut.</p></div><div className="clipping-mark"><Sparkles size={23} /></div></div><div className="clipping-notice"><span className="notice-indicator" /><div><strong>Analysis is not available yet</strong><p>This build does not include a transcription model or highlight-analysis provider. Your media will not be uploaded or analyzed.</p></div><span className="planned-tag">FOUNDATION</span></div><div className="clipping-steps"><div className="step-card"><span className="step-number">01</span><div className="step-icon"><FolderOpen size={19} /></div><h3>Add your source</h3><p>Choose a local video and review its media details.</p><span className="step-state">Not available yet</span></div><div className="step-connector" /><div className="step-card"><span className="step-number">02</span><div className="step-icon"><Sparkles size={19} /></div><h3>Review moments</h3><p>Check transcript-backed suggestions and why they were selected.</p><span className="step-state">Provider required</span></div><div className="step-connector" /><div className="step-card"><span className="step-number">03</span><div className="step-icon"><Clapperboard size={19} /></div><h3>Edit & export</h3><p>Refine the cut in the editor before creating your final export.</p><span className="step-state">Upcoming</span></div></div><div className="clipping-footer"><div><span className="footer-label">DESIGNED FOR PRIVACY</span><strong>Local-first, by default</strong><span> Cloud processing will always require explicit consent.</span></div><button className="button button-secondary" onClick={onCreate}><Plus size={15} />Create a project</button></div></section>;
}

function SettingsDialog({ theme, onTheme, onClose }: { theme: 'dark' | 'light'; onTheme: (value: 'dark' | 'light') => void; onClose: () => void }) {
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-head"><div className="dialog-icon"><Settings2 size={17} /></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={17} /></button></div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">Settings</h2><p className="dialog-copy">Adjust this workspace. Preferences are saved on this device.</p><div className="setting-row"><div><strong>Appearance</strong><span>Choose a theme for the studio.</span></div><div className="theme-toggle"><button className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}><Moon size={14} />Dark</button><button className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}><Sun size={14} />Light</button></div></div><div className="setting-row"><div><strong>Storage model</strong><span>Project-list metadata in browser local storage</span></div><span className="setting-value">Local</span></div><div className="setting-row"><div><strong>Application version</strong><span>Foundation build · 0.1.0</span></div><span className="setting-value">Early access</span></div><div className="settings-disclaimer">A Windows desktop shell, managed project files, autosave, and recovery are not included in this first increment.</div><div className="dialog-actions"><button className="button button-primary" onClick={onClose}>Done</button></div></section></div>;
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
