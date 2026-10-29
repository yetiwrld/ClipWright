const RESERVED_WINDOWS_STEMS = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|COM[¹²³]|LPT[¹²³])$/i;
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

function isWindowsReservedName(value) {
  const name = String(value ?? '');
  const firstComponent = name.split('.', 1)[0].replace(/[. ]+$/g, '');
  return RESERVED_WINDOWS_STEMS.test(firstComponent);
}

function prefixWindowsReservedName(value) {
  const name = String(value ?? '');
  return isWindowsReservedName(name) ? `_${name}` : name;
}

function safeProjectFilename(name) {
  let safeName = String(name || 'ClipWright project')
    .replace(INVALID_FILENAME_CHARACTERS, '-')
    .replace(/[. ]+$/g, '')
    .trim() || 'ClipWright project';
  safeName = prefixWindowsReservedName(safeName);
  return /\.cwproject$/i.test(safeName) ? safeName : `${safeName}.cwproject`;
}

module.exports = { isWindowsReservedName, prefixWindowsReservedName, safeProjectFilename };
