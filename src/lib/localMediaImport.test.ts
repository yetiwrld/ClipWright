import { describe, expect, it } from 'vitest';
import { prepareLocalMediaFile } from './localMediaImport';

function localFile(name: string, type = 'application/octet-stream', size = 128): File {
  return { name, type, size } as File;
}

describe('local media import preflight', () => {
  it('normalizes path-like filenames and strips unsafe characters', () => {
    expect(prepareLocalMediaFile(localFile('../cut:final?.mp4', 'video/mp4'), 'video')).toBe('cut-final-.mp4');
  });

  it('rejects empty files and media-kind mismatches before probing', () => {
    expect(() => prepareLocalMediaFile(localFile('silent.wav', 'audio/wav', 0), 'audio')).toThrow('file is empty');
    expect(() => prepareLocalMediaFile(localFile('music.mp3', 'video/mp4'), 'audio')).toThrow('identified as video');
    expect(() => prepareLocalMediaFile(localFile('scene.mp4', 'audio/aac'), 'video')).toThrow('identified as audio');
    expect(() => prepareLocalMediaFile(localFile('notes.txt', 'text/plain'), 'audio')).toThrow('Choose an audio file');
  });

  it('allows browser-generic MIME types when a recognized extension is present', () => {
    expect(prepareLocalMediaFile(localFile('voice.m4a'), 'audio')).toBe('voice.m4a');
    expect(prepareLocalMediaFile(localFile('camera.mov'), 'video')).toBe('camera.mov');
  });
});
