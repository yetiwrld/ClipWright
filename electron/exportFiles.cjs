const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { prefixWindowsReservedName } = require('./fileNames.cjs');

const MAX_EXPORT_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;

function safeExportFilename(value, extension) {
  if (typeof value !== 'string' || value.length > 180 || !value.trim()) throw new Error('Enter a valid export filename.');
  if (extension !== 'mp4' && extension !== 'webm') throw new Error('Only MP4 and WebM exports can be saved.');
  const cleanBase = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 150);
  if (!cleanBase || cleanBase === '.' || cleanBase === '..') throw new Error('Enter a valid export filename.');
  const base = prefixWindowsReservedName(cleanBase);
  return `${base}.${extension}`;
}

async function beginExportFile({ folderPath, fileName, extension, expectedSizeBytes }) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('Choose a valid export folder.');
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1 || expectedSizeBytes > MAX_EXPORT_BYTES) throw new Error('The estimated export size is invalid or exceeds the 64 GiB save limit.');
  const safeFileName = safeExportFilename(fileName, extension);
  const resolvedFolder = path.resolve(folderPath);
  const folderStat = await fs.stat(resolvedFolder);
  if (!folderStat.isDirectory()) throw new Error('Choose a valid export folder.');
  const filePath = path.join(resolvedFolder, safeFileName);
  try {
    await fs.lstat(filePath);
    throw new Error(`${safeFileName} already exists. Choose another filename.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const disk = await fs.statfs(resolvedFolder);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isFinite(availableBytes) || expectedSizeBytes > availableBytes) throw new Error('There is not enough free disk space for the estimated export. Choose another folder or free disk space.');

  const id = crypto.randomUUID();
  const temporaryPath = path.join(resolvedFolder, `.${safeFileName}.${id}.part`);
  const fileHandle = await fs.open(temporaryPath, 'wx+', 0o600);
  return {
    id,
    folderPath: resolvedFolder,
    fileName: safeFileName,
    filePath,
    temporaryPath,
    fileHandle,
    prepared: false,
    closed: false,
    ranges: [],
    sizeBytes: null,
    maxBytes: Math.min(MAX_EXPORT_BYTES, Math.floor(availableBytes)),
  };
}

function addWrittenRange(transaction, start, end) {
  const ranges = [...transaction.ranges, [start, end]].sort((a, b) => a[0] - b[0]);
  transaction.ranges = ranges.reduce((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
    return merged;
  }, []);
}

async function writeExportChunk(transaction, position, bytes) {
  if (!transaction || transaction.closed || transaction.prepared) throw new Error('The export stream is not writable.');
  if (!Number.isSafeInteger(position) || position < 0 || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_EXPORT_CHUNK_BYTES) {
    throw new Error('Export chunks must contain 1 byte to 8 MiB and use a valid non-negative position.');
  }
  const end = position + bytes.byteLength;
  if (!Number.isSafeInteger(end) || end > transaction.maxBytes) throw new Error('The streamed export exceeds the available disk space or 64 GiB save limit.');
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await transaction.fileHandle.write(bytes, written, bytes.byteLength - written, position + written);
    if (result.bytesWritten <= 0) throw new Error('The export file could not accept the complete chunk.');
    written += result.bytesWritten;
  }
  addWrittenRange(transaction, position, end);
}

async function prepareExportFile(transaction) {
  if (!transaction || transaction.closed || transaction.prepared) throw new Error('The export stream cannot be prepared.');
  if (transaction.ranges.length !== 1 || transaction.ranges[0][0] !== 0 || transaction.ranges[0][1] < 1) throw new Error('The streamed export contains a gap; the output is not contiguous.');
  await transaction.fileHandle.sync();
  const stat = await transaction.fileHandle.stat();
  const expectedSize = transaction.ranges[0][1];
  if (!stat.isFile() || stat.size !== expectedSize || stat.size > MAX_EXPORT_BYTES) throw new Error('The streamed export size does not match its written byte ranges.');
  transaction.prepared = true;
  transaction.sizeBytes = stat.size;
  return stat.size;
}

async function readExportChunk(transaction, start, end) {
  if (!transaction || transaction.closed || !transaction.prepared) throw new Error('The export stream is not ready for validation reads.');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > transaction.sizeBytes || end - start > MAX_EXPORT_CHUNK_BYTES) {
    throw new Error('Export validation reads must be valid ranges no larger than 8 MiB.');
  }
  const bytes = Buffer.allocUnsafe(end - start);
  let read = 0;
  while (read < bytes.byteLength) {
    const result = await transaction.fileHandle.read(bytes, read, bytes.byteLength - read, start + read);
    if (result.bytesRead <= 0) throw new Error('The prepared export ended before the requested validation range.');
    read += result.bytesRead;
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function commitExportFile(transaction) {
  if (!transaction || transaction.closed || !transaction.prepared) throw new Error('The export must be fully written and validated before it can be committed.');
  await transaction.fileHandle.sync();
  await transaction.fileHandle.close();
  transaction.closed = true;
  try {
    // Hard-link publication is atomic and fails rather than replacing a file created during export.
    await fs.link(transaction.temporaryPath, transaction.filePath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${transaction.fileName} already exists. Choose another filename.`);
    throw error;
  }
  await fs.unlink(transaction.temporaryPath);
  return { filePath: transaction.filePath, fileName: transaction.fileName, sizeBytes: transaction.sizeBytes };
}

async function abortExportFile(transaction) {
  if (!transaction) return;
  if (!transaction.closed) {
    await transaction.fileHandle.close().catch(() => undefined);
    transaction.closed = true;
  }
  await fs.unlink(transaction.temporaryPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
}

module.exports = {
  MAX_EXPORT_BYTES,
  MAX_EXPORT_CHUNK_BYTES,
  abortExportFile,
  beginExportFile,
  commitExportFile,
  prepareExportFile,
  readExportChunk,
  safeExportFilename,
  writeExportChunk,
};
