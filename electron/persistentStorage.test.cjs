const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  MANIFEST_NAME, applicationDataRoot, archiveLibraryProject, clearCache, cloneLibraryProject, createProjectBackup,
  ensureStorageLayout, importMedia, listLibraryProjects, projectDirectory, resolveAssetPath, safeBaseName,
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

test('sanitizes managed-media and backup names that are reserved on Windows', () => {
  assert.equal(safeBaseName('CON'), '_CON');
  assert.equal(safeBaseName('nul.mp4'), '_nul.mp4');
  assert.equal(safeBaseName('aux. '), '_aux');
  assert.equal(safeBaseName('console.txt'), 'console.txt');
});

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
  const beforeChange = await fs.stat(source);
  await fs.writeFile(source, Buffer.alloc(linked.fileSizeBytes, 0x78));
  await fs.utimes(source, beforeChange.atime, new Date(beforeChange.mtimeMs + 5000));
  const changed = await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked });
  assert.equal(changed.available, false);
  assert.match(changed.reason, /contents changed/);
  await fs.unlink(source);
  const missing = await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /missing/);
});

test('absolute linked assets without a fingerprint are unavailable', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'unverified linked source.mp4');
  await fs.writeFile(source, 'unverified legacy fixture');
  const result = await resolveAssetPath({
    root,
    projectId: 'project-test-123',
    asset: { id: 'asset-no-fingerprint', pathKind: 'absolute', sourcePath: source, fileSizeBytes: (await fs.stat(source)).size },
  });
  assert.deepEqual(result, { available: false, reason: 'The linked media has no fingerprint; relink it to confirm the file.' });
});

test('linked media caches verified fingerprints per unchanged path, size, and mtime', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'cached linked source.mp4');
  await fs.writeFile(source, 'linked fixture');
  const linked = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-cached', sourcePath: source, mode: 'linked' });
  const originalCreateHash = crypto.createHash;
  let hashes = 0;
  crypto.createHash = function countedCreateHash(...args) {
    if (args[0] === 'sha256') hashes += 1;
    return originalCreateHash.apply(this, args);
  };
  t.after(() => { crypto.createHash = originalCreateHash; });

  assert.equal((await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked })).available, true);
  assert.equal(hashes, 1);
  assert.equal((await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked })).available, true);
  assert.equal(hashes, 1, 'unchanged linked files should use the verified in-memory fingerprint');

  const stat = await fs.stat(source);
  const changedMtime = stat.mtimeMs + 5000;
  await fs.utimes(source, stat.atime, new Date(changedMtime));
  assert.equal((await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked })).available, true);
  assert.equal(hashes, 2, 'a changed mtime must force a full hash');

  await fs.writeFile(source, 'linked fixture changed size');
  const changedSize = await resolveAssetPath({ root, projectId: 'project-test-123', asset: linked });
  assert.equal(changedSize.available, false);
  assert.match(changedSize.reason, /contents changed/);
  assert.equal(hashes, 3, 'a changed size must force a full hash before reporting changed contents');
});

test('fresh managed-media imports hash the verified temporary copy only once and preserve integrity checks', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'managed integrity.mp4');
  await fs.writeFile(source, 'managed integrity fixture');
  const originalCreateHash = crypto.createHash;
  let hashes = 0;
  crypto.createHash = function countedCreateHash(...args) {
    if (args[0] === 'sha256') hashes += 1;
    return originalCreateHash.apply(this, args);
  };
  t.after(() => { crypto.createHash = originalCreateHash; });

  const imported = await importMedia({ root, projectId: 'project-test-123', assetId: 'asset-integrity', sourcePath: source, mode: 'managed' });
  assert.equal(hashes, 3, 'two media hashes (source and copied temp) plus the project-folder ID hash; the new hard link is already those verified bytes');
  const managedPath = path.join(projectDirectory(root, 'project-test-123'), imported.sourcePath);
  await fs.writeFile(managedPath, Buffer.alloc(imported.fileSizeBytes, 0x78));
  const resolved = await resolveAssetPath({ root, projectId: 'project-test-123', asset: imported });
  assert.equal(resolved.available, true, 'managed media resolution retains its existing size-only availability policy');
  await assert.rejects(importMedia({ root, projectId: 'project-test-123', assetId: 'asset-integrity-duplicate', sourcePath: source, mode: 'managed' }), /collision/);
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

