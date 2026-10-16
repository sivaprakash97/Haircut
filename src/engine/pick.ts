import type { Field } from './grid';

export type Ray = readonly [number, number, number, number, number, number]; // origin xyz, unit direction xyz

export interface Hit {
  /** Distance along the ray. */
  t: number;
  p: [number, number, number];
  n: [number, number, number];
  surface: 'hair' | 'head';
}

/**
 * Sphere-traces the union of the hair and head distance fields. Saturated
 * (far) values under-estimate the true distance, so steps stay safe.
 */
export function raycast(hair: Field, head: Field, ray: Ray, maxSteps = 512): Hit | null {
  const [ox, oy, oz, dx, dy, dz] = ray;
  // Clip the ray to the hair grid's bounds (slab test).
  const min = [hair.ox, hair.oy, hair.oz];
  const max = [hair.ox + (hair.nx - 1) * hair.cell, hair.oy + (hair.ny - 1) * hair.cell, hair.oz + (hair.nz - 1) * hair.cell];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < min[a] || o[a] > max[a]) return null;
      continue;
    }
    let ta = (min[a] - o[a]) / d[a], tb = (max[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  }
  if (t0 > t1) return null;

  const eps = hair.cell * 0.15, minStep = hair.cell * 0.3;
  const dist = (x: number, y: number, z: number) => Math.min(hair.sampleWorld(x, y, z), head.sampleWorld(x, y, z));
  let t = t0;
  for (let s = 0; s < maxSteps && t <= t1; s++) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const dh = hair.sampleWorld(x, y, z), dk = head.sampleWorld(x, y, z);
    const dd = Math.min(dh, dk);
    if (dd < eps) {
      const h = hair.cell;
      let nx = dist(x + h, y, z) - dist(x - h, y, z);
      let ny = dist(x, y + h, z) - dist(x, y - h, z);
      let nz = dist(x, y, z + h) - dist(x, y, z - h);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      return { t, p: [x, y, z], n: [nx, ny, nz], surface: dh <= dk ? 'hair' : 'head' };
    }
    t += Math.max(dd * 0.9, minStep);
  }
  return null;
}
