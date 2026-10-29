const path = require('node:path');

function resolveLocalAssetPath(rawUrl, distDirectory, scheme = 'app', host = 'clipwright') {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${scheme}:` || url.hostname !== host) return null;
    const requestPath = decodeURIComponent(url.pathname);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const root = path.resolve(distDirectory);
    const candidate = path.resolve(root, relativePath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function isTrustedRendererUrl(candidate, { devServerOrigin = null, scheme = 'app', host = 'clipwright' } = {}) {
  try {
    const url = new URL(candidate);
    if (devServerOrigin) return url.origin === devServerOrigin;
    return url.protocol === `${scheme}:` && url.hostname === host;
  } catch {
    return false;
  }
}

module.exports = { isTrustedRendererUrl, resolveLocalAssetPath };
