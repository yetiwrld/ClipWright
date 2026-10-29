const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { clearMediaUrls, mediaProtocolHandler, parseRange, registerMediaUrl, resolveMediaAssets } = require('./mediaProtocol.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipwright-media-protocol-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('uses only the configured development renderer origin for CORS and request access', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'source.webm');
  await fs.writeFile(file, 'video');
  const handles = new Map();
  const url = registerMediaUrl(file, 7, handles);
  const origin = 'http://127.0.0.1:5174';
  const handler = mediaProtocolHandler(handles, { trustedOrigin: origin });
  const trusted = Object.assign(new Request(url), { initiatorOrigin: origin });
  const response = await handler(trusted);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const packagedOrigin = Object.assign(new Request(url), { initiatorOrigin: 'app://clipwright' });
  assert.equal((await handler(packagedOrigin)).status, 404);
});

test('does not register media URLs for unavailable assets returned by library resolution', async () => {
  let registrations = 0;
  const results = await resolveMediaAssets({
    assets: [{ id: 'asset-no-fingerprint' }],
    resolveAsset: async () => ({ available: false, reason: 'The linked media has no fingerprint; relink it to confirm the file.' }),
    registerUrl: () => { registrations += 1; return 'unexpected-media-url'; },
  });
  assert.deepEqual(results, [{ assetId: 'asset-no-fingerprint', available: false, reason: 'The linked media has no fingerprint; relink it to confirm the file.' }]);
  assert.equal(registrations, 0);
});

test('parses normal, open-ended, and suffix byte ranges and rejects invalid ranges', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=10-11', 10), { invalid: true });
  assert.deepEqual(parseRange('bytes=0-1,3-4', 10), { invalid: true });
});

test('serves only trusted renderer requests, supports range streaming, and revokes by renderer', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'video ü.mp4');
  await fs.writeFile(file, '0123456789');
  const handles = new Map();
  const url = registerMediaUrl(file, 19, handles);
  const handler = mediaProtocolHandler(handles, { trustedOrigin: 'app://clipwright' });
  const trustedRequest = (requestUrl, init = {}) => Object.assign(new Request(requestUrl, init), { initiatorOrigin: 'app://clipwright' });
  const response = await handler(trustedRequest(url, { headers: { Range: 'bytes=2-5' }, method: 'GET' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('access-control-allow-origin'), 'app://clipwright');
  assert.equal(await response.text(), '2345');
  const untrustedOrigin = Object.assign(new Request(url), { initiatorOrigin: 'https://attacker.example' });
  assert.equal((await handler(untrustedOrigin)).status, 404);
  assert.equal((await handler(trustedRequest('clipwright-media://asset/unknown'))).status, 404);
  assert.equal(clearMediaUrls(20, handles), 0);
  assert.equal(clearMediaUrls(19, handles), 1);
  assert.equal((await handler(trustedRequest(url))).status, 404);
});
