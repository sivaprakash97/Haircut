import type { Body } from './body';
import { DebrisPool } from './debris';
import { History } from './history';
import { MIN_LEN, NODES, ROOT_DEPTH, type LockData, lastNode, styleChecksum } from './locks';
import { STEP, Sim } from './sim';

// The hair the user is styling: physics, tools, cut pieces and history, all
// on the page's main thread (each tool touches a few hundred locks at most,
// well under a millisecond). No three.js or DOM, so tests run it directly.

export type ToolId = 'scissors' | 'clippers' | 'comb' | 'grow' | 'extrude';

/** World-space ray: origin xyz, unit direction xyz. */
export type Ray = readonly [number, number, number, number, number, number];
type V3 = [number, number, number];

export interface Hit {
  /** Distance along the ray. */
  t: number;
  p: V3;
  n: V3;
  surface: 'hair' | 'head';
}

export interface StrokeInput {
  phase: 'begin' | 'move' | 'end';
  tool: ToolId;
  ray: Ray;
  /** Brush radius (metres). */
  radius: number;
  /** 0..1 */
  strength: number;
  /** Also apply the stroke mirrored across the face's centre line. */
  mirror: boolean;
  /** Seconds since the previous stroke update. */
  dt: number;
  /** Clipper guard: length left on the head (metres). */
  guard: number;
}

/** Hair grows this fast at full strength (metres per second). */
const GROW_SPEED = 0.16;
/** How set freshly combed hair is at full strength (0 loose, 1 holds its shape fully). */
const COMB_SET = 0.45;
/** Most locks one extrude grabs. */
const MAX_GRAB = 70;

/** A lock held by the comb or by extrude. */
interface Held {
  i: number;
  /** Where the held point is now, and where it started (world). */
  x: number;
  y: number;
  z: number;
  ox: number;
  oy: number;
  oz: number;
  /** How closely it follows the pointer (extrude: less at the edge of the brush). */
  w: number;
  mirrored: boolean;
}

interface Stroke {
  tool: ToolId;
  prevRay: Ray | null;
  /** Comb: where the comb was last frame (world). */
  prevP: V3 | null;
  /** Depth of the last comb contact along the view ray, for strokes that leave the hair. */
  prevT: number;
  /** Extrude: the plane the pointer drags in (through the grab point, facing the camera). */
  plane: { p: V3; n: V3 } | null;
  held: Map<number, Held>;
  /** Comb: locks already combed through this stroke (they are not caught again). */
  done: Set<number>;
  /** How firmly combed hair keeps its new shape (from the comb's strength). */
  set: number;
}

const falloff = (d: number, r: number): number => {
  const q = 1 - (d * d) / (r * r);
  return q > 0 ? q * q : 0;
};

export class HairSession {
  readonly sim: Sim;
  readonly debris = new DebrisPool();
  readonly history: History;
  private readonly initial: { rest: Float32Array; len: Float32Array; hold: Float32Array; blunt: Float32Array; color: Uint32Array };
  private stroke: Stroke | null = null;
  /** Locks changed this frame by a tool (so their nodes are re-uploaded and the physics wakes). */
  private dirty = false;

  constructor(readonly L: LockData, readonly body: Body, yaw = 0) {
    this.sim = new Sim(L, body, yaw);
    this.history = new History(L);
    this.initial = { rest: L.rest.slice(), len: L.len.slice(), hold: L.hold.slice(), blunt: L.blunt.slice(), color: L.color.slice() };
  }

  /** One physics step for the hair and the falling pieces. Returns true while anything is still moving. */
  step(): boolean {
    this.sim.step();
    const falling = this.debris.step(this.body, this.sim.cos, this.sim.sin);
    const moving = !this.sim.asleep || falling || this.dirty;
    this.dirty = false;
    return moving;
  }

  checksum(): number {
    return styleChecksum(this.L);
  }

  /** Total visible hair length in metres (tests use it to see cuts and growth). */
  totalLength(): number {
    let sum = 0;
    for (let i = 0; i < this.L.count; i++) sum += this.L.len[i] * this.L.seg[i];
    return sum;
  }

