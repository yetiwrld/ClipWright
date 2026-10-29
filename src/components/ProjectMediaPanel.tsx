import {
  ChevronLeft, ChevronRight, Film, FolderOpen, HardDrive, Image as ImageIcon, Plus, Volume2,
} from 'lucide-react';
import type { MediaAsset } from '../lib/projectDocument';

type SessionMediaSource = { url: string; name: string; blob?: Blob };
export type MediaImportMode = 'managed' | 'linked';

export interface ProjectMediaPanelProps {
  assets: MediaAsset[];
  projectId: string | null;
  selectedMediaKey: string | null;
  sessionSources: Record<string, SessionMediaSource>;
  collapsed: boolean;
  isReadingMedia: boolean;
  hasPersistentLibrary: boolean;
  mediaImportMode: MediaImportMode;
  onToggleCollapsed: () => void;
  onImportVideo: () => void;
  onImportAudio: () => void;
  onImportImage: () => void;
  onRelinkVideo: (assetId: string) => void;
  onRelinkAudio: (assetId: string) => void;
  onRelinkImage: (assetId: string) => void;
  onSelectMedia: (key: string) => void;
  onRevealMedia: (assetId: string) => void;
  onMediaImportModeChange: (mode: MediaImportMode) => void;
  onDragSourceChange: (assetId: string | null) => void;
}

const mediaKey = (projectId: string, assetId: string) => JSON.stringify([projectId, assetId]);

export default function ProjectMediaPanel({
  assets, projectId, selectedMediaKey, sessionSources, collapsed, isReadingMedia, hasPersistentLibrary, mediaImportMode,
  onToggleCollapsed, onImportVideo, onImportAudio, onImportImage, onRelinkVideo, onRelinkAudio, onRelinkImage,
  onSelectMedia, onRevealMedia, onMediaImportModeChange, onDragSourceChange,
}: ProjectMediaPanelProps) {
  const projectAvailable = Boolean(projectId);
  return <aside className={`editor-media-panel${collapsed ? ' is-collapsed' : ''}`} aria-label="Project media" data-tour="media-bin" aria-busy={isReadingMedia}>
    <div className="panel-title">
      {!collapsed && <span>Project media</span>}
      <div className="panel-title-tools">
        <button className="icon-button small" type="button" title={collapsed ? 'Expand media panel' : 'Collapse media panel'} aria-label={collapsed ? 'Expand media panel' : 'Collapse media panel'} aria-expanded={!collapsed} onClick={onToggleCollapsed}>{collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>
        {!collapsed && <button className="icon-button small" type="button" title="Import a local video" aria-label="Import a local video" onClick={onImportVideo} disabled={isReadingMedia || !projectAvailable}><Plus size={16} /></button>}
        {!collapsed && <button className="icon-button small" type="button" title="Import a local audio file" aria-label="Import a local audio file" onClick={onImportAudio} disabled={isReadingMedia || !projectAvailable}><Volume2 size={14} /></button>}
        {!collapsed && <button className="icon-button small" type="button" title="Import a local image" aria-label="Import a local image" onClick={onImportImage} disabled={isReadingMedia || !projectAvailable}><ImageIcon size={14} /></button>}
      </div>
    </div>
    {!collapsed && <>
      <label className="media-storage-mode"><span>New media storage</span><select className="select-input" aria-label="New media storage mode" value={mediaImportMode} onChange={(event) => onMediaImportModeChange(event.target.value as MediaImportMode)}><option value="managed" disabled={!hasPersistentLibrary}>Managed copy · stays with project</option><option value="linked">{hasPersistentLibrary ? 'Link external original' : 'Session only · browser'}</option></select></label>
      {isReadingMedia && <div className="media-reading-status" role="status" aria-live="polite">Reading local media metadata…</div>}
      {assets.length ? <div className="media-asset-list" aria-label="Media assets">
        {assets.map((asset) => {
          const key = projectId ? mediaKey(projectId, asset.id) : '';
          const source = sessionSources[key];
          const available = Boolean(source);
          const supported = asset.kind === 'image' || Boolean(asset.streams[asset.kind === 'audio' ? 'audio' : 'video']);
          const storageLabel = asset.pathKind === 'project-relative' ? 'Managed copy' : asset.pathKind === 'absolute' ? 'Linked original' : 'Session only';
          return <div className={`media-asset-row ${key === selectedMediaKey ? 'is-selected' : ''}`} key={asset.id}>
            <button className="media-asset-select" type="button" aria-pressed={key === selectedMediaKey} onClick={() => onSelectMedia(key)} disabled={!projectAvailable} title={asset.name} draggable={supported} onDragStart={(event) => {
              onDragSourceChange(asset.id);
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('application/x-clipwright-source', asset.id);
              event.dataTransfer.setData('text/plain', asset.id);
            }} onDragEnd={() => onDragSourceChange(null)}>
              {asset.kind === 'image' && available ? <img className="media-asset-thumbnail" src={source?.url} alt="" /> : asset.kind === 'audio' ? <Volume2 size={15} /> : asset.kind === 'image' ? <ImageIcon size={15} /> : <Film size={15} />}
              <span className="media-asset-copy"><strong>{asset.name}</strong><small>{storageLabel} · {asset.kind === 'image' ? (!available ? 'Relink required' : `${asset.imageDimensions?.width ?? 'Image'} × ${asset.imageDimensions?.height ?? ''} · library item`) : supported ? (!available ? 'Relink required' : `Drag to a ${asset.kind} track`) : `${asset.kind} · library item`}</small></span>
            </button>
            {asset.pathKind === 'project-relative' && available && <button className="icon-button small media-reveal" type="button" aria-label={`Reveal ${asset.name} in File Explorer`} title="Reveal managed copy in File Explorer" onClick={() => onRevealMedia(asset.id)}><FolderOpen size={14} /></button>}
            {asset.kind === 'video' && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkVideo(asset.id)} disabled={isReadingMedia}>Relink</button>}
            {asset.kind === 'audio' && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkAudio(asset.id)} disabled={isReadingMedia}>Relink</button>}
            {asset.kind === 'image' && !available && <button className="button button-secondary button-small media-relink" type="button" onClick={() => onRelinkImage(asset.id)} disabled={isReadingMedia}>Relink</button>}
          </div>;
        })}
        <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportVideo} disabled={isReadingMedia || !projectAvailable}><Plus size={13} />Add video</button>
        <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportAudio} disabled={isReadingMedia || !projectAvailable}><Plus size={13} />Add audio</button>
        <button className="button button-secondary button-small media-add-button" type="button" onClick={onImportImage} disabled={isReadingMedia || !projectAvailable}><Plus size={13} />Add image</button>
      </div> : <div className="media-empty">
        <div className="media-icon"><Film size={20} /></div><strong>No media imported</strong><span>Choose local video, audio, or image files. Original files are not modified.</span><div className="media-empty-actions"><button className="button button-secondary button-small" onClick={onImportVideo} disabled={isReadingMedia || !projectAvailable}><Plus size={14} />Import video</button><button className="button button-secondary button-small" onClick={onImportAudio} disabled={isReadingMedia || !projectAvailable}><Plus size={14} />Import audio</button><button className="button button-secondary button-small" onClick={onImportImage} disabled={isReadingMedia || !projectAvailable}><Plus size={14} />Import image</button></div>
      </div>}
      {isReadingMedia && <div className="media-reading" role="status">Reading metadata in your browser…</div>}
      <div className="panel-footnote"><HardDrive size={12} />Managed media is copied into this project; linked originals stay in place.</div>
    </>}
  </aside>;
}
