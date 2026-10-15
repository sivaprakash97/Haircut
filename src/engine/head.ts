import { rgb } from './color';
import type { Bounds } from './grid';
import type { SampleOut } from './build';
import { Sculpt, len3, sdCapsule, sdEllipsoid, sdRoundCone, sdSphere, smax, smin } from './sdf';

// Placeholder stylized bust, built from a handful of smooth shapes.
// Metres; y up, the face looks toward +z. Replaced by a custom model in M7.

export const HEAD_BOUNDS: Bounds = { min: [-0.165, -0.26, -0.115], max: [0.165, 0.145, 0.14] };

const SKIN = rgb(0xc98a5e);
const LIPS = rgb(0xa45a4c);
const JACKET = rgb(0xf2c230);
const COLLAR = rgb(0x2b2140);

/** The skull alone; hairstyles offset this to make caps that hug the head. */
export function craniumSDF(x: number, y: number, z: number): number {
  return sdEllipsoid(x, y, z, 0, 0.026, -0.006, 0.074, 0.089, 0.09);
}

/** Jaw and chin; beards offset this so they follow the jawline, not the neck. */
export function jawSDF(x: number, y: number, z: number): number {
  return smin(
    sdEllipsoid(x, y, z, 0, -0.03, 0.02, 0.064, 0.062, 0.066),
    sdSphere(x, y, z, 0, -0.082, 0.047, 0.022),
    0.025,
  );
}

function mouthSDF(x: number, y: number, z: number): number {
  return sdCapsule(x, y, z, -0.019, -0.05, 0.087, 0.019, -0.05, 0.087, 0.0034);
}

function torsoSDF(x: number, y: number, z: number): number {
  return sdEllipsoid(x, y, z, 0, -0.226, -0.012, 0.15, 0.075, 0.085);
}

function collarSDF(x: number, y: number, z: number): number {
  // Torus around the neck.
  const q = Math.sqrt(x * x + (z + 0.012) * (z + 0.012)) - 0.041;
  return len3(q, y + 0.145, 0) - 0.0125;
}

function faceSDF(x: number, y: number, z: number): number {
  const ax = Math.abs(x); // mirror-symmetric features
  let d = smin(craniumSDF(x, y, z), jawSDF(x, y, z), 0.035);
  d = smin(d, sdEllipsoid(ax, y, z, 0.044, -0.006, 0.05, 0.022, 0.02, 0.025), 0.02); // cheekbones
  d = smin(d, sdCapsule(x, y, z, -0.042, 0.036, 0.074, 0.042, 0.036, 0.074, 0.011), 0.02); // brow ridge
  d = smin(d, sdRoundCone(x, y, z, 0, 0.012, 0.085, 0, -0.017, 0.1, 0.0065, 0.0115), 0.012); // nose
  d = smin(d, sdEllipsoid(ax, y, z, 0.074, 0.002, -0.008, 0.012, 0.027, 0.019), 0.01); // ears
  d = smin(d, sdCapsule(x, y, z, 0, -0.06, -0.012, 0, -0.17, -0.012, 0.038), 0.03); // neck
  d = smax(d, -sdSphere(ax, y, z, 0.0305, 0.0165, 0.088, 0.0165), 0.009); // eye sockets
  d = smax(d, -mouthSDF(x, y, z), 0.006); // mouth line
  return d;
}

export function headSDF(x: number, y: number, z: number): number {
  let d = faceSDF(x, y, z);
  if (y < -0.11) {
    d = smin(d, torsoSDF(x, y, z), 0.04);
    d = smin(d, collarSDF(x, y, z), 0.008);
  }
  return d;
}

const sculpt = new Sculpt();

export function sampleHead(x: number, y: number, z: number, out: SampleOut): void {
  const s = sculpt;
  s.begin();
  const lip = Math.min(1, Math.max(0, 1 - (mouthSDF(x, y, z) - 0.0015) / 0.004));
  s.add(faceSDF(x, y, z), [SKIN[0] + (LIPS[0] - SKIN[0]) * lip, SKIN[1] + (LIPS[1] - SKIN[1]) * lip, SKIN[2] + (LIPS[2] - SKIN[2]) * lip]);
  if (y < -0.11) {
    // Shape blends softly; colour edges stay crisp but smooth.
    s.add(torsoSDF(x, y, z), JACKET, 0.04, 0.004);
    s.add(collarSDF(x, y, z), COLLAR, 0.008, 0.003);
  }
  out.d = s.d;
  out.r = s.r; out.g = s.g; out.b = s.b;
}