  // ---------------------------------------------------------------- picking

  /** First hair or skin under a world ray. */
  pick(ray: Ray): Hit | null {
    const h = this.hitHair(ray), k = this.hitHead(ray);
    if (h && (!k || h.t <= k.t)) return h;
    return k;
  }

  /** The skin under a ray, ignoring hair (clippers work on the scalp). */
  hitHead(ray: Ray): Hit | null {
    const c = this.sim.cos, s = this.sim.sin;
    const [ox, oy, oz, dx, dy, dz] = ray;
    const t = this.body.raycast(c * ox - s * oz, oy, s * ox + c * oz, c * dx - s * dz, dy, s * dx + c * dz);
    if (t < 0) return null;
    const p: V3 = [ox + dx * t, oy + dy * t, oz + dz * t];
    this.body.sample(c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]);
    const g = this.body;
    return { t, p, n: [c * g.gx + s * g.gz, g.gy, -s * g.gx + c * g.gz], surface: 'head' };
  }

  /** Nearest lock surface along a ray (locks treated as capsules around their nodes). */
  hitHair(ray: Ray): Hit | null {
    const L = this.L, pos = this.sim.pos;
    const [ox, oy, oz, dx, dy, dz] = ray;
    let best = Infinity, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < L.count; i++) {
      const len = L.len[i], seg = L.seg[i], r = L.radius[i] * 0.95;
      const b = i * NODES * 3;
      // Quick reject: the whole lock fits in a sphere around its root.
      const qx = pos[b] - ox, qy = pos[b + 1] - oy, qz = pos[b + 2] - oz;
      const tq = qx * dx + qy * dy + qz * dz;
      const reach = len * seg + r;
      if (qx * qx + qy * qy + qz * qz - tq * tq > reach * reach) continue;
      const segs = Math.ceil(len - 1e-6);
      for (let j = 0; j < segs; j++) {
        const o = b + j * 3;
        const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
        const f = Math.min(1, len - j);
        const ex = (pos[o + 3] - ax) * f, ey = (pos[o + 4] - ay) * f, ez = (pos[o + 5] - az) * f;
        // Closest points between the ray and the segment.
        const wx = ox - ax, wy = oy - ay, wz = oz - az;
        const bb = dx * ex + dy * ey + dz * ez, cc = ex * ex + ey * ey + ez * ez;
        const dd = dx * wx + dy * wy + dz * wz, ee = ex * wx + ey * wy + ez * wz;
        const den = cc - bb * bb;
        let u = den > 1e-12 ? (ee - bb * dd) / den : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = ax + ex * u, py = ay + ey * u, pz = az + ez * u;
        const t = (px - ox) * dx + (py - oy) * dy + (pz - oz) * dz;
        if (t <= 0) continue;
        const mx = ox + dx * t - px, my = oy + dy * t - py, mz = oz + dz * t - pz;
        const m2 = mx * mx + my * my + mz * mz;
        if (m2 > r * r) continue;
        const tHit = t - Math.sqrt(r * r - m2);
        if (tHit < best) {
          best = tHit;
          bx = ox + dx * tHit; by = oy + dy * tHit; bz = oz + dz * tHit;
          cx = px; cy = py; cz = pz;
        }
      }
    }
    if (best === Infinity) return null;
    let nx = bx - cx, ny = by - cy, nz = bz - cz;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; } else { nx = -dx; ny = -dy; nz = -dz; }
    return { t: best, p: [bx, by, bz], n: [nx, ny, nz], surface: 'hair' };
  }

  // ---------------------------------------------------------------- strokes

  /** Applies one stroke update and returns what is under the pointer (for the brush cursor). */
  strokeStep(inp: StrokeInput): Hit | null {
    if (inp.phase === 'begin') {
      if (this.history.inStroke) this.endStroke();
      this.history.begin();
      this.stroke = {
        tool: inp.tool, prevRay: null, prevP: null, prevT: 0, plane: null, held: new Map(), done: new Set(),
        set: COMB_SET * (0.4 + 0.6 * inp.strength),
      };
    }
    const st = this.stroke;
    const hit = this.pick(inp.ray);
    if (!st) return hit;
    switch (st.tool) {
      case 'scissors': this.scissors(st, inp); break;
      case 'clippers': this.clippers(inp, hit); break;
      case 'comb': this.comb(st, inp, hit); break;
      case 'grow': this.grow(inp, hit); break;
      case 'extrude': this.extrude(st, inp, hit); break;
    }
    if (inp.phase === 'end') this.endStroke();
    return hit;
  }

  private endStroke(): void {
    const st = this.stroke;
    // Held locks keep their new shape; pulled ones are set firmly so they stay out.
    if (st) for (const h of [...st.held.values()]) this.release(st, h, st.tool === 'extrude' ? 0.9 : st.set);
    this.history.commit();
    this.stroke = null;
    this.sim.wake();
  }

  undo(): boolean {
    if (this.history.inStroke) this.endStroke();
    return this.restored(this.history.undo());
  }

  redo(): boolean {
    if (this.history.inStroke) this.endStroke();
    return this.restored(this.history.redo());
  }

  /** Back to the starting hair, as one undoable step. */
  reset(): boolean {
    if (this.history.inStroke) this.endStroke();
    const L = this.L, init = this.initial;
    this.history.begin();
    for (let i = 0; i < L.count; i++) this.history.touch(i);
    L.rest.set(init.rest);
    L.len.set(init.len);
    L.hold.set(init.hold);
    L.blunt.set(init.blunt);
    L.color.set(init.color);
    const changed = this.history.commit();
    for (let i = 0; i < L.count; i++) this.sim.snap(i);
    this.dirty = true;
    return changed;
  }

  private restored(locks: Int32Array | null): boolean {
    if (!locks) return false;
    for (const i of locks) this.sim.snap(i);
    this.dirty = true;
    return true;
  }

  // ---------------------------------------------------------------- helpers

  private toHead(p: readonly number[]): V3 {
    const c = this.sim.cos, s = this.sim.sin;
    return [c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]];
  }

  private toWorld(p: readonly number[]): V3 {
    const c = this.sim.cos, s = this.sim.sin;
    return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
  }

  /** Reflects a world point (or direction) across the face's centre plane. */
  private mirrorP(p: readonly number[]): V3 {
    const h = this.toHead(p);
    return this.toWorld([-h[0], h[1], h[2]]);
  }

  /** Mirror unless the brush already straddles the centre line. */
  private mirrors(inp: StrokeInput, p: readonly number[]): boolean {
    return inp.mirror && Math.abs(this.toHead(p)[0]) > inp.radius * 0.35;
  }

  /** Point on lock `i` at `t` segments from the root (linear between nodes). */
  private pointAt(i: number, t: number): V3 {
    const pos = this.sim.pos, b = i * NODES * 3;
    const j = Math.min(Math.floor(t), NODES - 2), f = t - j, o = b + j * 3;
    return [pos[o] + (pos[o + 3] - pos[o]) * f, pos[o + 1] + (pos[o + 4] - pos[o + 1]) * f, pos[o + 2] + (pos[o + 5] - pos[o + 2]) * f];
  }

  /**
   * Locks passing within `r` of a world point: the closest distance and where
   * along the lock (segments from the root) that closest point is.
   */
  private near(cx: number, cy: number, cz: number, r: number, out: { i: number; d: number; t: number }[]): void {
    const L = this.L, pos = this.sim.pos;
    for (let i = 0; i < L.count; i++) {
      const len = L.len[i], b = i * NODES * 3;
      const rx = pos[b] - cx, ry = pos[b + 1] - cy, rz = pos[b + 2] - cz;
      const reach = len * L.seg[i] + r;
      if (rx * rx + ry * ry + rz * rz > reach * reach) continue;
      let best = Infinity, bt = 0;
      const segs = Math.ceil(len - 1e-6);
      for (let j = 0; j < segs; j++) {
        const o = b + j * 3;
        const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
        const f = Math.min(1, len - j);
        const ex = (pos[o + 3] - ax) * f, ey = (pos[o + 4] - ay) * f, ez = (pos[o + 5] - az) * f;
        const cc = ex * ex + ey * ey + ez * ez;
        let u = cc > 1e-12 ? ((cx - ax) * ex + (cy - ay) * ey + (cz - az) * ez) / cc : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const qx = ax + ex * u - cx, qy = ay + ey * u - cy, qz = az + ez * u - cz;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 < best) {
          best = d2;
          bt = j + u * f;
        }
      }
      // Count a lock's thickness: brushing its surface reaches it.
      const d = Math.max(0, Math.sqrt(best) - L.radius[i]);
      if (d < r) out.push({ i, d, t: bt });
    }
  }

  /** Brush centres for this stroke update: the hit, plus its mirror image. */
  private centres(inp: StrokeInput, p: V3): { p: V3; mirrored: boolean }[] {
    const list = [{ p, mirrored: false }];
    if (this.mirrors(inp, p)) list.push({ p: this.mirrorP(p), mirrored: true });
    return list;
  }

  /** Shortens lock `i` to `t` segments; the cut-off part falls away. */
  private cut(i: number, t: number): void {
    const L = this.L, len = L.len[i];
    t = Math.max(MIN_LEN, t);
    if (t >= len - 0.02) return;
    this.history.touch(i);
    // The falling piece: from the cut to the tip, moving as the lock was.
    const pts: number[] = [...this.pointAt(i, t)];
    for (let j = Math.floor(t) + 1; j < len; j++) pts.push(...this.pointAt(i, j));
    pts.push(...this.pointAt(i, len));
    const pos = this.sim.pos, prev = this.sim.prev, tip = (i * NODES + lastNode(len)) * 3;
    const h = this.toHead(this.pointAt(i, t));
    const out = Math.hypot(h[0], h[2]) || 1;
    const kick = this.toWorld([(h[0] / out) * 0.25, 0.15, (h[2] / out) * 0.25]);
    this.debris.spawn({
      points: Float32Array.from(pts),
      vx: (pos[tip] - prev[tip]) / STEP * 0.5 + kick[0],
      vy: (pos[tip + 1] - prev[tip + 1]) / STEP * 0.5 + kick[1],
      vz: (pos[tip + 2] - prev[tip + 2]) / STEP * 0.5 + kick[2],
      seg: L.seg[i], radius: L.radius[i], color: L.color[i], tStart: t, fullLen: len, blunt: L.blunt[i],
    });
    L.len[i] = t;
    L.blunt[i] = 1;
    this.dirty = true;
    this.sim.wake();
  }

  // ---------------------------------------------------------------- tools

  /**
   * Scissors: the blade sweeps the surface between the previous and current
   * view rays. Every lock crossing it is cut there, up to the skin (hair
   * hidden behind the head is safe).
   */
  private scissors(st: Stroke, inp: StrokeInput): void {
    const prev = st.prevRay;
    if (!prev) {
      st.prevRay = inp.ray;
      return;
    }
    const r1 = inp.ray;
    const angle = Math.hypot(r1[3] - prev[3], r1[4] - prev[4], r1[5] - prev[5]);
    if (angle < 0.0015) return; // wait until the blade has moved
    const n = Math.max(1, Math.ceil(angle / 0.006));
    let a: Ray = prev;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const ddx = prev[3] + (r1[3] - prev[3]) * f, ddy = prev[4] + (r1[4] - prev[4]) * f, ddz = prev[5] + (r1[5] - prev[5]) * f;
      const l = Math.hypot(ddx, ddy, ddz);
      const b: Ray = [r1[0], r1[1], r1[2], ddx / l, ddy / l, ddz / l];
      this.sweep(a, b);
      if (inp.mirror) {
        const ma = this.mirrorRay(a), mb = this.mirrorRay(b);
        this.sweep(ma, mb);
      }
      a = b;
    }
    st.prevRay = r1;
  }

  private mirrorRay(r: Ray): Ray {
    const o = this.mirrorP([r[0], r[1], r[2]]);
    const e = this.mirrorP([r[0] + r[3], r[1] + r[4], r[2] + r[5]]);
    return [o[0], o[1], o[2], e[0] - o[0], e[1] - o[1], e[2] - o[2]];
  }

  /** Cuts every lock crossing the triangle between two rays from the same eye, stopping at the skin. */
  private sweep(a: Ray, b: Ray): void {
    const far = (r: Ray) => {
      const h = this.hitHead(r);
      return h ? h.t : 3;
    };
    const fa = far(a), fb = far(b);
    const ox = a[0], oy = a[1], oz = a[2];
    const e1x = a[3] * fa, e1y = a[4] * fa, e1z = a[5] * fa;
    const e2x = b[3] * fb, e2y = b[4] * fb, e2z = b[5] * fb;
    const L = this.L, pos = this.sim.pos;
    for (let i = 0; i < L.count; i++) {
      const len = L.len[i];
      if (len <= MIN_LEN + 0.02) continue;
      const base = i * NODES * 3, segs = Math.ceil(len - 1e-6);
      for (let j = 0; j < segs; j++) {
        const o = base + j * 3;
        const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
        const f = Math.min(1, len - j);
        const dx = (pos[o + 3] - px) * f, dy = (pos[o + 4] - py) * f, dz = (pos[o + 5] - pz) * f;
        // Segment vs triangle (Möller–Trumbore).
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-14) continue;
        const inv = 1 / det;
        const sx = px - ox, sy = py - oy, sz = pz - oz;
        const u = (sx * hx + sy * hy + sz * hz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const w = -(e2x * qx + e2y * qy + e2z * qz) * inv;
        if (w < 0 || w > 1) continue;
        this.cut(i, j + w * f);
        break;
      }
    }
  }

  /**
   * Clippers: hair they touch is cut where it is touched, and everything
   * rooted on the skin under them is buzzed down to the guard length.
   */
  private clippers(inp: StrokeInput, hit: Hit | null): void {
    if (!hit) return;
    const L = this.L;
    const guard = (i: number) => (inp.guard + ROOT_DEPTH) / L.seg[i];
    if (hit.surface === 'hair') {
      for (const { p } of this.centres(inp, hit.p)) {
        const found: { i: number; d: number; t: number }[] = [];
        this.near(p[0], p[1], p[2], inp.radius * 0.6, found);
        for (const f of found) this.cut(f.i, Math.max(guard(f.i), f.t - 0.2));
      }
    }
    const skin = hit.surface === 'head' ? hit : this.hitHead(inp.ray);
    if (!skin) return;
    for (const { p } of this.centres(inp, skin.p)) {
      const h = this.toHead(p);
      for (let i = 0; i < L.count; i++) {
        const dx = L.root[i * 3] - h[0], dy = L.root[i * 3 + 1] - h[1], dz = L.root[i * 3 + 2] - h[2];
        if (dx * dx + dy * dy + dz * dz < inp.radius * inp.radius) this.cut(i, guard(i));
      }
    }
  }

  /**
   * Comb: locks the teeth pass through are caught and dragged along. Each
   * caught lock is laid from its root to the point the comb holds (wrapping
   * over the head, never through it) while the rest trails behind; the hair
   * slides through the teeth until the tip slips out. Combed hair keeps its
   * new shape a little.
   */
  private comb(st: Stroke, inp: StrokeInput, hit: Hit | null): void {
    const r = inp.ray;
    let p: V3 | null = null;
    if (hit) {
      p = hit.p;
      st.prevT = hit.t;
    } else if (st.prevP) {
      // Off the edge of the hair: keep combing at the same depth.
      p = [r[0] + r[3] * st.prevT, r[1] + r[4] * st.prevT, r[2] + r[5] * st.prevT];
    }
    if (!p) return;
    const from = st.prevP;
    st.prevP = p;
    if (!from) return;
    const delta: V3 = [p[0] - from[0], p[1] - from[1], p[2] - from[2]];
    const dl = Math.hypot(...delta);
    if (dl < 1e-5 || dl > inp.radius * 4) return;
    this.combAt(st, from, delta, inp, false);
    if (this.mirrors(inp, from)) {
      const mf = this.mirrorP(from), mt = this.mirrorP([from[0] + delta[0], from[1] + delta[1], from[2] + delta[2]]);
      this.combAt(st, mf, [mt[0] - mf[0], mt[1] - mf[1], mt[2] - mf[2]], inp, true);
    }
  }

  private combAt(st: Stroke, c: V3, delta: V3, inp: StrokeInput, mirrored: boolean): void {
    const found: { i: number; d: number; t: number }[] = [];
    this.near(c[0], c[1], c[2], inp.radius, found);
    // Lower strength catches only the locks near the middle of the comb.
    const catchW = 0.5 - 0.45 * inp.strength;
    for (const f of found) {
      if (st.held.has(f.i) || st.done.has(f.i) || falloff(f.d, inp.radius) < catchW) continue;
      this.history.touch(f.i);
      const [x, y, z] = this.pointAt(f.i, f.t);
      st.held.set(f.i, { i: f.i, x, y, z, ox: x, oy: y, oz: z, w: 1, mirrored });
    }
    for (const h of [...st.held.values()]) {
      if (h.mirrored !== mirrored) continue;
      h.x += delta[0]; h.y += delta[1]; h.z += delta[2];
      if (!this.shapeTo(h.i, h.x, h.y, h.z, false)) this.release(st, h, st.set);
    }
    this.dirty = true;
    this.sim.wake();
  }

  /**
   * Lays lock `i` from its root to the world point T: an arc bulging away
   * from the head, wrapped over the skin, held there until released. The
   * lock is held at the node whose distance along it matches the reach, so
   * the rest trails beyond. When `grow` is set the lock lengthens to reach;
   * otherwise returns false once T is beyond the tip (the hair slipped free).
   */
  private shapeTo(i: number, tx: number, ty: number, tz: number, grow: boolean): boolean {
    const L = this.L, pos = this.sim.pos, prev = this.sim.prev, pin = this.sim.pin, body = this.body;
    const cs = this.sim.cos, sn = this.sim.sin;
    const seg = L.seg[i], b = i * NODES * 3;
    const rx = pos[b], ry = pos[b + 1], rz = pos[b + 2];
    let cx = tx - rx, cy = ty - ry, cz = tz - rz;
    const chord = Math.hypot(cx, cy, cz);
    const need = chord / (seg * 0.98);
    if (grow && need > L.len[i]) {
      const before = L.len[i];
      L.len[i] = Math.min(NODES - 1, need);
      L.blunt[i] = Math.max(0, L.blunt[i] - (L.len[i] - before) * 0.8);
    }
    const last = lastNode(L.len[i]);
    if (!grow && need > L.len[i] + 0.5) return false;
    const g = Math.max(1, Math.min(last, Math.ceil(need)));
    const s = g * seg;
    // Arc in the plane of the chord and the skin normal at the root.
    const out = this.toWorld([L.normal[i * 3], L.normal[i * 3 + 1], L.normal[i * 3 + 2]]);
    if (chord < 1e-6) {
      cx = out[0]; cy = out[1]; cz = out[2];
    } else {
      cx /= chord; cy /= chord; cz /= chord;
    }
    const dot = out[0] * cx + out[1] * cy + out[2] * cz;
    let bx = out[0] - cx * dot, by = out[1] - cy * dot, bz = out[2] - cz * dot;
    const bl = Math.hypot(bx, by, bz);
    if (bl < 1e-4) {
      if (Math.abs(cy) < 0.9) { bx = -cz; by = 0; bz = cx; } else { bx = 0; by = cz; bz = -cy; }
      const l = Math.hypot(bx, by, bz) || 1;
      bx /= l; by /= l; bz /= l;
    } else {
      bx /= bl; by /= bl; bz /= bl;
    }
    const c = Math.min(chord, s);
    // Half-angle θ with sin(θ)/θ = c/s (bisection), limited so the arc never loops back.
    let theta = 0;
    if (c < s * 0.999) {
      let lo = 1e-4, hi = 2.6;
      const q = c / s;
      for (let it = 0; it < 30; it++) {
        const m = (lo + hi) / 2;
        if (Math.sin(m) / m > q) lo = m;
        else hi = m;
      }
      theta = (lo + hi) / 2;
    }
    const mx = rx + cx * c * 0.5, my = ry + cy * c * 0.5, mz = rz + cz * c * 0.5;
    const off = L.offset[i];
    for (let j = 1; j <= g; j++) {
      const o = b + j * 3;
      let ax: number, ay: number;
      if (theta < 1e-3) {
        ax = -c * 0.5 + (c * j) / g;
        ay = 0;
      } else {
        const rho = c / (2 * Math.sin(theta)), phi = -theta + (2 * theta * j) / g;
        ax = rho * Math.sin(phi);
        ay = rho * (Math.cos(phi) - Math.cos(theta));
      }
      let nx = mx + cx * ax + bx * ay, ny = my + cy * ax + by * ay, nz = mz + cz * ax + bz * ay;
      // Wrap over the head: push out of the skin and keep the segment its length.
      const px = pos[o - 3], py = pos[o - 2], pz = pos[o - 1];
      for (let it = 0; it < 3; it++) {
        const want = j === 1 ? off * 0.5 : off;
        const d = body.sample(cs * nx - sn * nz, ny, sn * nx + cs * nz);
        if (d >= want) break;
        nx += (cs * body.gx + sn * body.gz) * (want - d);
        ny += body.gy * (want - d);
        nz += (-sn * body.gx + cs * body.gz) * (want - d);
        const ex = nx - px, ey = ny - py, ez = nz - pz, el = Math.hypot(ex, ey, ez) || 1;
        nx = px + (ex / el) * seg; ny = py + (ey / el) * seg; nz = pz + (ez / el) * seg;
      }
      pos[o] = prev[o] = nx; pos[o + 1] = prev[o + 1] = ny; pos[o + 2] = prev[o + 2] = nz;
    }
    pin.fill(1, i * NODES + 1, i * NODES + g + 1);
    pin.fill(0, i * NODES + g + 1, (i + 1) * NODES);
    this.sim.setRestFromPose(i);
    return true;
  }

  /** Lets go of a held lock: it keeps its new shape, set to at least `hold`. */
  private release(st: Stroke, h: Held, hold: number): void {
    const L = this.L;
    this.sim.pin.fill(0, h.i * NODES, (h.i + 1) * NODES);
    this.sim.setRestFromPose(h.i);
    if (L.hold[h.i] < hold) L.hold[h.i] = hold;
    st.held.delete(h.i);
    st.done.add(h.i);
  }

  /** Grow: locks under the brush get longer (also stubble on bare scalp). */
  private grow(inp: StrokeInput, hit: Hit | null): void {
    if (!hit) return;
    const L = this.L;
    const dt = Math.min(Math.max(inp.dt, 0), 0.05);
    for (const { p } of this.centres(inp, hit.p)) {
      const found: { i: number; d: number; t: number }[] = [];
      this.near(p[0], p[1], p[2], inp.radius, found);
      // On bare skin, the stubble rooted under the brush.
      if (hit.surface === 'head') {
        const h = this.toHead(p);
        const r2 = inp.radius * inp.radius;
        for (let i = 0; i < L.count; i++) {
          const dx = L.root[i * 3] - h[0], dy = L.root[i * 3 + 1] - h[1], dz = L.root[i * 3 + 2] - h[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2 && !found.some((f) => f.i === i)) found.push({ i, d: Math.sqrt(d2), t: 0 });
        }
      }
      for (const { i, d } of found) {
        const w = falloff(d, inp.radius);
        if (w <= 0) continue;
        this.lengthen(i, (GROW_SPEED * dt * (0.25 + 0.75 * inp.strength) * w) / L.seg[i]);
      }
    }
  }

  /** Adds `by` segments to lock `i`, continuing its direction (drooping a little unless it is set firmly). */
  private lengthen(i: number, by: number): number {
    const L = this.L;
    const len = L.len[i], target = Math.min(NODES - 1, len + by);
    if (target <= len) return 0;
    this.history.touch(i);
    const pos = this.sim.pos, prev = this.sim.prev, b = i * NODES * 3;
    const oldLast = lastNode(len), newLast = lastNode(target);
    for (let j = oldLast + 1; j <= newLast; j++) {
      const o = b + j * 3;
      let dx = pos[o - 3] - pos[o - 6], dy = pos[o - 2] - pos[o - 5], dz = pos[o - 1] - pos[o - 4];
      const l = Math.hypot(dx, dy, dz) || 1;
      const droop = 0.3 * (1 - L.hold[i]);
      dx = dx / l; dy = dy / l - droop; dz = dz / l;
      const l2 = Math.hypot(dx, dy, dz) || 1, seg = L.seg[i];
      pos[o] = prev[o] = pos[o - 3] + (dx / l2) * seg;
      pos[o + 1] = prev[o + 1] = pos[o - 2] + (dy / l2) * seg;
      pos[o + 2] = prev[o + 2] = pos[o - 1] + (dz / l2) * seg;
      const h = this.toHead([pos[o], pos[o + 1], pos[o + 2]]);
      L.rest[o] = h[0]; L.rest[o + 1] = h[1]; L.rest[o + 2] = h[2];
    }
    L.len[i] = target;
    // A cut end grows back into a natural tip.
    L.blunt[i] = Math.max(0, L.blunt[i] - (target - len) * 0.8);
    this.dirty = true;
    this.sim.wake();
    return target - len;
  }


  /**
   * Extrude: grab the hair under the pointer and pull. Each lock is laid from
   * its root to where its grabbed point is pulled (growing if it has to reach
   * further), and on release it is set firmly so it stays: spikes, flicks, wings.
   */
  private extrude(st: Stroke, inp: StrokeInput, hit: Hit | null): void {
    if (inp.phase === 'begin') {
      if (!hit) return;
      st.plane = { p: hit.p, n: [-inp.ray[3], -inp.ray[4], -inp.ray[5]] };
      for (const { p, mirrored } of this.centres(inp, hit.p)) this.grabAt(st, p, inp.radius, hit.surface === 'head', mirrored);
      return;
    }
    const plane = st.plane;
    if (!plane || !st.held.size) return;
    const r = inp.ray;
    const denom = r[3] * plane.n[0] + r[4] * plane.n[1] + r[5] * plane.n[2];
    if (Math.abs(denom) < 1e-6) return;
    const t = ((plane.p[0] - r[0]) * plane.n[0] + (plane.p[1] - r[1]) * plane.n[1] + (plane.p[2] - r[2]) * plane.n[2]) / denom;
    if (t <= 0) return;
    const D: V3 = [r[0] + r[3] * t - plane.p[0], r[1] + r[4] * t - plane.p[1], r[2] + r[5] * t - plane.p[2]];
    const M = this.mirrorP(D); // the mirror plane passes through the origin, so this mirrors the vector
    for (const h of st.held.values()) {
      const d = h.mirrored ? M : D;
      this.shapeTo(h.i, h.ox + d[0] * h.w, h.oy + d[1] * h.w, h.oz + d[2] * h.w, true);
    }
    this.dirty = true;
    this.sim.wake();
  }

  private grabAt(st: Stroke, p: V3, radius: number, onSkin: boolean, mirrored: boolean): void {
    const L = this.L;
    const found: { i: number; d: number; t: number }[] = [];
    this.near(p[0], p[1], p[2], radius, found);
    if (onSkin) {
      // On bare skin: the stubble rooted under the pointer (pulled from its tip).
      const h = this.toHead(p);
      for (let i = 0; i < L.count; i++) {
        const dx = L.root[i * 3] - h[0], dy = L.root[i * 3 + 1] - h[1], dz = L.root[i * 3 + 2] - h[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < radius && !found.some((f) => f.i === i)) found.push({ i, d, t: L.len[i] });
      }
    }
    found.sort((a, b) => a.d - b.d);
    for (const f of found.slice(0, MAX_GRAB)) {
      if (st.held.has(f.i)) continue;
      this.history.touch(f.i);
      const [x, y, z] = this.pointAt(f.i, Math.max(f.t, Math.min(1, L.len[f.i])));
      // Locks at the edge of the brush follow less, so pulls taper into a point.
      st.held.set(f.i, { i: f.i, x, y, z, ox: x, oy: y, oz: z, w: falloff(f.d, radius) * 0.85 + 0.15, mirrored });
    }
  }
}
