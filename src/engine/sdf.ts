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

/** Signed distance to the plane through `y = y0 + slope * z`, negative above it. */
export function sdAboveLine(y: number, z: number, y0: number, slope: number): number {
  return (y0 + slope * z - y) / Math.sqrt(1 + slope * slope);
}

export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

// ---------------------------------------------------------------------------
// Value noise (deterministic, allocation-free), range roughly [-1, 1].

function hash3(i: number, j: number, k: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const a = hash3(xi, yi, zi), b = hash3(xi + 1, yi, zi);
  const c = hash3(xi, yi + 1, zi), d = hash3(xi + 1, yi + 1, zi);
  const e = hash3(xi, yi, zi + 1), f = hash3(xi + 1, yi, zi + 1);
  const g = hash3(xi, yi + 1, zi + 1), h = hash3(xi + 1, yi + 1, zi + 1);
  const x0 = a + (b - a) * ux, x1 = c + (d - c) * ux, x2 = e + (f - e) * ux, x3 = g + (h - g) * ux;
  const y0 = x0 + (x1 - x0) * uy, y1 = x2 + (x3 - x2) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}

/** Two-octave fractal noise, range roughly [-1, 1]. */
export function fbm2(x: number, y: number, z: number): number {
  return valueNoise(x, y, z) * 0.67 + valueNoise(x * 2.03 + 17.1, y * 2.03 - 3.7, z * 2.03 + 9.2) * 0.33;
}

// ---------------------------------------------------------------------------
// Colour-carrying sculpt accumulator.

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

  /** Smooth subtraction of shape `d`. */
  carve(d: number, k = 0): void {
    if (k <= 0) {
      this.d = Math.max(this.d, -d);
      return;
    }
    const h = clamp(0.5 - (0.5 * (this.d + d)) / k, 0, 1);
    this.d = this.d + (-d - this.d) * h + k * h * (1 - h);
  }

  /** Smooth intersection with shape `d`. */
  intersect(d: number, k = 0): void {
    if (k <= 0) {
      this.d = Math.max(this.d, d);
      return;
    }
    const h = clamp(0.5 - (0.5 * (this.d - d)) / k, 0, 1);
    this.d = this.d + (d - this.d) * h + k * h * (1 - h);
  }
}

const dot2 = (x: number, y: number, z: number): number => x * x + y * y + z * z;

/** Unsigned distance to the planar quad a-b-c-d (corners in order). */
export function udQuad(
  px: number, py: number, pz: number,
  a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[],
): number {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const cbx = c[0] - b[0], cby = c[1] - b[1], cbz = c[2] - b[2];
  const dcx = d[0] - c[0], dcy = d[1] - c[1], dcz = d[2] - c[2];
  const adx = a[0] - d[0], ady = a[1] - d[1], adz = a[2] - d[2];
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const pbx = px - b[0], pby = py - b[1], pbz = pz - b[2];
  const pcx = px - c[0], pcy = py - c[1], pcz = pz - c[2];
  const pdx = px - d[0], pdy = py - d[1], pdz = pz - d[2];
  // normal = ba × ad
  const nx = bay * adz - baz * ady, ny = baz * adx - bax * adz, nz = bax * ady - bay * adx;
  // side tests: sign(dot(edge × n, p - corner))
  const side = (ex: number, ey: number, ez: number, qx: number, qy: number, qz: number): number =>
    Math.sign((ey * nz - ez * ny) * qx + (ez * nx - ex * nz) * qy + (ex * ny - ey * nx) * qz);
  const inside = side(bax, bay, baz, pax, pay, paz) + side(cbx, cby, cbz, pbx, pby, pbz) +
    side(dcx, dcy, dcz, pcx, pcy, pcz) + side(adx, ady, adz, pdx, pdy, pdz) >= 3;
  if (inside) {
    const dn = nx * pax + ny * pay + nz * paz;
    return Math.sqrt((dn * dn) / dot2(nx, ny, nz));
  }
  const seg = (ex: number, ey: number, ez: number, qx: number, qy: number, qz: number): number => {
    const t = clamp((ex * qx + ey * qy + ez * qz) / dot2(ex, ey, ez), 0, 1);
    return dot2(ex * t - qx, ey * t - qy, ez * t - qz);
  };
  return Math.sqrt(Math.min(
    seg(bax, bay, baz, pax, pay, paz), seg(cbx, cby, cbz, pbx, pby, pbz),
    seg(dcx, dcy, dcz, pcx, pcy, pcz), seg(adx, ady, adz, pdx, pdy, pdz),
  ));
}
