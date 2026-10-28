const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isTrustedRendererUrl, resolveLocalAssetPath } = require('./security.cjs');

const distDirectory = path.resolve('/tmp/clipwright-dist');

test('maps app root and in-bundle assets to the renderer build', () => {
  assert.equal(resolveLocalAssetPath('app://clipwright/', distDirectory), path.join(distDirectory, 'index.html'));
  assert.equal(resolveLocalAssetPath('app://clipwright/assets/app.js?v=1', distDirectory), path.join(distDirectory, 'assets', 'app.js'));
});

test('rejects non-app hosts, malformed URLs, and paths escaping the renderer build', () => {
  assert.equal(resolveLocalAssetPath('https://example.com/index.html', distDirectory), null);
  assert.equal(resolveLocalAssetPath('app://other/index.html', distDirectory), null);
  assert.equal(resolveLocalAssetPath('app://clipwright/%2f..%2f..%2fsecret', distDirectory), null);
  assert.equal(resolveLocalAssetPath('not a URL', distDirectory), null);
});

test('accepts only the local app origin for packaged navigation', () => {
  assert.equal(isTrustedRendererUrl('app://clipwright/index.html'), true);
  assert.equal(isTrustedRendererUrl('app://other/index.html'), false);
  assert.equal(isTrustedRendererUrl('https://example.com/'), false);
});

test('restricts development navigation to the configured Vite origin', () => {
  const options = { devServerOrigin: 'http://127.0.0.1:5174' };
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/', options), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/another-route', options), true);
  assert.equal(isTrustedRendererUrl('http://localhost:5174/', options), false);
  assert.equal(isTrustedRendererUrl('https://example.com/', options), false);
});
