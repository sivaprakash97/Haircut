import type { SampleOut } from './build';
import { mixRgb, rgb } from './color';
import type { Bounds } from './grid';
import { craniumSDF, headSDF, jawSDF } from './head';
import type { PresetId } from './presetIds';
import { type Rgb, Sculpt, clamp, fbm2, sdAboveLine, sdCapsule, sdEllipsoid, sdRoundCone, smax } from './sdf';

export interface Preset {
  id: PresetId;
  label: string;
  /** Upper bound on how fast the shape's distance can change (1 for exact SDFs). */
  lipschitz: number;
  sample(x: number, y: number, z: number, out: SampleOut): void;
}

/** Space the hair volume may occupy (the grid the user sculpts in). */
export const HAIR_BOUNDS: Bounds = { min: [-0.18, -0.15, -0.185], max: [0.18, 0.26, 0.19] };

const s = new Sculpt();

/**
 * Hair hugging the skull above a hairline that runs from `front` (height at
 * the forehead) to `back` (height at the nape).
 */
function cap(x: number, y: number, z: number, thickness: number, front: number, back: number): number {
  const slope = (front - back) / 0.18;
  const above = sdAboveLine(y, z, back + 0.09 * slope, slope);
  return smax(craniumSDF(x, y, z) - thickness, above, 0.012);
}

/** Facial hair: a shell following the jawline, below the cheeks, clear of the lips. */
function beardShell(x: number, y: number, z: number, thickness: number, top: number): number {
  let d = jawSDF(x, y, z) - thickness;
  d = smax(d, y - (top - 0.35 * Math.max(0, -z + 0.03)), 0.01); // below the cheek line
  d = smax(d, -(z + 0.004), 0.015); // front half of the head only
  d = smax(d, -(sdCapsule(x, y, z, -0.021, -0.05, 0.09, 0.021, -0.05, 0.09, 0.0105)), 0.006); // keep lips clear
  return d;
}

function brows(x: number, y: number, z: number, col: Rgb): void {
  const ax = Math.abs(x);
  s.add(sdCapsule(ax, y, z, 0.015, 0.045, 0.0875, 0.045, 0.047, 0.0775, 0.0068), col, 0.002);
}

function finish(head: number, out: SampleOut): void {
  // No hair inside the head (overlap the scalp slightly so there is no gap).
  s.carve(head + 0.0015);
  out.d = s.d;
  out.r = s.r; out.g = s.g; out.b = s.b;
}

// --- Quiff: Jet Set Radio pompadour, faded sides, full beard ------------------
const Q_DARK = rgb(0x1d2b52), Q_MAIN = rgb(0x2f6bff), Q_TIP = rgb(0x8fd6ff);

function quiff(x: number, y: number, z: number, out: SampleOut): void {
  s.begin();
  s.add(cap(x, y, z, 0.009, 0.046, -0.06), Q_DARK);
  s.add(sdEllipsoid(x, y, z, 0, 0.094, 0.002, 0.058, 0.042, 0.084), Q_MAIN, 0.03);
  const t = clamp((z - 0.02) / 0.09, 0, 1);
  s.add(sdRoundCone(x, y, z, 0, 0.112, 0.0, 0, 0.148, 0.086, 0.04, 0.024), mixRgb(Q_MAIN, Q_TIP, t * t), 0.026);
  s.add(sdRoundCone(Math.abs(x), y, z, 0.022, 0.13, 0.045, 0.03, 0.146, 0.095, 0.016, 0.011), Q_TIP, 0.012);
  s.add(sdCapsule(Math.abs(x), y, z, 0.071, 0.012, 0.033, 0.069, -0.028, 0.04, 0.0075), Q_DARK, 0.008); // sideburns
  s.add(beardShell(x, y, z, 0.0105, -0.024), Q_DARK, 0.012);
  s.add(sdRoundCone(Math.abs(x), y, z, 0.002, -0.043, 0.094, 0.024, -0.05, 0.088, 0.0068, 0.0045), Q_DARK, 0.004); // moustache
  brows(x, y, z, Q_DARK);
  finish(headSDF(x, y, z), out);
}

// --- Spikes: swept-back spikes with hot tips, goatee ---------------------------
const S_BASE = rgb(0xffa21a), S_TIP = rgb(0xff2f6a), S_DARK = rgb(0x6b2a12);
const CRANIUM_C = [0, 0.026, -0.006] as const;
// [azimuth from the face (deg), elevation (deg), length (m)]
const SPIKES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 62, 0.058], [36, 46, 0.066], [-36, 46, 0.066], [180, 58, 0.088], [140, 36, 0.082],
  [-140, 36, 0.082], [96, 22, 0.064], [-96, 22, 0.064], [180, 20, 0.07], [64, 64, 0.07], [-64, 64, 0.07],
];
const SPIKE_DIRS = SPIKES.map(([az, el, len]) => {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return { dx: Math.sin(a) * Math.cos(e), dy: Math.sin(e), dz: Math.cos(a) * Math.cos(e), len };
});

function spikes(x: number, y: number, z: number, out: SampleOut): void {
  s.begin();
  s.add(cap(x, y, z, 0.011, 0.05, -0.055), S_BASE);
  for (const { dx, dy, dz, len } of SPIKE_DIRS) {
    const ax = CRANIUM_C[0] + dx * 0.075, ay = CRANIUM_C[1] + dy * 0.075, az = CRANIUM_C[2] + dz * 0.075;
    const reach = 0.088 + len;
    const bx = CRANIUM_C[0] + dx * reach, by = CRANIUM_C[1] + dy * reach, bz = CRANIUM_C[2] + dz * reach;
    const t = clamp(((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / (reach - 0.075), 0, 1);
    s.add(sdRoundCone(x, y, z, ax, ay, az, bx, by, bz, 0.024, 0.0045), mixRgb(S_BASE, S_TIP, t * t), 0.014);
  }
  s.add(sdCapsule(x, y, z, 0, -0.07, 0.07, 0, -0.1, 0.062, 0.011), S_DARK, 0.01); // goatee
  s.add(sdRoundCone(Math.abs(x), y, z, 0.002, -0.043, 0.094, 0.022, -0.049, 0.089, 0.0058, 0.004), S_DARK, 0.004);
  brows(x, y, z, S_DARK);
  finish(headSDF(x, y, z), out);
}

// --- Afro: big lumpy volume with a warm sheen, mutton chops ---------------------
const A_DARK = rgb(0x2b1a14), A_SHEEN = rgb(0x7a4a2c);

function afro(x: number, y: number, z: number, out: SampleOut): void {
  s.begin();
  let d = sdEllipsoid(x, y, z, 0, 0.058, -0.014, 0.128, 0.114, 0.124);
  const slope = (0.034 - -0.075) / 0.18;
  d = smax(d, sdAboveLine(y, z, -0.075 + 0.09 * slope, slope), 0.03);
  d += 0.0058 * fbm2(x * 52, y * 52, z * 52); // clumpy curls
  const sheen = clamp((y - 0.08) / 0.1, 0, 1);
  s.add(d, mixRgb(A_DARK, A_SHEEN, sheen * 0.8));
  brows(x, y, z, A_DARK);
  finish(headSDF(x, y, z), out);
}

export const PRESETS: Record<PresetId, Preset> = {
  quiff: { id: 'quiff', label: 'Quiff', lipschitz: 1.3, sample: quiff },
  spikes: { id: 'spikes', label: 'Spikes', lipschitz: 1.3, sample: spikes },
  afro: { id: 'afro', label: 'Afro', lipschitz: 2.2, sample: afro },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export type { PresetId };
