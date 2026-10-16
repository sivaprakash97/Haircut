import type { Editor } from './edit';
import { type CellBox, DEFAULT_HOLD, type Field } from './grid';
import { clamp, sdRoundCone, smin, udQuad } from './sdf';

// Sculpting operations on the hair Field. Each one calls `ed.touch(box)` before
// writing so the stroke can be undone and the right bricks re-meshed.

export type DistFn = (x: number, y: number, z: number) => number;
export type Vec3 = [number, number, number];

/** Hair stays this far outside the scalp (matches the starter hairstyles). */
const HEAD_GAP = 0.0015;

/** Smooth brush falloff: 1 at the centre, 0 at the rim. */
export const falloff = (t: number): number => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));

function sphereBox(f: Field, c: Vec3, r: number): CellBox | null {
  return f.boxAround(c[0] - r, c[1] - r, c[2] - r, c[0] + r, c[1] + r, c[2] + r);
}

function pointsBox(f: Field, pts: readonly Vec3[], pad: number): CellBox | null {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); z0 = Math.min(z0, p[2]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); z1 = Math.max(z1, p[2]);
  }
  return f.boxAround(x0 - pad, y0 - pad, z0 - pad, x1 + pad, y1 + pad, z1 + pad);
}

/** Calls fn(o, x, y, z) for every cell in the box. */
function eachCell(f: Field, b: CellBox, fn: (o: number, x: number, y: number, z: number) => void): void {
  const { cell, ox, oy, oz } = f;
  for (let k = b.k0; k <= b.k1; k++) {
    const z = oz + k * cell;
    for (let j = b.j0; j <= b.j1; j++) {
      const y = oy + j * cell;
      let o = f.idx(b.i0, j, k);
      for (let i = b.i0; i <= b.i1; i++, o++) fn(o, ox + i * cell, y, z);
    }
  }
}

/** Keeps material outside the head within `box` (CSG subtraction of the head). */
export function carveHead(f: Field, box: CellBox, head: DistFn): void {
  eachCell(f, box, (o, x, y, z) => {
    if (f.shape[o] === 127) return;
    const hd = head(x, y, z);
    if (hd > f.band) return;
    const q = f.quantize(-(hd + HEAD_GAP));
    if (q > f.shape[o]) f.shape[o] = q;
  });
}

/** Writes `d` (metres) into cell `o`; newly filled cells take the given material. */
function writeDist(f: Field, o: number, d: number, color: number, hold: number): void {
  const q = f.quantize(d);
  if (q === f.shape[o]) return;
  if (f.shape[o] >= 0 && q < 0) {
    f.color[o] = color;
    f.hold[o] = hold;
  }
  f.shape[o] = q;
}

// --- Grow ---------------------------------------------------------------------

/** Builds material up by `amount` metres at `c`, along the surface normal `n`. */
export function grow(ed: Editor, head: DistFn, c: Vec3, n: Vec3, r: number, amount: number, color: number): void {
  const f = ed.field;
  const rs = r * 0.6, k = r * 0.5;
  const s: Vec3 = [c[0] + n[0] * (amount - rs), c[1] + n[1] * (amount - rs), c[2] + n[2] * (amount - rs)];
  const box = sphereBox(f, s, rs + k);
  if (!box) return;
  ed.touch(box);
  eachCell(f, box, (o, x, y, z) => {
    const ds = Math.sqrt((x - s[0]) ** 2 + (y - s[1]) ** 2 + (z - s[2]) ** 2) - rs;
    if (ds > k + f.band) return;
    writeDist(f, o, smin(f.dist(o), ds, k), color, DEFAULT_HOLD);
  });
  carveHead(f, box, head);
}

// --- Comb (smudge) ------------------------------------------------------------

/** A copy of part of the field, read while the same cells are rewritten. */
class Region {
  shape: Int8Array;
  color: Uint16Array;
  hold: Uint8Array;
  readonly w: number;
  readonly h: number;
  readonly d: number;

