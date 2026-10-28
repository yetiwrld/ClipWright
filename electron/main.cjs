const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isTrustedRendererUrl, resolveLocalAssetPath } = require('./security.cjs');

const APP_SCHEME = 'app';
const APP_HOST = 'clipwright';
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');
const smokeTest = process.env.CLIPWRIGHT_SMOKE_TEST === '1';
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg; codecs=opus'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

function getDevServerUrl() {
  const value = process.env.CLIPWRIGHT_RENDERER_URL;
  if (!value) return null;

  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5174' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('CLIPWRIGHT_RENDERER_URL must point to the local ClipWright Vite server on port 5174.');
  }
  return url.toString();
}

const devServerUrl = app.isPackaged ? null : getDevServerUrl();
const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : null;

function response(body, status, headers = {}) {
  return new Response(body, { status, headers });
}

async function handleAppRequest(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return response('Method not allowed', 405, { Allow: 'GET, HEAD' });

  const filePath = resolveLocalAssetPath(request.url, DIST_DIR, APP_SCHEME, APP_HOST);
  if (!filePath) return response('Not found', 404);

  try {
    const data = await fs.readFile(filePath);
    const headers = {
      'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    return response(request.method === 'HEAD' ? null : data, 200, headers);
  } catch (error) {
    if (error && error.code === 'ENOENT') return response('Not found', 404);
    console.error('Failed to serve a local application asset:', error);
    return response('Internal server error', 500);
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-info', (event) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url, { devServerOrigin, scheme: APP_SCHEME, host: APP_HOST })) {
      throw new Error('Untrusted renderer');
    }
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    };
  });
}

function runRendererSmokeCheck(window) {
  const deadline = Date.now() + 20_000;
  let finished = false;
  const check = async () => {
    if (finished) return;
    if (window.isDestroyed()) {
      finished = true;
      console.error('Desktop smoke test failed: renderer window closed before it became ready.');
      app.exit(1);
      return;
    }

    try {
      const state = await window.webContents.executeJavaScript(`(async () => {
        const info = await window.clipwright?.app.getInfo();
        return {
          title: document.title,
          mounted: Boolean(document.querySelector('#root')?.firstElementChild),
          info,
        };
      })()`);
      if (state.title === 'ClipWright Studio' && state.mounted && state.info?.name && state.info?.platform) {
        finished = true;
        console.log(`Desktop smoke test passed: ${state.title} rendered; preload IPC responded on ${state.info.platform}.`);
        app.exit(0);
        return;
      }
    } catch (error) {
      console.error('Desktop smoke test could not inspect the renderer:', error);
    }

    if (Date.now() >= deadline) {
      finished = true;
      console.error('Desktop smoke test failed: renderer did not mount and answer the preload IPC check within 20 seconds.');
      app.exit(1);
      return;
    }
    setTimeout(check, 200);
  };
  check();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#171615',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });

  window.once('ready-to-show', () => { if (!smokeTest) window.show(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, { devServerOrigin, scheme: APP_SCHEME, host: APP_HOST })) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (smokeTest && isMainFrame) {
      console.error(`Desktop smoke test failed loading ${validatedURL}: ${errorDescription} (${errorCode}).`);
      app.exit(1);
    }
  });
  window.webContents.on('did-finish-load', () => { if (smokeTest) runRendererSmokeCheck(window); });

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  }
  return window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    if (!devServerUrl) await protocol.handle(APP_SCHEME, handleAppRequest);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerIpcHandlers();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('ClipWright desktop startup failed:', error);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
