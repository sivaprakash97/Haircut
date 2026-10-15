// Kept separate from presets.ts so the UI can list hairstyles without
// bundling the shape code, which only the worker needs.
export type PresetId = 'quiff' | 'spikes' | 'afro';

export const PRESET_LIST: ReadonlyArray<{ id: PresetId; label: string }> = [
  { id: 'quiff', label: 'Quiff' },
  { id: 'spikes', label: 'Spikes' },
  { id: 'afro', label: 'Afro' },
];

export function isPresetId(v: string | null): v is PresetId {
  return PRESET_LIST.some((p) => p.id === v);
}
