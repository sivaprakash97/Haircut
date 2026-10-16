// Signed distance primitives and operators (metres; negative = inside).
// Formulas follow Inigo Quilez, https://iquilezles.org/articles/distfunctions/

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Length of a 3-vector. (Math.hypot is several times slower in V8 hot loops.) */
export const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

export function sdSphere(x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number): number {
  return len3(x - cx, y - cy, z - cz) - r;
}

/** Approximate (bound-preserving) ellipsoid distance. */
export function sdEllipsoid(
  x: number, y: number, z: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
): number {
  const px = x - cx, py = y - cy, pz = z - cz;
  const k0 = len3(px / rx, py / ry, pz / rz);
  const k1 = len3(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

export function sdCapsule(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): number {
  const px = x - ax, py = y - ay, pz = z - az;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const h = clamp((px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz), 0, 1);
  return len3(px - dx * h, py - dy * h, pz - dz * h) - r;
}

/** Cone with rounded ends: radius r1 at a, r2 at b. */
export function sdRoundCone(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r1: number, r2: number,
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

export type Rgb = readonly [number, number, number];

const EMPTY = 1e9;

/**
 * Accumulates a smooth union of shapes while blending their colours with the
 * same weights, so blended joins also blend colour.
 */
export class Sculpt {
  d = EMPTY;
  r = 0;
  g = 0;
  b = 0;

  begin(): void {
    this.d = EMPTY;
    this.r = this.g = this.b = 0;
  }

  /**
   * Smooth union; `k` is the shape blend radius in metres (0 = hard union) and
   * `ck` the colour blend radius (defaults to `k`; smaller keeps colour edges crisp).
   */
  add(d: number, col: Rgb, k = 0, ck = k): void {
    if (this.d >= EMPTY) {
      this.d = d;
      this.r = col[0]; this.g = col[1]; this.b = col[2];
      return;
    }
    // Colour weight of the new shape.
    const hc = ck > 0 ? clamp(0.5 + (0.5 * (this.d - d)) / ck, 0, 1) : d < this.d ? 1 : 0;
    if (k <= 0) {
      this.d = Math.min(this.d, d);
    } else {
      const h = clamp(0.5 + (0.5 * (this.d - d)) / k, 0, 1);
      this.d = this.d + (d - this.d) * h - k * h * (1 - h);
    }
    this.r += (col[0] - this.r) * hc;
    this.g += (col[1] - this.g) * hc;
    this.b += (col[2] - this.b) * hc;
  }
}
