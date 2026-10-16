export type Tier = 'light' | 'standard' | 'high';

export interface QualitySettings {
  tier: Tier;
  label: string;
  /** Head mesh grid cell size in metres. */
  cell: number;
  /** Lock tubes: rings per segment and sides per ring. */
  sub: number;
  sides: number;
  /** Highest device-pixel ratio we render at (higher-DPI screens are downsampled). */
  maxDpr: number;
}

export const QUALITY: Record<Tier, QualitySettings> = {
  light: { tier: 'light', label: 'Light', cell: 0.004, sub: 1, sides: 5, maxDpr: 1.25 },
  standard: { tier: 'standard', label: 'Standard', cell: 0.003, sub: 2, sides: 6, maxDpr: 1.5 },
  high: { tier: 'high', label: 'High', cell: 0.0025, sub: 2, sides: 8, maxDpr: 2 },
};

export const TIERS: Tier[] = ['light', 'standard', 'high'];

/**
 * Picks a starting tier from the GPU name. Users can always override it.
 * Integrated Intel GPUs (e.g. UHD 630 in older gaming laptops, where browsers
 * usually run on the iGPU) get Standard; Apple silicon and discrete GPUs get High.
 */
export function autoTier(gpu: string, coarsePointer: boolean): Tier {
  const g = gpu.toLowerCase();
  if (/swiftshader|llvmpipe|software|mali|adreno|powervr/.test(g)) return 'light';
  if (coarsePointer) return /apple/.test(g) ? 'standard' : 'light';
  if (/apple|nvidia|geforce|rtx|gtx|radeon rx|radeon pro|arc\(?tm\)? a/.test(g)) return 'high';
  return 'standard';
}
