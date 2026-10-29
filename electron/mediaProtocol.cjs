const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');

const MEDIA_SCHEME = 'clipwright-media';
const MEDIA_HOST = 'asset';
const MEDIA_MIME_TYPES = new Map([
  ['.aac', 'audio/aac'], ['.aif', 'audio/aiff'], ['.aiff', 'audio/aiff'], ['.flac', 'audio/flac'], ['.m4a', 'audio/mp4'],
  ['.mkv', 'video/x-matroska'], ['.mov', 'video/quicktime'], ['.mp3', 'audio/mpeg'], ['.mp4', 'video/mp4'], ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg; codecs=opus'], ['.png', 'image/png'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'], ['.webm', 'video/webm'],
  ['.wav', 'audio/wav'], ['.weba', 'audio/webm'], ['.webp', 'image/webp'], ['.wmv', 'video/x-ms-wmv'], ['.avi', 'video/x-msvideo'],
]);

function registerMediaUrl(filePath, webContentsId, handles = new Map()) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !Number.isSafeInteger(webContentsId)) throw new Error('A local media capability requires an absolute file path and renderer id.');
  const token = crypto.randomUUID();
  handles.set(token, { filePath: path.resolve(filePath), webContentsId });
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${token}`;
}

function clearMediaUrls(webContentsId, handles = new Map()) {
  let removed = 0;
  for (const [token, handle] of handles) {
    if (handle.webContentsId === webContentsId) { handles.delete(token); removed += 1; }
  }
  return removed;
}

async function resolveMediaAssets({ assets, resolveAsset, registerUrl }) {
  const results = [];
  for (const asset of assets) {
    const resolved = await resolveAsset(asset);
    results.push(resolved.available
      ? { assetId: asset.id, available: true, mediaUrl: registerUrl(resolved.filePath), sizeBytes: resolved.sizeBytes }
      : { assetId: asset.id, available: false, reason: resolved.reason });
  }
  return results;
}

function parseRange(value, size) {
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  let start; let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

function mediaProtocolHandler(handles = new Map(), { trustedOrigin = 'app://clipwright' } = {}) {
  return async function handleMediaRequest(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (typeof request.initiatorOrigin !== 'string' || request.initiatorOrigin !== trustedOrigin) return new Response('Not found', { status: 404 });
    let token;
    try {
      const url = new URL(request.url);
      if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== MEDIA_HOST || url.search || url.hash || !/^\/[0-9a-f-]{36}$/i.test(url.pathname)) return new Response('Not found', { status: 404 });
      token = url.pathname.slice(1);
    } catch { return new Response('Not found', { status: 404 }); }
    const handle = handles.get(token);
    if (!handle) return new Response('Not found', { status: 404 });
    try {
      const stat = await fs.stat(handle.filePath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const headers = {
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': trustedOrigin,
        'Cache-Control': 'private, max-age=60',
        'Content-Type': MEDIA_MIME_TYPES.get(path.extname(handle.filePath).toLowerCase()) || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      };
      const rangeHeader = request.headers.get('range');
      const range = parseRange(rangeHeader, stat.size);
      if (range?.invalid) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
      if (range) {
        const length = range.end - range.start + 1;
        headers['Content-Length'] = String(length);
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
        if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
        const stream = createReadStream(handle.filePath, { start: range.start, end: range.end });
        return new Response(Readable.toWeb(stream), { status: 206, headers });
      }
      headers['Content-Length'] = String(stat.size);
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(Readable.toWeb(createReadStream(handle.filePath)), { status: 200, headers });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) return new Response('Media unavailable', { status: 404 });
      console.error('Local media protocol request failed:', error);
      return new Response('Internal server error', { status: 500 });
    }
  };
}

module.exports = { MEDIA_HOST, MEDIA_SCHEME, clearMediaUrls, mediaProtocolHandler, parseRange, registerMediaUrl, resolveMediaAssets };
