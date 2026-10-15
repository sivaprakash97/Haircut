import type { Rgb } from './sdf';

/** 0xRRGGBB (sRGB) -> [r, g, b] in 0..1. */
export function rgb(hex: number): Rgb {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Packs 0..1 sRGB components into RGB565. */
export function pack565(r: number, g: number, b: number): number {
  const ri = Math.round(Math.min(Math.max(r, 0), 1) * 31);
  const gi = Math.round(Math.min(Math.max(g, 0), 1) * 63);
  const bi = Math.round(Math.min(Math.max(b, 0), 1) * 31);
  return (ri << 11) | (gi << 5) | bi;
}

export const r565 = (v: number): number => ((v >> 11) & 31) / 31;
export const g565 = (v: number): number => ((v >> 5) & 63) / 63;
export const b565 = (v: number): number => (v & 31) / 31;
