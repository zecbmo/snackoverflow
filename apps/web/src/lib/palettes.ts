/** The colour palettes in palettes.css, for the picker in Settings. Keep the two in step. */
export const PALETTES = [
  { id: 'blue', name: 'Blue', description: 'Calm blue; frozen food is slate', light: { bg: '#f8f9fb', accent: '#1b6fd8', ink: '#1b1f27' }, dark: { bg: '#13161b', accent: '#4c93f0', ink: '#eceff4' } },
  { id: 'violet', name: 'Violet', description: 'The original accent, used sparingly', light: { bg: '#fafafb', accent: '#6b4eff', ink: '#1d1d24' }, dark: { bg: '#141418', accent: '#6f56f7', ink: '#ededf2' } },
  { id: 'teal', name: 'Teal', description: 'Fresh, food-app feel', light: { bg: '#f8faf9', accent: '#0d7f73', ink: '#18211e' }, dark: { bg: '#121715', accent: '#2bb39f', ink: '#eaf0ee' } },
  { id: 'graphite', name: 'Graphite', description: 'Black and white, no colour accent', light: { bg: '#f7f7f7', accent: '#18181b', ink: '#18181b' }, dark: { bg: '#111113', accent: '#f0f0f2', ink: '#f0f0f2' } },
  { id: 'indigo', name: 'Indigo', description: 'Deep blue-violet; frozen food is slate', light: { bg: '#f8f8fc', accent: '#4f46e5', ink: '#1c1c2b' }, dark: { bg: '#131320', accent: '#8b85ff', ink: '#ececf6' } },
  { id: 'ocean', name: 'Ocean', description: 'Sea blue-green; frozen food is slate', light: { bg: '#f7fafb', accent: '#0e7490', ink: '#172227' }, dark: { bg: '#11171a', accent: '#38bdd8', ink: '#e9f1f4' } },
  { id: 'plum', name: 'Plum', description: 'Rich berry tone', light: { bg: '#faf8fa', accent: '#8e3a86', ink: '#221b22' }, dark: { bg: '#161215', accent: '#d07bc6', ink: '#f2ecf1' } },
  { id: 'espresso', name: 'Espresso', description: 'Warm greys with a cocoa accent', light: { bg: '#faf8f5', accent: '#8a5a3c', ink: '#231d18' }, dark: { bg: '#161310', accent: '#d39a6e', ink: '#f2ece6' } },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];
export const DEFAULT_PALETTE: PaletteId = 'blue';
