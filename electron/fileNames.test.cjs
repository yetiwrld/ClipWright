const test = require('node:test');
const assert = require('node:assert/strict');
const { isWindowsReservedName, prefixWindowsReservedName, safeProjectFilename } = require('./fileNames.cjs');

test('detects Windows device names case-insensitively before the first dot', () => {
  for (const name of ['CON', 'con.txt', 'PRN.tar.gz', 'aux.', 'nul. ', 'COM1.mp4', 'com9', 'LPT1.wav', 'lpt9', 'COM¹', 'com².txt', 'COM³', 'LPT¹', 'lpt².data', 'LPT³']) {
    assert.equal(isWindowsReservedName(name), true, name);
  }
  for (const name of ['console', 'COM0', 'COM10', 'LPT10', 'COM⁴', 'normal.txt', '.hidden']) {
    assert.equal(isWindowsReservedName(name), false, name);
  }
});

test('prefixes a reserved basename without dropping extensions or changing ordinary names', () => {
  assert.equal(prefixWindowsReservedName('CON.mp4'), '_CON.mp4');
  assert.equal(prefixWindowsReservedName('con.tar.gz'), '_con.tar.gz');
  assert.equal(prefixWindowsReservedName('AUX. '), '_AUX. ');
  assert.equal(prefixWindowsReservedName('console.mp4'), 'console.mp4');
});

test('sanitizes project filenames portably and keeps the project extension', () => {
  assert.equal(safeProjectFilename('CON'), '_CON.cwproject');
  assert.equal(safeProjectFilename('aux.'), '_aux.cwproject');
  assert.equal(safeProjectFilename('con.cwproject'), '_con.cwproject');
  assert.equal(safeProjectFilename('ordinary name'), 'ordinary name.cwproject');
});
