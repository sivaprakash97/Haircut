// What the hair collides with: the head, neck and shoulders as a grid of
// signed distances (head space). Built once in the worker, then shared.

export interface BodyGrid {
  data: Int8Array;
  nx: number;
  ny: number;
  nz: number;
  ox: number;
  oy: number;
  oz: number;
  cell: number;
  /** Distance in metres represented by ±127. */
  band: number;
}

export class Body {
  private readonly d: Int8Array;
  private readonly inv: number;
  private readonly scale: number;
  private readonly mx: number;
  private readonly my: number;
  private readonly mz: number;
  private readonly sy: number;
  private readonly sz: number;
  /** Gradient direction from the last `sample` call (unit length, head space). */
  gx = 0;
  gy = 1;
  gz = 0;

  constructor(readonly grid: BodyGrid) {
    this.d = grid.data;
    this.inv = 1 / grid.cell;
    this.scale = grid.band / 127;
    this.mx = grid.nx - 1.0001;
    this.my = grid.ny - 1.0001;
    this.mz = grid.nz - 1.0001;
    this.sy = grid.nx;
    this.sz = grid.nx * grid.ny;
  }

  /** Signed distance (metres) at a head-space point; also sets gx/gy/gz to the outward direction. */
  sample(x: number, y: number, z: number): number {
    const g = this.grid;
    let px = (x - g.ox) * this.inv, py = (y - g.oy) * this.inv, pz = (z - g.oz) * this.inv;
    if (px < 0) px = 0; else if (px > this.mx) px = this.mx;
    if (py < 0) py = 0; else if (py > this.my) py = this.my;
    if (pz < 0) pz = 0; else if (pz > this.mz) pz = this.mz;
    const i = px | 0, j = py | 0, k = pz | 0;
    const fx = px - i, fy = py - j, fz = pz - k;
    const s = this.d, sy = this.sy, sz = this.sz;
    const o = i + sy * j + sz * k;
    const c000 = s[o], c100 = s[o + 1], c010 = s[o + sy], c110 = s[o + sy + 1];
    const c001 = s[o + sz], c101 = s[o + sz + 1], c011 = s[o + sy + sz], c111 = s[o + sy + sz + 1];
    const c00 = c000 + (c100 - c000) * fx, c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx, c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    // Gradient of the trilinear interpolant: no extra lookups.
    const dx = ((c100 - c000) * (1 - fy) + (c110 - c010) * fy) * (1 - fz) + ((c101 - c001) * (1 - fy) + (c111 - c011) * fy) * fz;
    const dy = (c10 - c00) * (1 - fz) + (c11 - c01) * fz;
    const dz = c1 - c0;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 1e-6) {
      this.gx = dx / l; this.gy = dy / l; this.gz = dz / l;
    } else {
      this.gx = 0; this.gy = 1; this.gz = 0;
    }
    return (c0 + (c1 - c0) * fz) * this.scale;
  }

  /**
   * Distance along a head-space ray to the skin, or -1 if it misses within `tMax`.
   * Sphere tracing; saturated far values under-estimate distance, so steps stay safe.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax = 4): number {
    const g = this.grid;
    const lo = [g.ox, g.oy, g.oz];
    const hi = [g.ox + (g.nx - 1) * g.cell, g.oy + (g.ny - 1) * g.cell, g.oz + (g.nz - 1) * g.cell];
    const o = [ox, oy, oz], d = [dx, dy, dz];
    let t0 = 0, t1 = tMax;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        if (o[a] < lo[a] || o[a] > hi[a]) return -1;
        continue;
      }
      let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1) return -1;
    let t = t0;
    for (let n = 0; n < 400 && t <= t1; n++) {
      const dist = this.sample(ox + dx * t, oy + dy * t, oz + dz * t);
      if (dist < 0.0004) return t;
      t += Math.max(dist * 0.9, 0.0006);
    }
    return -1;
  }
}
