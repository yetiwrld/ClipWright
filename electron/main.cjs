const { app, BrowserWindow, dialog, ipcMain, protocol, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isTrustedRendererUrl, resolveLocalAssetPath } = require('./security.cjs');
const {
  listRecoveryPoints,
  parseProjectEnvelope,
  readProjectFile,
  readRecoveryPoint,
  writeProjectFile,
} = require('./projectFiles.cjs');

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

const projectFileHandles = new Map();

function assertTrustedIpcSender(event) {
  if (event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url, { devServerOrigin, scheme: APP_SCHEME, host: APP_HOST })) {
    throw new Error('Untrusted renderer');
  }
}

function getWindowForSender(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) throw new Error('The editor window is no longer available.');
  return window;
}

function recoveryRoot() {
  return path.join(app.getPath('userData'), 'project-recovery');
}

function safeProjectFilename(name) {
  const safeName = String(name || 'ClipWright project')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim() || 'ClipWright project';
  return /\.cwproject$/i.test(safeName) ? safeName : `${safeName}.cwproject`;
}

function registerProjectHandle(event, filePath, projectId, contentHash) {
  const handle = crypto.randomUUID();
  projectFileHandles.set(handle, { filePath, projectId, contentHash, webContentsId: event.sender.id });
  event.sender.once('destroyed', () => projectFileHandles.delete(handle));
  return handle;
}

