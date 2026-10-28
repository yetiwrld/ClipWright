const crypto = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_RECOVERY_POINTS = 10;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashContents(contents) {
  return crypto.createHash('sha256').update(contents, 'utf8').digest('hex');
}

function parseProjectEnvelope(contents, { allowLegacy = false, expectedId } = {}) {
  if (typeof contents !== 'string') throw new Error('Project contents must be text.');
  if (Buffer.byteLength(contents, 'utf8') > PROJECT_FILE_MAX_BYTES) throw new Error('Project file exceeds the 25 MB safety limit.');
  let document;
  try { document = JSON.parse(contents); }
  catch { throw new Error('The project file is not valid JSON.'); }
  if (!isObject(document)) throw new Error('Project document must be a JSON object.');
  if (!allowLegacy && document.schemaVersion !== 2) throw new Error('Only validated schema-v2 project files can be saved.');
  if (allowLegacy && document.schemaVersion !== undefined && ![1, 2].includes(document.schemaVersion)) {
    throw new Error(`Unsupported project schema version: ${String(document.schemaVersion)}.`);
  }
  if (typeof document.id !== 'string' || !document.id.trim()) throw new Error('Project document is missing its stable id.');
  if (expectedId && document.id !== expectedId) throw new Error('The selected file is linked to a different project. Use Save As to create a separate copy.');
  if (!allowLegacy) {
    if (typeof document.appVersion !== 'string' || !document.appVersion.trim()) throw new Error('Project appVersion is invalid.');
    if (!isObject(document.metadata)
      || typeof document.metadata.name !== 'string' || !document.metadata.name.trim()
      || typeof document.metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(document.metadata.createdAt))
      || typeof document.metadata.modifiedAt !== 'string' || !Number.isFinite(Date.parse(document.metadata.modifiedAt))) {
      throw new Error('Project metadata is invalid.');
    }
    if (!isObject(document.projectSettings) || typeof document.projectSettings.defaultSequenceId !== 'string') throw new Error('Project settings are invalid.');
    if (!Array.isArray(document.assets) || !Array.isArray(document.sequences) || !document.sequences.some((sequence) => isObject(sequence) && sequence.id === document.projectSettings.defaultSequenceId)) {
      throw new Error('Project document does not include its declared default sequence or assets array.');
    }
  } else if (document.schemaVersion === 1 && (!Array.isArray(document.assets) || !Array.isArray(document.sequences))) {
    throw new Error('The version-1 project document is missing its media or sequence collections.');
  }
  return document;
}

function recoveryDirectory(recoveryRoot, filePath) {
  const resolved = path.resolve(filePath);
  const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(recoveryRoot, digest);
}

async function exists(pathName) {
  try { return await fs.lstat(pathName); }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, 'r+');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function rotateRecoveryPoints(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{13}-[0-9a-f-]+\.cwproject$/i.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    files.push({ filePath, modifiedAt: stat.mtimeMs });
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  await Promise.all(files.slice(MAX_RECOVERY_POINTS).map(({ filePath }) => fs.unlink(filePath)));
}

