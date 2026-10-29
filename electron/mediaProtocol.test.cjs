const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { clearMediaUrls, mediaProtocolHandler, parseRange, registerMediaUrl } = require('./mediaProtocol.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipwright-media-protocol-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parses normal, open-ended, and suffix byte ranges and rejects invalid ranges', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=10-11', 10), { invalid: true });
  assert.deepEqual(parseRange('bytes=0-1,3-4', 10), { invalid: true });
});

test('serves only opaque registered assets, supports range streaming, and revokes by renderer', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'video ü.mp4');
  await fs.writeFile(file, '0123456789');
  const handles = new Map();
  const url = registerMediaUrl(file, 19, handles);
  const handler = mediaProtocolHandler(handles);
  const response = await handler(new Request(url, { headers: { Range: 'bytes=2-5' }, method: 'GET' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await response.text(), '2345');
  const wrongRenderer = await handler(Object.assign(new Request(url), { webContentsId: 20 }));
  assert.equal(wrongRenderer.status, 404);
  assert.equal((await handler(new Request('clipwright-media://asset/unknown'))).status, 404);
  assert.equal(clearMediaUrls(20, handles), 0);
  assert.equal(clearMediaUrls(19, handles), 1);
  assert.equal((await handler(new Request(url))).status, 404);
});