  constructor(readonly f: Field, readonly box: CellBox) {
    this.w = box.i1 - box.i0 + 1; this.h = box.j1 - box.j0 + 1; this.d = box.k1 - box.k0 + 1;
    const n = this.w * this.h * this.d;
    this.shape = new Int8Array(n); this.color = new Uint16Array(n); this.hold = new Uint8Array(n);
    let r = 0;
    for (let k = box.k0; k <= box.k1; k++) {
      for (let j = box.j0; j <= box.j1; j++, r += this.w) {
        const o = f.idx(box.i0, j, k);
        this.shape.set(f.shape.subarray(o, o + this.w), r);
        this.color.set(f.color.subarray(o, o + this.w), r);
        this.hold.set(f.hold.subarray(o, o + this.w), r);
      }
    }
  }

  /** Trilinear shape value (int units) at a world position, clamped to the region. */
  shapeAt(x: number, y: number, z: number): number {
    const f = this.f, b = this.box;
    let gx = (x - f.ox) / f.cell - b.i0, gy = (y - f.oy) / f.cell - b.j0, gz = (z - f.oz) / f.cell - b.k0;
    gx = clamp(gx, 0, this.w - 1.0001); gy = clamp(gy, 0, this.h - 1.0001); gz = clamp(gz, 0, this.d - 1.0001);
    const i = gx | 0, j = gy | 0, k = gz | 0, fx = gx - i, fy = gy - j, fz = gz - k;
    const sy = this.w, sz = this.w * this.h, o = i + sy * j + sz * k, s = this.shape;
    const c00 = s[o] + (s[o + 1] - s[o]) * fx, c10 = s[o + sy] + (s[o + sy + 1] - s[o + sy]) * fx;
    const c01 = s[o + sz] + (s[o + sz + 1] - s[o + sz]) * fx, c11 = s[o + sy + sz] + (s[o + sy + sz + 1] - s[o + sy + sz]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  }

  /** Index of the nearest cell in the region. */
  nearest(x: number, y: number, z: number): number {
    const f = this.f, b = this.box;
    const i = clamp(Math.round((x - f.ox) / f.cell) - b.i0, 0, this.w - 1);
    const j = clamp(Math.round((y - f.oy) / f.cell) - b.j0, 0, this.h - 1);
    const k = clamp(Math.round((z - f.oz) / f.cell) - b.k0, 0, this.d - 1);
    return i + this.w * (j + this.h * k);
  }
}

function expand(f: Field, b: CellBox, m: number): CellBox {
  return {
    i0: Math.max(0, b.i0 - m), j0: Math.max(0, b.j0 - m), k0: Math.max(0, b.k0 - m),
    i1: Math.min(f.nx - 1, b.i1 + m), j1: Math.min(f.ny - 1, b.j1 + m), k1: Math.min(f.nz - 1, b.k1 + m),
  };
}

/**
 * Moves material near `c` along `delta`, fading out toward the brush rim
 * (semi-Lagrangian advection: each cell takes what was at p - v(p)).
 */
export function smudge(ed: Editor, head: DistFn, c: Vec3, delta: Vec3, r: number, strength: number): void {
  const len = Math.hypot(delta[0], delta[1], delta[2]);
  if (len < 1e-6) return;
  const steps = Math.max(1, Math.ceil(len / (0.25 * r)));
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) / steps;
    const center: Vec3 = [c[0] + delta[0] * t, c[1] + delta[1] * t, c[2] + delta[2] * t];
    const v: Vec3 = [(delta[0] / steps) * strength, (delta[1] / steps) * strength, (delta[2] / steps) * strength];
    advect(ed, head, center, r, () => v);
  }
}

/** Shared advection: new(p) = old(p - v(p) * falloff). */
function advect(ed: Editor, head: DistFn, c: Vec3, r: number, vel: (x: number, y: number, z: number, hold: number) => Vec3 | null): void {
  const f = ed.field;
  const box = sphereBox(f, c, r);
  if (!box) return;
  ed.touch(box);
  const src = new Region(f, expand(f, box, Math.ceil(r / f.cell) + 2));
  eachCell(f, box, (o, x, y, z) => {
    const w = falloff(Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / r);
    if (w === 0) return;
    const v = vel(x, y, z, src.hold[src.nearest(x, y, z)]);
    if (!v) return;
    const sx = x - v[0] * w, sy = y - v[1] * w, sz = z - v[2] * w;
    const q = Math.round(src.shapeAt(sx, sy, sz));
    if (q === f.shape[o]) return;
    const n = src.nearest(sx, sy, sz);
    f.shape[o] = q;
    f.color[o] = src.color[n];
    f.hold[o] = src.hold[n];
  });
  carveHead(f, box, head);
}

