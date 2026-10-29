const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_RECOVERY_POINTS,
  listRecoveryPoints,
  parseProjectEnvelope,
  readProjectFile,
  readRecoveryPoint,
  writeProjectFile,
} = require('./projectFiles.cjs');

function documentText(name, projectId = 'project-1') {
  return `${JSON.stringify({
    schemaVersion: 2,
    appVersion: '0.1.0',
    id: projectId,
    metadata: { name, createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z' },
    projectSettings: { defaultSequenceId: 'sequence-1' },
    assets: [],
    sequences: [{ id: 'sequence-1' }],
  }, null, 2)}\n`;
}

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clipwright-project-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, recoveryRoot: path.join(root, 'recovery'), filePath: path.join(root, 'My Edit.cwproject') };
}

test('saves a validated document atomically and checkpoints the previous version', async (t) => {
  const workspace = await makeWorkspace(t);
  const first = documentText('First title');
  const second = documentText('Second title');

  const initial = await writeProjectFile({ ...workspace, contents: first, expectedId: 'project-1' });
  assert.equal(initial.changed, true);
  assert.equal(initial.recoveryId, null);
  assert.equal(await fs.readFile(workspace.filePath, 'utf8'), first);

  const updated = await writeProjectFile({ ...workspace, contents: second, expectedId: 'project-1' });
  assert.equal(updated.changed, true);
  assert.match(updated.recoveryId, /^\d{13}-[0-9a-f-]+\.cwproject$/i);
  assert.equal(await fs.readFile(workspace.filePath, 'utf8'), second);

  const points = await listRecoveryPoints(workspace);
  assert.equal(points.length, 1);
  assert.equal(await readRecoveryPoint({ ...workspace, recoveryId: points[0].id, expectedId: 'project-1' }), first);
});

test('does not replace a managed file with malformed content or another project id', async (t) => {
  const workspace = await makeWorkspace(t);
  const original = documentText('Protected');
  await writeProjectFile({ ...workspace, contents: original, expectedId: 'project-1' });

  await assert.rejects(writeProjectFile({ ...workspace, contents: '{bad json', expectedId: 'project-1' }), /valid JSON/);
  await assert.rejects(writeProjectFile({ ...workspace, contents: documentText('Different', 'project-2'), expectedId: 'project-1' }), /different project/);
  assert.equal(await fs.readFile(workspace.filePath, 'utf8'), original);
  assert.deepEqual(await listRecoveryPoints(workspace), []);

  const externallyChanged = documentText('External replacement', 'project-2');
  await fs.writeFile(workspace.filePath, externallyChanged);
  await assert.rejects(writeProjectFile({ ...workspace, contents: documentText('Do not overwrite'), expectedId: 'project-1', expectedCurrentId: 'project-1' }), /changed identity outside ClipWright/);
  assert.equal(await fs.readFile(workspace.filePath, 'utf8'), externallyChanged);

  await fs.writeFile(workspace.filePath, documentText('Current linked version'));
  const linkedFile = await readProjectFile(workspace.filePath);
  const externalEdit = documentText('External same-id edit');
  await fs.writeFile(workspace.filePath, externalEdit);
  await assert.rejects(writeProjectFile({ ...workspace, contents: documentText('Do not overwrite'), expectedId: 'project-1', expectedCurrentId: 'project-1', expectedCurrentHash: linkedFile.contentHash }), /changed outside ClipWright/);
  assert.equal(await fs.readFile(workspace.filePath, 'utf8'), externalEdit);
});

test('skips duplicate checkpoints and retains only the newest recovery points', async (t) => {
  const workspace = await makeWorkspace(t);
  const first = documentText('Same title');
  await writeProjectFile({ ...workspace, contents: first, expectedId: 'project-1' });
  assert.equal((await writeProjectFile({ ...workspace, contents: first, expectedId: 'project-1' })).changed, false);
  assert.deepEqual(await listRecoveryPoints(workspace), []);

  for (let index = 0; index < MAX_RECOVERY_POINTS + 2; index += 1) {
    await writeProjectFile({ ...workspace, contents: documentText(`Revision ${index}`), expectedId: 'project-1' });
  }
  assert.equal((await listRecoveryPoints(workspace)).length, MAX_RECOVERY_POINTS);
});

test('rejects unsafe asset ids and non-SHA-256 fingerprints in project envelopes', () => {
  const unsafeId = JSON.parse(documentText('Unsafe asset id'));
  unsafeId.assets = [{ id: '../escape' }];
  assert.throws(() => parseProjectEnvelope(JSON.stringify(unsafeId), { allowLegacy: true }), /assets\[0\]\.id.*invalid/);

  const unsafeFingerprint = JSON.parse(documentText('Unsafe fingerprint'));
  unsafeFingerprint.assets = [{ id: 'asset-1', fingerprint: '../../../PWNED-' }];
  assert.throws(() => parseProjectEnvelope(JSON.stringify(unsafeFingerprint), { allowLegacy: true }), /assets\[0\]\.fingerprint.*SHA-256/);

  const validFingerprint = JSON.parse(documentText('Valid fingerprint'));
  validFingerprint.assets = [{ id: 'asset-1', fingerprint: 'a'.repeat(64) }];
  assert.equal(parseProjectEnvelope(JSON.stringify(validFingerprint), { allowLegacy: true }).assets[0].fingerprint, 'a'.repeat(64));
});

test('parses legacy JSON for importing but only permits schema-v2 writes', async (t) => {
  const workspace = await makeWorkspace(t);
  const legacy = JSON.stringify({ id: 'project-1', name: 'Older project' });
  assert.equal(parseProjectEnvelope(legacy, { allowLegacy: true }).id, 'project-1');
  await assert.rejects(writeProjectFile({ ...workspace, contents: legacy, expectedId: 'project-1' }), /schema-v2/);
  assert.deepEqual(await listRecoveryPoints(workspace), []);
});

test('rejects recovery identifiers that could escape the recovery directory', async (t) => {
  const workspace = await makeWorkspace(t);
  await assert.rejects(readRecoveryPoint({ ...workspace, recoveryId: '../../secret.cwproject', expectedId: 'project-1' }), /id is invalid/);
});
