const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  MANIFEST_NAME, applicationDataRoot, archiveLibraryProject, clearCache, cloneLibraryProject, createProjectBackup,
  ensureStorageLayout, importMedia, listLibraryProjects, projectDirectory, resolveAssetPath,
  restoreProjectBackup, saveLibraryProject,
} = require('./persistentStorage.cjs');

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clipwright-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function document(id = 'project-test-123') {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    appVersion: '0.1.0',
    id,
    metadata: { name: 'Test project', createdAt: now, modifiedAt: now },
    projectSettings: { defaultSequenceId: 'sequence-1' },
    assets: [],
    sequences: [{ id: 'sequence-1', name: 'Sequence 01', width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioSampleRate: 48000, durationFrames: 0, tracks: [{ id: 'track-v', name: 'Video 1', kind: 'video', muted: false, locked: false, clips: [] }] }],
  };
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

test('uses Electron userData and creates a separate, lazily initialized storage tree', async (t) => {
  const userData = await tempRoot(t);
  const root = applicationDataRoot(userData);
  assert.equal(root, path.join(userData, 'ClipWright Studio'));
  const layout = await ensureStorageLayout(root);
  assert.deepEqual(Object.keys(layout.directories), ['Projects', 'Exports', 'Thumbnails', 'Cache', 'Diagnostics', 'Settings']);
  assert.throws(() => applicationDataRoot('relative-user-data'), /absolute/);
});

test('managed media copies originals, verifies bytes, deduplicates content, and survives source removal', async (t) => {
  const root = await tempRoot(t);
  const sourceDirectory = path.join(root, 'source folder ü');
  await fs.mkdir(sourceDirectory);
  const source = path.join(sourceDirectory, 'holiday clip.mp4');
  const bytes = Buffer.from('generated-media-fixture\0webm-or-mp4-bytes');
  await fs.writeFile(source, bytes);
  const imported = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-1', sourcePath: source, mode: 'managed' });
  assert.equal(imported.pathKind, 'project-relative');
  assert.match(imported.sourcePath, /^Media\//);
  assert.equal(imported.fileSizeBytes, bytes.length);
  assert.equal(imported.fingerprint.length, 64);
  assert.deepEqual(await fs.readFile(path.join(projectDirectory(root, 'project-test-123'), imported.sourcePath)), bytes);
  assert.deepEqual(await fs.readFile(source), bytes, 'the original must remain unchanged');
  const duplicate = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-2', sourcePath: source, mode: 'managed' });
  assert.equal(duplicate.sourcePath, imported.sourcePath);
  assert.equal(duplicate.deduplicated, true);
  const otherName = path.join(sourceDirectory, 'same bytes different filename.mp4');
  await fs.writeFile(otherName, bytes);
  const sameContent = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-3', sourcePath: otherName, mode: 'managed' });
  assert.equal(sameContent.sourcePath, imported.sourcePath);
  assert.equal(sameContent.deduplicated, true);
  await fs.unlink(source);
  const resolved = await resolveAssetPath({ root, projectId: 'project-test-123', asset: imported });
  assert.equal(resolved.available, true);
  assert.deepEqual(await fs.readFile(resolved.filePath), bytes);
});

test('managed duplicate filenames with different content never overwrite each other and preserve Unicode extensions', async (t) => {
  const root = await tempRoot(t);
  const sourceDir = path.join(root, 'source');
  await fs.mkdir(sourceDir);
  const first = path.join(sourceDir, 'été take.webm');
  const secondWebm = path.join(sourceDir, 'été take 2.webm');
  await fs.writeFile(first, 'first video');
  await fs.writeFile(secondWebm, 'different video');
  const one = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-one', sourcePath: first, mode: 'managed' });
  const two = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-two', sourcePath: secondWebm, mode: 'managed' });
  assert.notEqual(one.sourcePath, two.sourcePath);
  assert.match(one.sourcePath, /\.webm$/);
  assert.match(two.sourcePath, /\.webm$/);
  assert.deepEqual(await fs.readFile(path.join(projectDirectory(root, 'project-test-123'), one.sourcePath), 'utf8'), 'first video');
  assert.deepEqual(await fs.readFile(path.join(projectDirectory(root, 'project-test-123'), two.sourcePath), 'utf8'), 'different video');
});

test('linked media stores an absolute locator and detects a missing or changed source', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'linked source.mp4');
  await fs.writeFile(source, 'linked fixture');
  const linked = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-linked', sourcePath: source, mode: 'linked' });
  assert.equal(linked.pathKind, 'absolute');
  assert.equal(linked.sourcePath, source);
  assert.equal((await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked })).available, true);
  await fs.writeFile(source, Buffer.alloc(linked.fileSizeBytes, 0x78));
  const changed = await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked });
  assert.equal(changed.available, false);
  assert.match(changed.reason, /contents changed/);
  await fs.unlink(source);
  const missing = await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /missing/);
});