test('a recreated library process restores managed video, audio, and image clips after source removal', async (t) => {
  const root = await tempRoot(t);
  const sourceDirectory = path.join(root, 'imported sources');
  await fs.mkdir(sourceDirectory);
  const fixtures = [
    { id: 'asset-video', name: 'camera.mp4', kind: 'video', bytes: Buffer.from('managed-video-fixture'), streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 90, width: 1920, height: 1080 } } },
    { id: 'asset-audio', name: 'voice.wav', kind: 'audio', bytes: Buffer.from('managed-audio-fixture'), streams: { audio: { timeBase: { numerator: 1, denominator: 48000 }, durationTicks: 96000, sampleRate: 48000, channels: 2 } } },
    { id: 'asset-image', name: 'title.png', kind: 'image', bytes: Buffer.from('managed-image-fixture'), streams: {}, imageDimensions: { width: 320, height: 180 } },
  ];
  const importedAssets = [];
  const expectedFingerprints = {};
  for (const fixture of fixtures) {
    const sourcePath = path.join(sourceDirectory, fixture.name);
    await fs.writeFile(sourcePath, fixture.bytes);
    const imported = await importMedia({ root, projectId: 'project-test-123', assetId: fixture.id, sourcePath, mode: 'managed' });
    expectedFingerprints[fixture.id] = imported.fingerprint;
    importedAssets.push({
      id: fixture.id, name: fixture.name, kind: fixture.kind, streams: fixture.streams, imageDimensions: fixture.imageDimensions,
      sourcePath: imported.sourcePath, pathKind: imported.pathKind, fileSizeBytes: imported.fileSizeBytes, fingerprint: imported.fingerprint,
    });
  }
  const saved = document();
  saved.assets = importedAssets;
  const videoTrack = saved.sequences[0].tracks[0];
  const audioTrack = { id: 'track-a', name: 'Audio 1', kind: 'audio', muted: false, locked: false, clips: [] };
  saved.sequences[0].tracks.push(audioTrack);
  videoTrack.clips.push(
    { id: 'clip-video', sourceId: 'asset-video', trackId: videoTrack.id, start: 0, trimIn: 0, trimOut: 3 },
    { id: 'clip-image', sourceId: 'asset-image', trackId: videoTrack.id, start: 3, trimIn: 0, trimOut: 2 },
  );
  audioTrack.clips.push({ id: 'clip-audio', sourceId: 'asset-audio', trackId: audioTrack.id, start: 0, trimIn: 0, trimOut: 2 });
  saved.sequences[0].durationFrames = 150;
  await saveLibraryProject({ root, contents: json(saved) });
  await Promise.all(fixtures.map((fixture) => fs.unlink(path.join(sourceDirectory, fixture.name))));

  const { spawnSync } = require('node:child_process');
  const storageModule = path.resolve(__dirname, 'persistentStorage.cjs');
  const script = `const fs=require('node:fs/promises');const s=require(${JSON.stringify(storageModule)});(async()=>{const l=await s.listLibraryProjects(process.env.CLIPWRIGHT_TEST_ROOT);const p=l.projects.find(x=>x.documentId==='project-test-123');if(!p)throw Error('saved project was not restored');const d=JSON.parse(p.contents);const media=[];for(const a of d.assets){const r=await s.resolveAssetPath({root:process.env.CLIPWRIGHT_TEST_ROOT,projectId:d.id,asset:a});if(!r.available)throw Error(a.id+': '+r.reason);media.push({id:a.id,sha256:await s.hashFile(r.filePath),sizeBytes:r.sizeBytes});}console.log(JSON.stringify({document:d,media}));})().catch(e=>{console.error(e);process.exit(2)});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, CLIPWRIGHT_TEST_ROOT: root } });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.deepEqual(restored.media.map((media) => [media.id, media.sha256]), Object.entries(expectedFingerprints));
  const restoredVideoTrack = restored.document.sequences[0].tracks.find((track) => track.kind === 'video');
  const restoredAudioTrack = restored.document.sequences[0].tracks.find((track) => track.kind === 'audio');
  assert.deepEqual(restoredVideoTrack.clips.map((clip) => [clip.sourceId, clip.start, clip.trimOut]), [['asset-video', 0, 3], ['asset-image', 3, 2]]);
  assert.deepEqual(restoredAudioTrack.clips.map((clip) => [clip.sourceId, clip.start, clip.trimOut]), [['asset-audio', 0, 2]]);
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

test('backup refuses a manifest fingerprint traversal and leaves no file outside its temporary backup', async (t) => {
  const root = await tempRoot(t);
  const workspace = await tempRoot(t);
  await ensureStorageLayout(root);
  const projectId = 'project-traversal-1';
  const source = path.join(workspace, 'payload.bin');
  await fs.writeFile(source, 'backup-traversal-fixture');
  const managed = await importMedia({ root, projectId, assetId: 'asset-safe', sourcePath: source, mode: 'managed' });
  const doc = document(projectId);
  doc.assets.push({ id: 'asset-safe', name: 'payload.bin', ...managed, fingerprint: '../../../PWNED-', kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, width: 320, height: 180 } } });
  const projectFolder = projectDirectory(root, projectId);
  await fs.mkdir(projectFolder, { recursive: true });
  await fs.writeFile(path.join(projectFolder, MANIFEST_NAME), json(doc));

  const destinationDirectory = path.join(workspace, 'backups');
  const escapedPath = path.join(workspace, 'PWNED--payload.bin');
  await assert.rejects(createProjectBackup({ root, projectId, destinationDirectory }));
  await assert.rejects(fs.access(escapedPath), { code: 'ENOENT' });
});

test('restore refuses a backup manifest with a malicious fingerprint before copying it', async (t) => {
  const workspace = await tempRoot(t);
  const backupDirectory = path.join(workspace, 'malicious-backup');
  const mediaDirectory = path.join(backupDirectory, 'Media');
  await fs.mkdir(mediaDirectory, { recursive: true });
  const doc = document('project-malicious-backup');
  doc.assets.push({ id: 'asset-safe', name: 'payload.bin', sourcePath: 'Media/payload.bin', pathKind: 'project-relative', fingerprint: '../../../PWNED-', kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, width: 320, height: 180 } } });
  await fs.writeFile(path.join(backupDirectory, MANIFEST_NAME), json(doc));
  await fs.writeFile(path.join(mediaDirectory, 'payload.bin'), 'fixture');
  const destinationRoot = path.join(workspace, 'restore-target');

  await assert.rejects(restoreProjectBackup({ backupDirectory, destinationRoot }), /fingerprint.*SHA-256/i);
  await assert.rejects(fs.access(projectDirectory(destinationRoot, doc.id)), { code: 'ENOENT' });
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
