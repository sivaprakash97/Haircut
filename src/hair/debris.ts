import type { Body } from './body';
import { NODES } from './locks';
import { STEP } from './sim';

// Pieces of hair that were cut off. Each is a free chain (no root) that
// falls, slides off the shoulders and shrinks away. They are drawn by the
// same lock renderer, in the rows after the real locks.

export const DEBRIS = 160;
const LIFE = 1.7;
const FADE = 0.45;
const GRAVITY = 7;

export interface Piece {
  /** World positions along the cut-off part, root end first (any spacing). */
  points: Float32Array;
  /** Velocity to start with (m/s). */
  vx: number;
  vy: number;
  vz: number;
  seg: number;
  radius: number;
  color: number;
  /** Where the piece started on its lock (segments from the root) and that lock's length, so its taper matches. */
  tStart: number;
  fullLen: number;
  blunt: number;
}

export class DebrisPool {
  readonly pos = new Float32Array(DEBRIS * NODES * 3);
  readonly prev = new Float32Array(DEBRIS * NODES * 3);
  /** Visible length in segments; 0 for a free slot. */
  readonly len = new Float32Array(DEBRIS);
  readonly seg = new Float32Array(DEBRIS);
  readonly radius = new Float32Array(DEBRIS);
  readonly color = new Uint32Array(DEBRIS);
  readonly tStart = new Float32Array(DEBRIS);
  readonly fullLen = new Float32Array(DEBRIS);
  readonly blunt = new Float32Array(DEBRIS);
  /** Seconds since the piece was cut. */
  readonly age = new Float32Array(DEBRIS);
  private next = 0;
  active = 0;

  /** Size multiplier while a piece shrinks away at the end of its life. */
  scale(k: number): number {
    return Math.min(1, (LIFE - this.age[k]) / FADE);
  }

  spawn(p: Piece): void {
    // Reuse the oldest slot when all are busy.
    let k = -1;
    for (let n = 0; n < DEBRIS; n++) {
      const c = (this.next + n) % DEBRIS;
      if (this.len[c] === 0) {
        k = c;
        break;
      }
    }
    if (k < 0) k = this.next;
    this.next = (k + 1) % DEBRIS;
    if (this.len[k] === 0) this.active++;

    // Resample the piece at even spacing so it can be simulated like a lock.
    const pts = p.points, n = pts.length / 3, seg = p.seg;
    const b = k * NODES * 3;
    this.pos[b] = pts[0]; this.pos[b + 1] = pts[1]; this.pos[b + 2] = pts[2];
    let count = 1, acc = 0, want = seg;
    for (let i = 1; i < n; i++) {
      const ax = pts[i * 3 - 3], ay = pts[i * 3 - 2], az = pts[i * 3 - 1];
      const dx = pts[i * 3] - ax, dy = pts[i * 3 + 1] - ay, dz = pts[i * 3 + 2] - az;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      while (want <= acc + l && count < NODES) {
        const f = (want - acc) / l, o = b + count * 3;
        this.pos[o] = ax + dx * f; this.pos[o + 1] = ay + dy * f; this.pos[o + 2] = az + dz * f;
        count++;
        want += seg;
      }
      acc += l;
    }
    const len = Math.max(0.05, Math.min(acc / seg, NODES - 1));
    if (count - 1 < Math.ceil(len - 1e-6) && count < NODES) {
      // One more node past the end so the partial last segment has somewhere to end.
      const e = (n - 1) * 3;
      let dx = pts[e] - pts[0], dy = pts[e + 1] - pts[1], dz = pts[e + 2] - pts[2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l > 1e-6) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = -1; dz = 0; }
      const o = b + count * 3, a = o - 3;
      this.pos[o] = this.pos[a] + dx * seg;
      this.pos[o + 1] = this.pos[a + 1] + dy * seg;
      this.pos[o + 2] = this.pos[a + 2] + dz * seg;
      count++;
    }
    for (let j = 0; j < count; j++) {
      const o = b + j * 3;
      this.prev[o] = this.pos[o] - p.vx * STEP;
      this.prev[o + 1] = this.pos[o + 1] - p.vy * STEP;
      this.prev[o + 2] = this.pos[o + 2] - p.vz * STEP;
    }
    this.len[k] = Math.min(len, count - 1);
    this.seg[k] = seg;
    this.radius[k] = p.radius;
    this.color[k] = p.color;
    this.tStart[k] = p.tStart;
    this.fullLen[k] = p.fullLen;
    this.blunt[k] = p.blunt;
    this.age[k] = 0;
  }

  /** Advances every falling piece one step; false when none are left. */
  step(body: Body, c: number, s: number): boolean {
    if (!this.active) return false;
    const pos = this.pos, prev = this.prev;
    const g = GRAVITY * STEP * STEP;
    for (let k = 0; k < DEBRIS; k++) {
      if (this.len[k] === 0) continue;
      this.age[k] += STEP;
      if (this.age[k] >= LIFE) {
        this.len[k] = 0;
        this.active--;
        continue;
      }
      const b = k * NODES * 3, last = Math.min(NODES - 1, Math.ceil(this.len[k] - 1e-6)), seg = this.seg[k];
      for (let j = 0, o = b; j <= last; j++, o += 3) {
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        pos[o] = x + (x - prev[o]) * 0.985;
        pos[o + 1] = y + (y - prev[o + 1]) * 0.985 - g;
        pos[o + 2] = z + (z - prev[o + 2]) * 0.985;
        prev[o] = x; prev[o + 1] = y; prev[o + 2] = z;
      }
      for (let j = 1, o = b + 3; j <= last; j++, o += 3) {
        const dx = pos[o] - pos[o - 3], dy = pos[o + 1] - pos[o - 2], dz = pos[o + 2] - pos[o - 1];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        // Split the correction between both ends: a free piece has no root to hang from.
        const f = (1 - seg / l) * 0.5;
        pos[o] -= dx * f; pos[o + 1] -= dy * f; pos[o + 2] -= dz * f;
        pos[o - 3] += dx * f; pos[o - 2] += dy * f; pos[o - 1] += dz * f;
      }
      for (let j = 0, o = b; j <= last; j++, o += 3) {
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        const d = body.sample(c * x - s * z, y, s * x + c * z);
        const want = this.radius[k] * 0.6;
        if (d < want) {
          const push = want - d, nx = body.gx, nz = body.gz;
          pos[o] += (c * nx + s * nz) * push;
          pos[o + 1] += body.gy * push;
          pos[o + 2] += (-s * nx + c * nz) * push;
          prev[o] += (pos[o] - prev[o]) * 0.3;
          prev[o + 1] += (pos[o + 1] - prev[o + 1]) * 0.3;
          prev[o + 2] += (pos[o + 2] - prev[o + 2]) * 0.3;
        }
      }
    }
    return this.active > 0;
  }

  clear(): void {
    this.len.fill(0);
    this.active = 0;
  }
}
