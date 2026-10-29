const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

function safeExportFilename(value, extension) {
  if (typeof value !== 'string' || value.length > 180 || !value.trim()) throw new Error('Enter a valid export filename.');
  if (extension !== 'mp4' && extension !== 'webm') throw new Error('Only MP4 and WebM exports can be saved.');
  const base = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 150);
  if (!base || base === '.' || base === '..') throw new Error('Enter a valid export filename.');
  return `${base}.${extension}`;
}

async function writeExportFile({ folderPath, fileName, extension, bytes }) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('Choose a valid export folder.');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_EXPORT_BYTES) {
    throw new Error('The encoded export is empty or exceeds the supported 1 GiB save limit.');
  }
  const safeFileName = safeExportFilename(fileName, extension);
  const resolvedFolder = path.resolve(folderPath);
  const filePath = path.join(resolvedFolder, safeFileName);
  if (path.dirname(filePath) !== resolvedFolder) throw new Error('The export filename is not valid.');
  let fileHandle;
  let created = false;
  try {
    fileHandle = await fs.open(filePath, 'wx', 0o600);
    created = true;
    await fileHandle.writeFile(Buffer.from(bytes));
    await fileHandle.sync();
  } catch (error) {
    await fileHandle?.close().catch(() => {});
    if (created) await fs.unlink(filePath).catch(() => {});
    if (error?.code === 'EEXIST') throw new Error(`${safeFileName} already exists. Choose another filename.`);
    throw error;
  }
  await fileHandle.close();
  return { filePath, fileName: safeFileName, sizeBytes: bytes.byteLength };
}

module.exports = { MAX_EXPORT_BYTES, safeExportFilename, writeExportFile };