test('relative references reject traversal and paths accept spaces and Unicode names', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(resolveAssetPath({ root, projectId: 'project-test-123', asset: { pathKind: 'project-relative', sourcePath: '../../outside.mp4' } }), /escapes/);
  const source = path.join(root, '视频 space name.mp4');
  await fs.writeFile(source, 'unicode fixture');
  const linked = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-path', sourcePath: source, mode: 'linked' });
  assert.equal(path.basename(linked.sourcePath), '视频 space name.mp4');
});

test('managed-media resolution refuses symbolic-link escapes from the library', async (t) => {
  if (process.platform === 'win32') return;
  const root = await tempRoot(t);
  const external = path.join(root, 'external.bin');
  await fs.writeFile(external, 'outside');
  const source = path.join(root, 'inside.mp4');
  await fs.writeFile(source, 'managed');
  await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-safe', sourcePath: source, mode: 'managed' });
  const mediaRoot = path.join(projectDirectory(root, 'project-test-123'), 'Media');
  await fs.symlink(external, path.join(mediaRoot, 'escape.mp4'));
  await assert.rejects(resolveAssetPath({ root, projectId: 'project-test-123', asset: { pathKind: 'project-relative', sourcePath: 'Media/escape.mp4' } }), /escapes/);
});

test('project snapshots persist and concurrent autosaves serialize in call order', async (t) => {
  const root = await tempRoot(t);
  await ensureStorageLayout(root);
  const original = document();
  original.assets.push({ id: 'asset-1', name: 'take.mp4', sourcePath: 'Media/take.mp4', pathKind: 'project-relative', kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 90, width: 1920, height: 1080 } }, fileSizeBytes: 10 });
  original.sequences[0].durationFrames = 30;
  original.sequences[0].tracks[0].clips.push({ id: 'clip-1', sourceId: 'asset-1', trackId: 'track-v', start: 0, trimIn: 0, trimOut: 1 });
  const first = await saveLibraryProject({ root, contents: json(original) });
  const renamed = { ...original, metadata: { ...original.metadata, name: 'Renamed project', modifiedAt: new Date(Date.now() + 1).toISOString() } };
  const last = { ...renamed, sequences: renamed.sequences.map((sequence) => ({ ...sequence, width: 1080, height: 1920 })) };
  await Promise.all([
    saveLibraryProject({ root, contents: json(renamed), expectedCurrentHash: first.contentHash }),
    saveLibraryProject({ root, contents: json(last) }),
  ]);
  const restored = await listLibraryProjects(root);
  assert.equal(restored.issues.length, 0);
  assert.equal(restored.projects.length, 1);
  const diskDocument = JSON.parse(restored.projects[0].contents);
  assert.equal(diskDocument.metadata.name, 'Renamed project');
  assert.equal(diskDocument.sequences[0].width, 1080);
  assert.equal(diskDocument.sequences[0].tracks[0].clips[0].trimOut, 1);
});

test('a fresh process can restore a saved project manifest from disk', async (t) => {
  const root = await tempRoot(t);
  const saved = document();
  await saveLibraryProject({ root, contents: json(saved) });
  const { spawnSync } = require('node:child_process');
  const script = `const s=require(${JSON.stringify(path.resolve(__dirname, 'persistentStorage.cjs'))}); s.listLibraryProjects(process.env.CLIPWRIGHT_TEST_ROOT).then(v=>{console.log(JSON.stringify(v.projects.map(x=>JSON.parse(x.contents))))}).catch(e=>{console.error(e);process.exit(2)})`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, CLIPWRIGHT_TEST_ROOT: root } });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, saved.id);
  assert.equal(restored[0].sequences[0].tracks[0].clips.length, 0);
});

test('failed or malformed saves leave the last valid project and recovery copy intact', async (t) => {
  const root = await tempRoot(t);
  const valid = document();
  await saveLibraryProject({ root, contents: json(valid) });
  await assert.rejects(() => saveLibraryProject({ root, contents: '{broken' }));
  const listing = await listLibraryProjects(root);
  assert.equal(listing.projects.length, 1);
  assert.equal(JSON.parse(listing.projects[0].contents).id, valid.id);
  const changed = { ...valid, metadata: { ...valid.metadata, name: 'Recovered version', modifiedAt: new Date(Date.now() + 1).toISOString() } };
  await saveLibraryProject({ root, contents: json(changed) });
  const recoveryRoot = path.join(root, 'Diagnostics', 'Project recovery');
  const recoveryFiles = await fs.readdir(recoveryRoot, { recursive: true });
  assert.ok(recoveryFiles.some((file) => String(file).endsWith('.cwproject')));
});