function getProjectHandle(event, handle) {
  assertTrustedIpcSender(event);
  const linkedFile = typeof handle === 'string' ? projectFileHandles.get(handle) : null;
  if (!linkedFile || linkedFile.webContentsId !== event.sender.id) throw new Error('This project file is no longer linked. Use Save As to choose a file.');
  return linkedFile;
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-info', (event) => {
    assertTrustedIpcSender(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    };
  });

  ipcMain.handle('project-files:open', async (event) => {
    assertTrustedIpcSender(event);
    const result = await dialog.showOpenDialog(getWindowForSender(event), {
      title: 'Open ClipWright project',
      properties: ['openFile'],
      filters: [{ name: 'ClipWright project', extensions: ['cwproject'] }, { name: 'JSON project', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    const project = await readProjectFile(filePath);
    const handle = registerProjectHandle(event, filePath, project.documentId, project.contentHash);
    return { canceled: false, handle, fileName: path.basename(filePath), contents: project.contents, documentId: project.documentId };
  });

  ipcMain.handle('project-files:save-as', async (event, payload) => {
    assertTrustedIpcSender(event);
    if (!payload || typeof payload.contents !== 'string') throw new Error('Project contents are required.');
    const document = parseProjectEnvelope(payload.contents);
    const result = await dialog.showSaveDialog(getWindowForSender(event), {
      title: 'Save ClipWright project',
      defaultPath: safeProjectFilename(payload.suggestedName || document.metadata.name),
      filters: [{ name: 'ClipWright project', extensions: ['cwproject'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const filePath = /\.cwproject$/i.test(result.filePath) ? result.filePath : `${result.filePath}.cwproject`;
    const saved = await writeProjectFile({ filePath, contents: payload.contents, recoveryRoot: recoveryRoot(), expectedId: document.id });
    const handle = registerProjectHandle(event, filePath, saved.documentId, saved.contentHash);
    const { contentHash, ...publicSaved } = saved;
    return { canceled: false, handle, fileName: path.basename(filePath), ...publicSaved };
  });

  ipcMain.handle('project-files:save', async (event, payload) => {
    if (!payload || typeof payload.contents !== 'string') throw new Error('Project contents are required.');
    const linkedFile = getProjectHandle(event, payload.handle);
    const saved = await writeProjectFile({
      filePath: linkedFile.filePath,
      contents: payload.contents,
      recoveryRoot: recoveryRoot(),
      expectedId: linkedFile.projectId,
      expectedCurrentId: linkedFile.projectId,
      expectedCurrentHash: linkedFile.contentHash,
    });
    linkedFile.contentHash = saved.contentHash;
    const { contentHash, ...publicSaved } = saved;
    return { ...publicSaved, fileName: path.basename(linkedFile.filePath) };
  });

  ipcMain.handle('project-files:list-recovery', (event, handle) => {
    const linkedFile = getProjectHandle(event, handle);
    return listRecoveryPoints({ filePath: linkedFile.filePath, recoveryRoot: recoveryRoot() });
  });

  ipcMain.handle('project-files:read-recovery', (event, payload) => {
    if (!payload || typeof payload.recoveryId !== 'string') throw new Error('Recovery checkpoint id is required.');
    const linkedFile = getProjectHandle(event, payload.handle);
    return readRecoveryPoint({
      filePath: linkedFile.filePath,
      recoveryRoot: recoveryRoot(),
      recoveryId: payload.recoveryId,
      expectedId: linkedFile.projectId,
    });
  });
}

async function writeSmokeReport(report) {
  const reportPath = process.env.CLIPWRIGHT_SMOKE_REPORT_PATH;
  if (process.env.CLIPWRIGHT_SMOKE_TEST !== '1' || !reportPath) return;
  try {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('Desktop smoke test could not write its diagnostic report:', error);
  }
}

async function writeSmokeArtifacts(artifacts) {
  const artifactDirectory = process.env.CLIPWRIGHT_SMOKE_ARTIFACT_DIR;
  if (process.env.CLIPWRIGHT_SMOKE_TEST !== '1' || !artifactDirectory || !artifacts || typeof artifacts !== 'object') return;
  try {
    await fs.mkdir(artifactDirectory, { recursive: true });
    for (const [name, base64] of Object.entries(artifacts)) {
      if (!/^[a-z0-9][a-z0-9.-]{0,100}$/i.test(name) || typeof base64 !== 'string') throw new Error(`Invalid synthetic smoke artifact: ${name}`);
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0 || bytes.length > 100 * 1024 * 1024) throw new Error(`Synthetic smoke artifact has an invalid size: ${name}`);
      await fs.writeFile(path.join(artifactDirectory, name), bytes);
    }
  } catch (error) {
    console.error('Desktop smoke test could not write its media artifacts:', error);
  }
}

function reportWithoutArtifacts(measurements) {
  if (!measurements || typeof measurements !== 'object') return measurements;
  const { artifacts: _artifacts, ...report } = measurements;
  return report;
}

function runRendererSmokeCheck(window) {
  const deadline = Date.now() + 150_000;
  let finished = false;
  let exportSmokeStarted = false;
  let stage = 'checking renderer mount and preload IPC';
  let smokeMeasurements = null;
  const check = async () => {
    if (finished) return;
    if (window.isDestroyed()) {
      finished = true;
      const error = 'Renderer window closed before it became ready.';
      await writeSmokeReport({ pass: false, stage, error });
      console.error('Desktop smoke test failed:', error);
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
        if (!exportSmokeStarted) {
          exportSmokeStarted = true;
          stage = 'running deterministic WebM export and frame-identity smoke';
          const smokePayload = await Promise.race([
            window.webContents.executeJavaScript(`import('./export-smoke.js').then(async ({ runDeterministicWebmSmoke }) => {
              const result = await runDeterministicWebmSmoke((stage) => { window.__clipwrightSmokeStage = stage; });
              return JSON.stringify(result);
            })`),
            new Promise((_, reject) => setTimeout(async () => {
              let currentStage = 'smoke progress was not reported';
              try { currentStage = await window.webContents.executeJavaScript('window.__clipwrightSmokeStage ?? "smoke progress was not reported"'); } catch { /* Preserve the timeout if renderer diagnostics are unavailable. */ }
              reject(new Error(`Deterministic WebM export smoke timed out after 120 seconds; last stage: ${currentStage}`));
            }, 120_000)),
          ]);
          smokeMeasurements = typeof smokePayload === 'string' ? JSON.parse(smokePayload) : smokePayload;
          await writeSmokeArtifacts(smokeMeasurements?.artifacts);
          const report = reportWithoutArtifacts(smokeMeasurements);
          await writeSmokeReport(report);
          if (!report?.pass) throw new Error(`Deterministic WebM export smoke failed: ${JSON.stringify(report)}`);
          finished = true;
          console.log(`Desktop smoke test passed: ${state.title} rendered; preload IPC responded on ${state.info.platform}; deterministic WebM measurements: ${JSON.stringify(report)}`);
          app.exit(0);
          return;
        }
      }
    } catch (error) {
      finished = true;
      const message = error instanceof Error ? error.message : String(error);
      await writeSmokeArtifacts(smokeMeasurements?.artifacts);
      const report = smokeMeasurements && typeof smokeMeasurements === 'object'
        ? { ...reportWithoutArtifacts(smokeMeasurements), pass: false, stage, error: message }
        : { pass: false, stage, error: message, stack: error instanceof Error ? error.stack : undefined };
      await writeSmokeReport(report);
      console.error('Desktop smoke test failed:', error);
      app.exit(1);
      return;
    }

    if (Date.now() >= deadline) {
      finished = true;
      const error = 'Renderer mount, preload IPC, and deterministic export check did not complete within 150 seconds.';
      await writeSmokeReport({ pass: false, stage, error });
      console.error('Desktop smoke test failed:', error);
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
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    for (const [handle, linkedFile] of projectFileHandles) {
      if (linkedFile.webContentsId === window.webContents.id) projectFileHandles.delete(handle);
    }
  });
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