async function checkpointExisting(filePath, recoveryRoot) {
  const stat = await exists(filePath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The selected project path is not a regular file.');
  const directory = recoveryDirectory(recoveryRoot, filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${crypto.randomUUID()}.cwproject`;
  const checkpointPath = path.join(directory, name);
  await fs.copyFile(filePath, checkpointPath, constants.COPYFILE_EXCL);
  await syncFile(checkpointPath);
  await rotateRecoveryPoints(directory);
  return name;
}

async function replaceFileAtomically(temporaryPath, destinationPath) {
  try {
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    if (!error || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
    const displacedPath = `${destinationPath}.${crypto.randomUUID()}.replace`;
    await fs.rename(destinationPath, displacedPath);
    try {
      await fs.rename(temporaryPath, destinationPath);
    } catch (replaceError) {
      try { await fs.rename(displacedPath, destinationPath); }
      catch (restoreError) {
        throw new Error(`Could not replace the project file or restore its previous copy: ${restoreError.message}`);
      }
      throw replaceError;
    }
    await fs.unlink(displacedPath).catch(() => undefined);
  }
}

async function writeProjectFile({ filePath, contents, recoveryRoot, expectedId, expectedCurrentId, expectedCurrentHash }) {
  const document = parseProjectEnvelope(contents, { expectedId });
  const destinationPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const currentStat = await exists(destinationPath);
  if (currentStat && (!currentStat.isFile() || currentStat.isSymbolicLink())) throw new Error('The selected project path is not a regular file.');
  if (currentStat) {
    if (currentStat.size > PROJECT_FILE_MAX_BYTES) throw new Error('The existing project file exceeds the 25 MB safety limit.');
    const currentContents = await fs.readFile(destinationPath, 'utf8');
    if (expectedCurrentHash && hashContents(currentContents) !== expectedCurrentHash) throw new Error('The linked project file changed outside ClipWright; use Save As to avoid overwriting external changes.');
    if (expectedCurrentId) {
      const currentDocument = parseProjectEnvelope(currentContents, { allowLegacy: true });
      if (currentDocument.id !== expectedCurrentId) throw new Error('The linked project file changed identity outside ClipWright; use Save As to protect the other project.');
    }
    if (currentContents === contents) return { changed: false, recoveryId: null, documentId: document.id, contentHash: hashContents(contents) };
  }

  const temporaryPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${crypto.randomUUID()}.tmp`);
  let tempHandle;
  try {
    tempHandle = await fs.open(temporaryPath, 'wx', 0o600);
    await tempHandle.writeFile(contents, 'utf8');
    await tempHandle.sync();
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  try { await tempHandle.close(); }
  catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  let recoveryId = null;
  try {
    recoveryId = await checkpointExisting(destinationPath, recoveryRoot);
    await replaceFileAtomically(temporaryPath, destinationPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return { changed: true, recoveryId, documentId: document.id, contentHash: hashContents(contents) };
}

async function readProjectFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.lstat(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The selected project path is not a regular file.');
  if (stat.size > PROJECT_FILE_MAX_BYTES) throw new Error('Project file exceeds the 25 MB safety limit.');
  const contents = await fs.readFile(resolvedPath, 'utf8');
  const document = parseProjectEnvelope(contents, { allowLegacy: true });
  return { contents, documentId: document.id, contentHash: hashContents(contents) };
}

async function listRecoveryPoints({ filePath, recoveryRoot }) {
  const directory = recoveryDirectory(recoveryRoot, filePath);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error && error.code === 'ENOENT') return []; throw error; }
  const points = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{13}-[0-9a-f-]+\.cwproject$/i.test(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = await fs.stat(fullPath);
    points.push({ id: entry.name, modifiedAt: stat.mtime.toISOString(), sizeBytes: stat.size });
  }
  return points.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, MAX_RECOVERY_POINTS);
}

async function readRecoveryPoint({ filePath, recoveryRoot, recoveryId, expectedId }) {
  if (typeof recoveryId !== 'string' || path.basename(recoveryId) !== recoveryId || !/^\d{13}-[0-9a-f-]+\.cwproject$/i.test(recoveryId)) {
    throw new Error('Recovery checkpoint id is invalid.');
  }
  const fullPath = path.join(recoveryDirectory(recoveryRoot, filePath), recoveryId);
  const stat = await fs.lstat(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PROJECT_FILE_MAX_BYTES) throw new Error('Recovery checkpoint is unavailable or invalid.');
  const contents = await fs.readFile(fullPath, 'utf8');
  parseProjectEnvelope(contents, { expectedId, allowLegacy: true });
  return contents;
}

module.exports = {
  MAX_RECOVERY_POINTS,
  PROJECT_FILE_MAX_BYTES,
  listRecoveryPoints,
  parseProjectEnvelope,
  readProjectFile,
  readRecoveryPoint,
  recoveryDirectory,
  writeProjectFile,
};