// --- Gel and hair dryer ---------------------------------------------------------

/** Raises (gel) or lowers (dryer) how firmly material holds its shape. */
export function paintHold(ed: Editor, c: Vec3, r: number, delta: number): void {
  const f = ed.field;
  const box = sphereBox(f, c, r);
  if (!box) return;
  ed.touch(box);
  eachCell(f, box, (o, x, y, z) => {
    const w = falloff(Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / r);
    if (w > 0) f.hold[o] = clamp(Math.round(f.hold[o] + delta * w), 0, 255);
  });
}

/**
 * Loose (low-hold) material sags under gravity and crumbles a little, the
 * further it is from the scalp, like dry sand losing its shape. Packed and
 * gelled material barely moves.
 */
export function slump(ed: Editor, head: DistFn, c: Vec3, r: number, dt: number): void {
  const maxSag = 0.09 * dt; // metres this frame for completely loose material
  advect(ed, head, c, r * 1.3, (x, y, z, hold) => {
    const loose = (1 - hold / 255) ** 2;
    const support = clamp((head(x, y, z) - 0.004) / 0.04, 0, 1);
    const sag = maxSag * loose * support;
    return sag > 1e-6 ? [0, -sag, 0] : null;
  });
}

// --- Extrude --------------------------------------------------------------------

export interface Pull {
  /** Surface point where the pull started, its normal, and the material colour there. */
  a: Vec3;
  n: Vec3;
  color: number;
  /** Where the tip is now. */
  b: Vec3;
}

/**
 * Live extrusion: undoes this stroke's previous preview, then stamps a tapered
 * spike from each pull's anchor to its current tip.
 */
export function extrude(ed: Editor, head: DistFn, pulls: readonly Pull[], r: number): void {
  const prev = ed.previewStart();
  ed.revertStroke();
  stampPulls(ed, head, pulls, r);
  ed.previewEnd(prev);
}

function stampPulls(ed: Editor, head: DistFn, pulls: readonly Pull[], r: number): void {
  const f = ed.field;
  for (const p of pulls) {
    const r1 = r * 0.75, r2 = Math.max(r * 0.2, f.cell * 1.6), k = r * 0.35;
    const a: Vec3 = [p.a[0] - p.n[0] * r1 * 0.5, p.a[1] - p.n[1] * r1 * 0.5, p.a[2] - p.n[2] * r1 * 0.5];
    let bx = p.b[0] - a[0], by = p.b[1] - a[1], bz = p.b[2] - a[2];
    const len = Math.hypot(bx, by, bz);
    if (len < r1 * 0.6) continue;
    const maxLen = 0.14;
    if (len > maxLen) { bx *= maxLen / len; by *= maxLen / len; bz *= maxLen / len; }
    const b: Vec3 = [a[0] + bx, a[1] + by, a[2] + bz];
    const box = pointsBox(f, [a, b], r1 + k + f.band);
    if (!box) continue;
    ed.touch(box);
    eachCell(f, box, (o, x, y, z) => {
      const dc = sdRoundCone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], r1, r2);
      if (dc > k + f.band) return;
      writeDist(f, o, smin(f.dist(o), dc, k), p.color, 255); // pulled spikes come out gelled
    });
    carveHead(f, box, head);
  }
}

// --- Scissors ---------------------------------------------------------------------

/**
 * Cuts a thin slab between two view rays (from `o` along `d0` and `d1`), from
 * depth `tn` to `tf`: what a blade swept across the screen would slice.
 */
export function cutSlice(ed: Editor, o: Vec3, d0: Vec3, d1: Vec3, tn: number, tf: number): void {
  const f = ed.field;
  const h = Math.max(1.25 * f.cell, 0.003); // half the kerf; >1 cell so pieces really separate
  const at = (d: Vec3, t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const A = at(d0, tn), B = at(d1, tn), C = at(d1, tf), D = at(d0, tf);
  const box = pointsBox(f, [A, B, C, D], h + f.band);
  if (!box) return;
  ed.touch(box);
  eachCell(f, box, (cell, x, y, z) => {
    const dq = udQuad(x, y, z, A, B, C, D);
    if (dq >= h + f.band) return;
    const q = f.quantize(h - dq);
    if (q > f.shape[cell]) f.shape[cell] = q;
  });
}
