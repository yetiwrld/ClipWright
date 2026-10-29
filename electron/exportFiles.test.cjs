const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safeExportFilename, writeExportFile } = require('./exportFiles.cjs');

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clipwright-export-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('accepts only MP4/WebM extensions and sanitizes path-like filenames', () => {
  assert.equal(safeExportFilename('final: cut/one', 'webm'), 'final- cut-one.webm');
  assert.equal(safeExportFilename('final cut', 'mp4'), 'final cut.mp4');
  assert.throws(() => safeExportFilename('final cut', 'avi'), /Only MP4 and WebM/);
  assert.throws(() => safeExportFilename('  ', 'mp4'), /valid export filename/);
});

test('writes exact export bytes and refuses to overwrite an existing file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bytes = new Uint8Array([0, 1, 2, 255, 42]);
    const result = await writeExportFile({ folderPath: directory, fileName: 'final', extension: 'webm', bytes });
    assert.equal(result.fileName, 'final.webm');
    assert.equal(result.sizeBytes, bytes.byteLength);
    assert.deepEqual(await fs.readFile(result.filePath), Buffer.from(bytes));
    await assert.rejects(writeExportFile({ folderPath: directory, fileName: 'final', extension: 'webm', bytes: new Uint8Array([9]) }), /already exists/);
    assert.deepEqual(await fs.readFile(result.filePath), Buffer.from(bytes));
  });
});

test('rejects missing bytes and non-absolute output folders', async () => {
  await assert.rejects(writeExportFile({ folderPath: 'relative', fileName: 'final', extension: 'mp4', bytes: new Uint8Array([1]) }), /valid export folder/);
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(writeExportFile({ folderPath: directory, fileName: 'empty', extension: 'mp4', bytes: new Uint8Array() }), /empty/);
    await assert.rejects(writeExportFile({ folderPath: directory, fileName: 'wrong', extension: 'mp4', bytes: 'text' }), /encoded export is empty/);
  });
});
