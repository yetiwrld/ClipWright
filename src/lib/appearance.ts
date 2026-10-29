export type AppearanceTheme = 'dark' | 'light';
export type AccentName = 'orange' | 'blue' | 'violet';
export type InterfaceScale = 90 | 100 | 110 | 125;

export type AccentPalette = {
  accent: string;
  hover: string;
  selected: string;
  soft: string;
  rgb: string;
  border: string;
  ink: string;
};

const PALETTES: Record<AppearanceTheme, Record<AccentName, AccentPalette>> = {
  dark: {
    orange: { accent: '#ff7418', hover: '#ff8735', selected: '#522b18', soft: 'rgba(255,116,24,.12)', rgb: '255, 116, 24', border: 'rgba(255,116,24,.22)', ink: '#20130c' },
    blue: { accent: '#4b91e2', hover: '#6aa5ee', selected: '#1f3854', soft: 'rgba(75,145,226,.14)', rgb: '75, 145, 226', border: 'rgba(75,145,226,.26)', ink: '#0b1724' },
    violet: { accent: '#9b7bea', hover: '#b09af1', selected: '#382b53', soft: 'rgba(155,123,234,.15)', rgb: '155, 123, 234', border: 'rgba(155,123,234,.27)', ink: '#1b1428' },
  },
  light: {
    orange: { accent: '#b03f05', hover: '#993604', selected: '#f9e5d8', soft: 'rgba(176,63,5,.10)', rgb: '176, 63, 5', border: 'rgba(176,63,5,.24)', ink: '#ffffff' },
    blue: { accent: '#28639e', hover: '#1f5489', selected: '#dceafb', soft: 'rgba(40,99,158,.11)', rgb: '40, 99, 158', border: 'rgba(40,99,158,.23)', ink: '#ffffff' },
    violet: { accent: '#6e4aa5', hover: '#5e3d91', selected: '#e9e1fb', soft: 'rgba(110,74,165,.11)', rgb: '110, 74, 165', border: 'rgba(110,74,165,.22)', ink: '#ffffff' },
  },
};

export function getAccentPalette(theme: AppearanceTheme, accent: AccentName): AccentPalette {
  return PALETTES[theme][accent];
}

export function applyAppearance(
  root: HTMLElement,
  theme: AppearanceTheme,
  accent: AccentName,
  scale: InterfaceScale,
) {
  const palette = getAccentPalette(theme, accent);
  root.dataset.theme = theme;
  root.dataset.uiScale = String(scale);
  root.style.removeProperty('zoom');
  root.style.setProperty('--ui-scale', String(scale / 100));
  root.style.setProperty('--accent', palette.accent);
  root.style.setProperty('--accent-hover', palette.hover);
  root.style.setProperty('--accent-selected', palette.selected);
  root.style.setProperty('--accent-soft', palette.soft);
  root.style.setProperty('--accent-rgb', palette.rgb);
  root.style.setProperty('--accent-border', palette.border);
  root.style.setProperty('--accent-ink', palette.ink);
  root.style.setProperty('--focus', palette.accent);
  root.style.setProperty('--selection', palette.accent);
}
