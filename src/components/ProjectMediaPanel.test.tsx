import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProjectMediaPanel from './ProjectMediaPanel';
import type { MediaAsset } from '../lib/projectDocument';

describe('ProjectMediaPanel', () => {
  it('renders still-image availability and routes select, relink, import, storage, and drag actions', () => {
    const availableImage: MediaAsset = {
      id: 'image-available', name: 'cover.png', sourcePath: 'Media/cover.png', pathKind: 'project-relative', kind: 'image',
      streams: {}, imageDimensions: { width: 1600, height: 900 },
    };
    const offlineImage: MediaAsset = {
      id: 'image-offline', name: 'ending.webp', sourcePath: 'Media/ending.webp', pathKind: 'project-relative', kind: 'image',
      streams: {}, imageDimensions: { width: 1280, height: 720 },
    };
    const onSelectMedia = vi.fn();
    const onRelinkImage = vi.fn();
    const onImportImage = vi.fn();
    const onMediaImportModeChange = vi.fn();
    const onDragSourceChange = vi.fn();
    const panel = render(<ProjectMediaPanel
      assets={[availableImage, offlineImage]}
      projectId="project-1"
      selectedMediaKey={JSON.stringify(['project-1', availableImage.id])}
      sessionSources={{ [JSON.stringify(['project-1', availableImage.id])]: { url: 'blob:cover', name: 'cover.png' } }}
      collapsed={false}
      isReadingMedia={false}
      hasPersistentLibrary
      mediaImportMode="managed"
      onToggleCollapsed={vi.fn()}
      onImportVideo={vi.fn()}
      onImportAudio={vi.fn()}
      onImportImage={onImportImage}
      onRelinkVideo={vi.fn()}
      onRelinkAudio={vi.fn()}
      onRelinkImage={onRelinkImage}
      onSelectMedia={onSelectMedia}
      onRevealMedia={vi.fn()}
      onMediaImportModeChange={onMediaImportModeChange}
      onDragSourceChange={onDragSourceChange}
    />);

    const availableRow = panel.container.querySelector<HTMLButtonElement>('.media-asset-select[title="cover.png"]');
    expect(availableRow).toBeTruthy();
    expect(availableRow!.querySelector('img')?.getAttribute('src')).toBe('blob:cover');
    expect(availableRow!.getAttribute('draggable')).toBe('true');
    expect(availableRow!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(availableRow!);
    expect(onSelectMedia).toHaveBeenCalledWith(JSON.stringify(['project-1', availableImage.id]));

    fireEvent.click(screen.getAllByRole('button', { name: 'Relink' })[0]);
    expect(onRelinkImage).toHaveBeenCalledWith(offlineImage.id);
    fireEvent.click(screen.getByRole('button', { name: /Add image/ }));
    expect(onImportImage).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'New media storage mode' }), { target: { value: 'linked' } });
    expect(onMediaImportModeChange).toHaveBeenCalledWith('linked');

    const setData = vi.fn();
    fireEvent.dragStart(availableRow!, { dataTransfer: { setData, effectAllowed: 'none' } });
    expect(onDragSourceChange).toHaveBeenCalledWith(availableImage.id);
    expect(setData).toHaveBeenCalledWith('application/x-clipwright-source', availableImage.id);
    expect(setData).toHaveBeenCalledWith('text/plain', availableImage.id);
    fireEvent.dragEnd(availableRow!);
    expect(onDragSourceChange).toHaveBeenLastCalledWith(null);
    expect(panel.container.querySelector('[aria-label="Project media"]')).toBeTruthy();
  });
});