test('backup collects linked files only by choice and restores project state and managed media elsewhere', async (t) => {
  const root = await tempRoot(t);
  const other = await tempRoot(t);
  await ensureStorageLayout(root);
  const projectId = 'project-test-123';
  const source = path.join(other, 'collect me ü.webm');
  await fs.writeFile(source, 'backup-fixture-bytes');
  const managed = await importMedia({ root, projectId, assetId: 'asset-managed', sourcePath: source, mode: 'managed' });
  const linked = await importMedia({ root, projectId, assetId: 'asset-linked', sourcePath: source, mode: 'linked' });
  const doc = document(projectId);
  doc.assets.push(
    { id: 'asset-managed', name: 'managed.webm', ...managed, kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, width: 320, height: 180 } } },
    { id: 'asset-linked', name: 'linked.webm', ...linked, kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, width: 320, height: 180 } } },
  );
  await saveLibraryProject({ root, contents: json(doc) });
  const created = await createProjectBackup({ root, projectId, destinationDirectory: path.join(other, 'backups'), includeLinked: true });
  assert.equal(created.externalNotCollected.length, 0);
  const movedRoot = path.join(other, 'restored-library');
  const restored = await restoreProjectBackup({ backupDirectory: created.backupPath, destinationRoot: movedRoot });
  const restoredDoc = JSON.parse(restored.contents);
  assert.equal(restoredDoc.sequences[0].width, 1920);
  assert.equal(restoredDoc.assets[0].pathKind, 'project-relative');
  assert.equal(restoredDoc.assets[1].pathKind, 'project-relative');
  for (const asset of restoredDoc.assets) assert.equal((await resolveAssetPath({ root: movedRoot, projectId, asset })).available, true);
  await assert.rejects(restoreProjectBackup({ backupDirectory: created.backupPath, destinationRoot: movedRoot }), /already exists/);
});

test('project duplication copies managed media and preserves external links without changing the original', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'sourced ü.mp4');
  await fs.writeFile(source, 'clone-bytes');
  const managed = await importMedia({ root, projectId: 'project-source-1', assetId: 'asset-managed', sourcePath: source, mode: 'managed' });
  const linked = await importMedia({ root, projectId: 'project-source-1', assetId: 'asset-linked', sourcePath: source, mode: 'linked' });
  const original = document('project-source-1');
  original.assets.push(
    { id: 'asset-managed', name: 'managed.mp4', ...managed, kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, width: 320, height: 180 } } },
    { id: 'asset-linked', name: 'linked.mp4', ...linked, kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, width: 320, height: 180 } } },
  );
  await saveLibraryProject({ root, contents: json(original) });
  const copied = { ...original, id: 'project-copy-1', metadata: { ...original.metadata, name: 'Test project copy' } };
  await cloneLibraryProject({ root, sourceProjectId: original.id, contents: json(copied) });
  const restored = await listLibraryProjects(root);
  assert.equal(restored.projects.length, 2);
  const copiedDoc = JSON.parse(restored.projects.find((item) => item.documentId === copied.id).contents);
  assert.equal(copiedDoc.assets[0].sourcePath, managed.sourcePath);
  assert.equal(copiedDoc.assets[1].sourcePath, linked.sourcePath);
  assert.equal((await resolveAssetPath({ root, projectId: copied.id, asset: copiedDoc.assets[0] })).available, true);
  assert.equal((await resolveAssetPath({ root, projectId: copied.id, asset: copiedDoc.assets[1] })).available, true);
  const archived = await archiveLibraryProject({ root, projectId: copied.id });
  assert.equal(archived.mediaPreserved, true);
  assert.equal((await listLibraryProjects(root)).projects.length, 1);
  assert.equal((await resolveAssetPath({ root, projectId: copied.id, asset: copiedDoc.assets[0] })).available, true);
});

test('cache cleanup is confined to Cache and does not touch manifests, source media, or exports', async (t) => {
  const root = await tempRoot(t);
  await ensureStorageLayout(root);
  const source = path.join(root, 'source.mp4');
  await fs.writeFile(source, 'preserve');
  const asset = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-cache', sourcePath: source, mode: 'managed' });
  await saveLibraryProject({ root, contents: json(document()) });
  const exportFile = path.join(root, 'Exports', 'done.webm');
  const cacheFile = path.join(root, 'Cache', 'waveform.bin');
  await fs.writeFile(exportFile, 'export');
  await fs.writeFile(cacheFile, 'cache');
  const result = await clearCache(root);
  assert.equal(result.removedEntries, 1);
  await assert.rejects(fs.access(cacheFile));
  await fs.access(path.join(projectDirectory(root, 'project-test-123'), MANIFEST_NAME));
  await fs.access(path.join(projectDirectory(root, 'project-test-123'), asset.sourcePath));
  await fs.access(exportFile);
});
