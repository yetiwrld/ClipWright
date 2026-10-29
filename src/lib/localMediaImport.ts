export type LocalMediaKind = 'video' | 'audio' | 'image';

const VIDEO_EXTENSIONS = /\.(3gp|avi|m2ts|mkv|mov|mp4|m4v|mpeg|mpg|mts|ogv|webm|wmv)$/i;
const AUDIO_EXTENSIONS = /\.(aac|aif|aiff|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i;
const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|heic|heif|jpeg|jpg|png|tif|tiff|webp)$/i;

/** Validates the selected local file and returns a safe, bounded display name. */
export function prepareLocalMediaFile(file: File, kind: LocalMediaKind): string {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error(`The selected ${kind} file is empty.`);
  }
  const originalName = (typeof file.name === 'string' ? file.name : '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const hasExpectedExtension = (kind === 'video' ? VIDEO_EXTENSIONS : kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS).test(originalName);
  const mime = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (kind === 'image') {
    if (mime.startsWith('audio/') || mime.startsWith('video/')) throw new Error('This file is not identified as an image.');
    if (!mime.startsWith('image/') && mime !== 'application/octet-stream' && !hasExpectedExtension) throw new Error('Choose an image file to import or relink.');
  } else if (kind === 'audio') {
    if (mime.startsWith('video/')) throw new Error('This file is identified as video; choose an audio file instead.');
    if (!mime.startsWith('audio/') && mime !== 'application/octet-stream' && !hasExpectedExtension) {
      throw new Error('Choose an audio file to import or relink.');
    }
  } else {
    if (mime.startsWith('audio/')) throw new Error('This file is identified as audio; choose a video file instead.');
    if (mime && !mime.startsWith('video/') && mime !== 'application/octet-stream' && !hasExpectedExtension) {
      throw new Error('Choose a video file to import or relink.');
    }
  }
  const safeName = originalName.replace(/[<>:"|?*]/g, '-').replace(/[\x00-\x1f]/g, '-').slice(0, 200).trim();
  return safeName || (kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image');
}
