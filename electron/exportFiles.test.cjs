const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MAX_EXPORT_CHUNK_BYTES, abortExportFile, beginExportFile, commitExportFile, prepareExportFile, readExportChunk, safeExportFilename, writeExportChunk } = require('./exportFiles.cjs');

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

test('prefixes reserved Windows device names without altering similar ordinary names', () => {
  const reserved = ['CON', 'con', 'NUL', 'COM1', 'LPT9', 'con.tar.gz', 'aux.', 'nul. ', 'COM¹.txt', 'lpt²'];
  for (const name of reserved) assert.match(safeExportFilename(name, 'mp4'), /^_/);
  assert.equal(safeExportFilename('console', 'mp4'), 'console.mp4');
  assert.equal(safeExportFilename('COM10', 'webm'), 'COM10.webm');
});

test('streams export chunks out of order, prepares ranged reads, and atomically publishes only on commit', async () => {
  await withTemporaryDirectory(async (directory) => {
    const transaction = await beginExportFile({ folderPath: directory, fileName: 'streamed', extension: 'webm', expectedSizeBytes: 8 });
    await writeExportChunk(transaction, 4, new Uint8Array(Buffer.from('efgh')));
    await writeExportChunk(transaction, 0, new Uint8Array(Buffer.from('abcd')));
    assert.equal(await prepareExportFile(transaction), 8);
    assert.deepEqual(await readExportChunk(transaction, 2, 6), new Uint8Array(Buffer.from('cdef')));
    assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.part')).length, 1);
    const saved = await commitExportFile(transaction);
    assert.equal(saved.fileName, 'streamed.webm');
    assert.equal(saved.sizeBytes, 8);
    assert.deepEqual(await fs.readFile(saved.filePath), Buffer.from('abcdefgh'));
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.part')), []);
  });
});

test('abort removes partial exports and chunk writes enforce the configured bound', async () => {
  await withTemporaryDirectory(async (directory) => {
    const transaction = await beginExportFile({ folderPath: directory, fileName: 'cancelled', extension: 'mp4', expectedSizeBytes: 4 });
    await writeExportChunk(transaction, 0, new Uint8Array(Buffer.from('part')));
    await assert.rejects(writeExportChunk(transaction, 4, new Uint8Array(MAX_EXPORT_CHUNK_BYTES + 1)), /8 MiB/);
    await abortExportFile(transaction);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('rejects incomplete or pre-existing streamed outputs without replacing them', async () => {
  await withTemporaryDirectory(async (directory) => {
    const transaction = await beginExportFile({ folderPath: directory, fileName: 'gapped', extension: 'webm', expectedSizeBytes: 8 });
    await writeExportChunk(transaction, 2, new Uint8Array(Buffer.from('gap')));
    await assert.rejects(prepareExportFile(transaction), /gap|contiguous/i);
    await abortExportFile(transaction);

    const existingPath = path.join(directory, 'existing.mp4');
    const existing = await beginExportFile({ folderPath: directory, fileName: 'existing', extension: 'mp4', expectedSizeBytes: 1 });
    await writeExportChunk(existing, 0, new Uint8Array([1]));
    await prepareExportFile(existing);
    await fs.writeFile(existingPath, 'keep');
    await assert.rejects(commitExportFile(existing), /already exists/);
    await abortExportFile(existing);
    assert.equal(await fs.readFile(existingPath, 'utf8'), 'keep');
  });
});

test('rejects invalid streamed export parameters', async () => {
  await assert.rejects(beginExportFile({ folderPath: 'relative', fileName: 'final', extension: 'mp4', expectedSizeBytes: 1 }), /valid export folder/);
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(beginExportFile({ folderPath: directory, fileName: 'empty', extension: 'mp4', expectedSizeBytes: 0 }), /estimated export size is invalid/);
    const transaction = await beginExportFile({ folderPath: directory, fileName: 'empty-chunk', extension: 'mp4', expectedSizeBytes: 1 });
    await assert.rejects(writeExportChunk(transaction, 0, new Uint8Array()), /1 byte to 8 MiB/);
    await abortExportFile(transaction);
  });
});
