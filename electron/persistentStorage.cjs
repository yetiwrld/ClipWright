const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { parseProjectEnvelope, readProjectFile, writeProjectFile } = require('./projectFiles.cjs');

const ROOT_DIRECTORIES = ['Projects', 'Exports', 'Thumbnails', 'Cache', 'Diagnostics', 'Settings'];
const MANIFEST_NAME = 'project.cwproject';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

function applicationDataRoot(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('Electron userData path must be an absolute per-user path.');
  return path.join(userDataPath, 'ClipWright Studio');
}

function projectFolderName(projectId) {
  if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId)) throw new Error('Project id is invalid.');
  return crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 32);
}

function projectDirectory(root, projectId) {
  return path.join(path.resolve(root), 'Projects', projectFolderName(projectId));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeBaseName(name) {
  const normalized = path.basename(String(name || 'media')).normalize('NFC');
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'media';
}

async function ensureDirectoryIsReal(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Storage directory is not a real directory: ${directory}`);
}

async function ensureStorageLayout(root) {
  const resolved = path.resolve(root);
  await ensureDirectoryIsReal(resolved);
  for (const name of ROOT_DIRECTORIES) await ensureDirectoryIsReal(path.join(resolved, name));
  return { root: resolved, directories: Object.fromEntries(ROOT_DIRECTORIES.map((name) => [name, path.join(resolved, name)])) };
}

async function hashFile(filePath) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function inspectRegularFile(filePath) {
  const resolved = path.resolve(filePath);
  const info = await fs.stat(resolved);
  if (!info.isFile()) throw new Error('The selected media source is not a regular file.');
  if (info.size <= 0) throw new Error('The selected media source is empty.');
  return { filePath: resolved, sizeBytes: info.size, modifiedAt: info.mtimeMs };
}

async function importMedia({ root, projectId, assetId, sourcePath, mode }) {
  if (!ID_PATTERN.test(String(assetId ?? ''))) throw new Error('Media asset id is invalid.');
  if (!['managed', 'linked'].includes(mode)) throw new Error('Media import mode must be managed or linked.');
  const source = await inspectRegularFile(sourcePath);
  const fingerprint = await hashFile(source.filePath);
  if (mode === 'linked') return {
    mode,
    name: path.basename(source.filePath),
    sourcePath: source.filePath,
    pathKind: 'absolute',
    fileSizeBytes: source.sizeBytes,
    fingerprint,
  };

  await ensureStorageLayout(root);
  const folder = projectDirectory(root, projectId);
  const mediaDirectory = path.join(folder, 'Media');
  await ensureDirectoryIsReal(folder);
  await ensureDirectoryIsReal(mediaDirectory);
  const name = safeBaseName(path.basename(source.filePath));
  const extension = path.extname(name).slice(0, 20);
  const storedName = `${fingerprint.slice(0, 32)}${extension}`;
  const destinationPath = path.join(mediaDirectory, storedName);
  const relativePath = path.posix.join('Media', storedName);
  let existing;
  try { existing = await fs.stat(destinationPath); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isFile() || existing.size !== source.sizeBytes || await hashFile(destinationPath) !== fingerprint) {
      throw new Error('A managed media filename collision was detected; the existing asset was left untouched.');
    }
    return { mode, name, sourcePath: relativePath, pathKind: 'project-relative', fileSizeBytes: source.sizeBytes, fingerprint, deduplicated: true };
  }

  const temporaryPath = path.join(mediaDirectory, `.${crypto.randomUUID()}.copying`);
  try {
    await pipeline(createReadStream(source.filePath), createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    const copiedInfo = await fs.stat(temporaryPath);
    const copiedFingerprint = await hashFile(temporaryPath);
    const sourceAfterCopy = await fs.stat(source.filePath);
    if (copiedInfo.size !== source.sizeBytes || copiedFingerprint !== fingerprint || sourceAfterCopy.size !== source.sizeBytes || sourceAfterCopy.mtimeMs !== source.modifiedAt) {
      throw new Error('The source changed while it was being copied. No managed asset was registered.');
    }
    try { await fs.link(temporaryPath, destinationPath); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const duplicate = await fs.stat(destinationPath);
      if (!duplicate.isFile() || duplicate.size !== source.sizeBytes || await hashFile(destinationPath) !== fingerprint) throw new Error('A managed media filename collision was detected; the existing asset was left untouched.');
    }
    const finalInfo = await fs.stat(destinationPath);
    if (!finalInfo.isFile() || finalInfo.size !== source.sizeBytes || await hashFile(destinationPath) !== fingerprint) {
      await fs.unlink(destinationPath).catch(() => undefined);
      throw new Error('The managed copy failed verification and was not registered.');
    }
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
  return { mode, name, sourcePath: relativePath, pathKind: 'project-relative', fileSizeBytes: source.sizeBytes, fingerprint, deduplicated: false };
}

async function resolveAssetPath({ root, projectId, asset }) {
  if (!asset || typeof asset !== 'object' || typeof asset.sourcePath !== 'string') throw new Error('Media asset reference is invalid.');
  let filePath;
  if (asset.pathKind === 'absolute') {
    if (!path.isAbsolute(asset.sourcePath)) throw new Error('Linked media path is not absolute.');
    filePath = path.resolve(asset.sourcePath);
  } else if (asset.pathKind === 'project-relative') {
    if (path.isAbsolute(asset.sourcePath) || asset.sourcePath.includes('\0')) throw new Error('Managed media path must be project-relative.');
    const folder = projectDirectory(root, projectId);
    const mediaRoot = path.join(folder, 'Media');
    filePath = path.resolve(folder, asset.sourcePath);
    if (!isWithin(mediaRoot, filePath) || filePath === mediaRoot) throw new Error('Managed media path escapes the project media directory.');
    try {
      for (const directory of [path.resolve(root), path.join(path.resolve(root), 'Projects'), folder, mediaRoot]) {
        const directoryStat = await fs.lstat(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Managed media directory is not a safe real directory.');
      }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENODEV'].includes(error?.code)) return { available: false, reason: 'The media source is missing or inaccessible.' };
      throw error;
    }
    try {
      const realMediaRoot = await fs.realpath(mediaRoot);
      const realFilePath = await fs.realpath(filePath);
      if (!isWithin(realMediaRoot, realFilePath) || realFilePath === realMediaRoot) throw new Error('Managed media path escapes the real project media directory.');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENODEV'].includes(error?.code)) return { available: false, reason: 'The media source is missing or inaccessible.' };
      throw error;
    }
  } else {
    return { available: false, reason: 'This media reference exists only for a browser session.' };
  }
  try {
    if (asset.pathKind === 'project-relative') {
      const entryStat = await fs.lstat(filePath);
      if (entryStat.isSymbolicLink()) return { available: false, reason: 'Managed media cannot be a symbolic link.' };
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { available: false, reason: 'The media source is not a regular file.' };
    if (asset.fileSizeBytes !== undefined && stat.size !== asset.fileSizeBytes) return { available: false, reason: 'The media file size changed; confirm the replacement by relinking.' };
    if (asset.pathKind === 'absolute' && typeof asset.fingerprint === 'string' && await hashFile(filePath) !== asset.fingerprint) return { available: false, reason: 'The linked source contents changed; confirm the replacement by relinking.' };
    return { available: true, filePath, sizeBytes: stat.size };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENODEV'].includes(error?.code)) return { available: false, reason: 'The media source is missing or inaccessible.' };
    throw error;
  }
}

const projectSaveQueues = new Map();

async function writeLibraryProject({ root, contents, expectedCurrentHash }) {
  const document = parseProjectEnvelope(contents, { allowLegacy: true });
  await ensureStorageLayout(root);
  const folder = projectDirectory(root, document.id);
  await ensureDirectoryIsReal(folder);
  await ensureDirectoryIsReal(path.join(folder, 'Media'));
  const filePath = path.join(folder, MANIFEST_NAME);
  const result = await writeProjectFile({
    filePath,
    contents,
    recoveryRoot: path.join(root, 'Diagnostics', 'Project recovery'),
    expectedId: document.id,
    expectedCurrentId: document.id,
    expectedCurrentHash,
  });
  return { ...result, filePath, projectId: document.id, folder };
}

async function saveLibraryProject(options) {
  const document = parseProjectEnvelope(options?.contents, { allowLegacy: true });
  const key = path.join(projectDirectory(options.root, document.id), MANIFEST_NAME);
  const previous = projectSaveQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => writeLibraryProject(options));
  projectSaveQueues.set(key, operation);
  try { return await operation; }
  finally { if (projectSaveQueues.get(key) === operation) projectSaveQueues.delete(key); }
}

async function assertNoSymlinks(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error('Storage operations do not accept symbolic links.');
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(directory)) await assertNoSymlinks(path.join(directory, entry));
  } else if (!stat.isFile()) throw new Error('Storage operations accept only regular files and directories.');
}

async function cloneLibraryProject({ root, sourceProjectId, contents }) {
  const document = parseProjectEnvelope(contents, { allowLegacy: true });
  if (document.id === sourceProjectId) throw new Error('A project copy must have a new identity.');
  await ensureStorageLayout(root);
  const sourceFolder = projectDirectory(root, sourceProjectId);
  const destinationFolder = projectDirectory(root, document.id);
  const sourceFolderStat = await fs.lstat(sourceFolder);
  if (sourceFolderStat.isSymbolicLink() || !sourceFolderStat.isDirectory()) throw new Error('The source project folder is not safe to copy.');
  try { await fs.lstat(destinationFolder); throw new Error('A project with this identity already exists.'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await fs.mkdir(destinationFolder, { recursive: false, mode: 0o700 });
  try {
    const sourceMedia = path.join(sourceFolder, 'Media');
    const destinationMedia = path.join(destinationFolder, 'Media');
    const sourceMediaStat = await fs.lstat(sourceMedia).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (sourceMediaStat) {
      if (!sourceMediaStat.isDirectory() || sourceMediaStat.isSymbolicLink()) throw new Error('The source managed-media folder is not safe to copy.');
      await assertNoSymlinks(sourceMedia);
      await fs.cp(sourceMedia, destinationMedia, { recursive: true, errorOnExist: true, force: false, dereference: false });
    } else await fs.mkdir(destinationMedia, { recursive: true, mode: 0o700 });
    const saved = await saveLibraryProject({ root, contents });
    return { projectId: document.id, contentHash: saved.contentHash };
  } catch (error) {
    await fs.rm(destinationFolder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function archiveLibraryProject({ root, projectId }) {
  const key = path.join(projectDirectory(root, projectId), MANIFEST_NAME);
  const pending = projectSaveQueues.get(key);
  if (pending) await pending.catch(() => undefined);
  const manifest = path.join(projectDirectory(root, projectId), MANIFEST_NAME);
  try { await fs.lstat(manifest); }
  catch (error) { if (error?.code === 'ENOENT') return { archived: false, mediaPreserved: true }; throw error; }
  const trash = path.join(path.resolve(root), 'Diagnostics', 'Project trash');
  await fs.mkdir(trash, { recursive: true, mode: 0o700 });
  const archivedPath = path.join(trash, `${projectFolderName(projectId)}-${Date.now()}-${crypto.randomUUID()}.cwproject`);
  await fs.rename(manifest, archivedPath);
  return { archived: true, mediaPreserved: true };
}

async function listLibraryProjects(root) {
  const directory = path.join(path.resolve(root), 'Projects');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return { projects: [], issues: [] }; throw error; }
  const projects = [];
  const issues = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name, MANIFEST_NAME);
    try {
      const manifestStat = await fs.lstat(filePath);
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('Project manifest is not a regular file.');
      const project = await readProjectFile(filePath);
      projects.push({ ...project, fileName: path.basename(filePath), projectDirectory: path.dirname(filePath) });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      issues.push({ directoryId: entry.name, message: error instanceof Error ? error.message : 'Project manifest could not be read.' });
    }
  }
  projects.sort((a, b) => b.documentId.localeCompare(a.documentId));
  return { projects, issues };
}

async function createProjectBackup({ root, projectId, destinationDirectory, includeLinked = false }) {
  if (typeof destinationDirectory !== 'string' || !path.isAbsolute(destinationDirectory)) throw new Error('Backup destination must be an absolute path.');
  const sourceProjectDirectory = projectDirectory(root, projectId);
  const sourceManifest = path.join(sourceProjectDirectory, MANIFEST_NAME);
  const manifestStat = await fs.lstat(sourceManifest);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('Project manifest is not a regular file.');
  const { contents } = await readProjectFile(sourceManifest);
  const document = parseProjectEnvelope(contents, { allowLegacy: true, expectedId: projectId });
  await fs.mkdir(destinationDirectory, { recursive: true });
  const baseName = safeBaseName(document.metadata?.name || 'ClipWright project').replace(/\.[^.]+$/, '') || 'ClipWright project';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath = path.join(destinationDirectory, `${baseName}-${stamp}`);
  let suffix = 1;
  while (true) {
    try { await fs.lstat(backupPath); backupPath = path.join(destinationDirectory, `${baseName}-${stamp}-${suffix++}`); }
    catch (error) { if (error?.code === 'ENOENT') break; throw error; }
  }
  const temporaryPath = path.join(destinationDirectory, `.${path.basename(backupPath)}-${crypto.randomUUID()}.tmp`);
  await fs.mkdir(temporaryPath, { recursive: false, mode: 0o700 });
  try {
    const mediaDirectory = path.join(temporaryPath, 'Media');
    await fs.mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
    const copied = new Map();
    const externalNotCollected = [];
    for (const asset of document.assets ?? []) {
      if (asset.pathKind === 'browser-session') {
        externalNotCollected.push({ assetId: asset.id, name: asset.name, reason: 'Session-only source cannot be included after restart.' });
        continue;
      }
      if (asset.pathKind === 'absolute' && !includeLinked) {
        externalNotCollected.push({ assetId: asset.id, name: asset.name, sourcePath: asset.sourcePath });
        continue;
      }
      const resolved = await resolveAssetPath({ root, projectId, asset });
      if (!resolved.available) {
        externalNotCollected.push({ assetId: asset.id, name: asset.name, reason: resolved.reason });
        continue;
      }
      const fingerprint = asset.fingerprint || await hashFile(resolved.filePath);
      const name = `${fingerprint.slice(0, 20)}-${safeBaseName(asset.name)}`;
      let destination = path.join(mediaDirectory, name);
      if (copied.has(fingerprint)) destination = copied.get(fingerprint);
      else {
        await fs.copyFile(resolved.filePath, destination, require('node:fs').constants.COPYFILE_EXCL);
        if (await hashFile(destination) !== fingerprint) throw new Error(`Backup verification failed for ${asset.name}.`);
        copied.set(fingerprint, destination);
      }
      asset.sourcePath = path.posix.join('Media', path.basename(destination));
      asset.pathKind = 'project-relative';
      asset.fingerprint = fingerprint;
      asset.fileSizeBytes = (await fs.stat(destination)).size;
    }
    const rewrittenContents = `${JSON.stringify(document, null, 2)}\n`;
    parseProjectEnvelope(rewrittenContents, { allowLegacy: true, expectedId: projectId });
    await fs.writeFile(path.join(temporaryPath, MANIFEST_NAME), rewrittenContents, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(temporaryPath, 'backup.json'), `${JSON.stringify({ formatVersion: 1, projectId, createdAt: new Date().toISOString(), externalNotCollected }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryPath, backupPath);
    return { backupPath, externalNotCollected };
  } catch (error) {
    await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreProjectBackup({ backupDirectory, destinationRoot, newProjectId }) {
  const sourceDirectory = path.resolve(backupDirectory);
  await assertNoSymlinks(sourceDirectory);
  const manifest = path.join(sourceDirectory, MANIFEST_NAME);
  const manifestStat = await fs.lstat(manifest);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('Backup manifest is not a regular file.');
  const { contents } = await readProjectFile(manifest);
  const document = parseProjectEnvelope(contents, { allowLegacy: true });
  const projectId = newProjectId || document.id;
  await ensureStorageLayout(destinationRoot);
  const destination = projectDirectory(destinationRoot, projectId);
  try { await fs.lstat(destination); throw new Error('A project with this identity already exists in the storage library.'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.${crypto.randomUUID()}.restoring`;
  try {
    await fs.cp(sourceDirectory, temporaryPath, { recursive: true, errorOnExist: true, force: false });
    const copiedContents = await fs.readFile(path.join(temporaryPath, MANIFEST_NAME), 'utf8');
    const restored = parseProjectEnvelope(copiedContents, { allowLegacy: true });
    if (projectId !== restored.id) {
      restored.id = projectId;
      await fs.writeFile(path.join(temporaryPath, MANIFEST_NAME), `${JSON.stringify(restored, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    }
    await fs.rename(temporaryPath, destination);
    const restoredContents = await fs.readFile(path.join(destination, MANIFEST_NAME), 'utf8');
    return { projectId, folder: destination, contents: restoredContents };
  } catch (error) {
    await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function clearCache(root) {
  const resolvedRoot = path.resolve(root);
  const cachePath = path.join(resolvedRoot, 'Cache');
  const projectsPath = path.join(resolvedRoot, 'Projects');
  const mediaDirs = new Set();
  try {
    const dirs = await fs.readdir(projectsPath, { withFileTypes: true });
    for (const entry of dirs) if (entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name)) mediaDirs.add(path.join(projectsPath, entry.name, 'Media'));
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const stat = await fs.lstat(cachePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('Cache directory is not a safe directory.');
  await fs.mkdir(cachePath, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(cachePath, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.resolve(cachePath, entry.name);
    if (!isWithin(cachePath, candidate) || candidate === projectsPath || [...mediaDirs].some((media) => isWithin(candidate, media) || isWithin(media, candidate))) throw new Error('Cache cleanup refused to cross into project or managed-media storage.');
    await fs.rm(candidate, { recursive: true, force: true });
  }
  return { removedEntries: entries.length };
}

module.exports = {
  MANIFEST_NAME,
  ROOT_DIRECTORIES,
  applicationDataRoot,
  archiveLibraryProject,
  clearCache,
  cloneLibraryProject,
  createProjectBackup,
  ensureStorageLayout,
  hashFile,
  importMedia,
  listLibraryProjects,
  projectDirectory,
  resolveAssetPath,
  restoreProjectBackup,
  saveLibraryProject,
};
