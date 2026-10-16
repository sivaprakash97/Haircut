import type { Body } from './body';
import { KIND_BEARD, NODES, type LockData, lastNode } from './locks';

// Lock physics: each lock is an inextensible chain ("follow the leader",
// Müller et al. 2012, with its velocity correction), pulled by gravity and
// gently back toward its styled rest shape, and pushed out of the body.
// One fixed 1/60 s step per display frame; the page stops drawing once
// everything has settled.

export const STEP = 1 / 60;
const GRAVITY = 9.8;
/** Velocity kept per step (air drag). */
const DAMP = 0.95;
/** Share of each length correction fed back as damping (the paper's s_damp). */
const DFTL = 0.5;
/** Share of velocity lost when a node touches the skin. */
const FRICTION = 0.25;
/** How strongly hair that is fully set (hold 1) returns to its rest shape each step. */
const K_SET = 0.45;
/** Average movement (metres per step) below which hair counts as still. */
const STILL = 1e-5;
/**
 * Static friction: a node that would move less than this in a step stays put.
 * Stops slow creep and sub-pixel jitter so the hair comes fully to rest.
 */
const STICK = 2.5e-5;

/**
 * How strongly loose hair returns to its rest shape, per node: firm at the
 * root, so hair lifts off the scalp before it falls, and soft toward the tip,
 * so it swings. Beards are springier.
 */
const K_SCALP = new Float32Array(NODES);
const K_BEARD = new Float32Array(NODES);
for (let j = 1; j < NODES; j++) {
  K_SCALP[j] = 0.012 + 0.32 * Math.exp(-(j - 1) / 1.0);
  K_BEARD[j] = 0.03 + 0.4 * Math.exp(-(j - 1) / 1.6);
}

export class Sim {
  /** Node positions, world space, NODES × 3 per lock. */
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  /** Nodes a tool is holding; physics leaves them where they are. */
  readonly pin: Uint8Array;
  /** Positions at the start of the step, to measure how much the hair actually moved. */
  private readonly old: Float32Array;
  yaw = 0;
  private c = 1;
  private s = 0;
  asleep = false;
  private quiet = 0;
  /** Largest node movement in the last step (metres). */
  lastMove = 0;

  constructor(readonly L: LockData, readonly body: Body, yaw = 0) {
    const n = L.count * NODES * 3;
    this.pos = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.pin = new Uint8Array(L.count * NODES);
    this.old = new Float32Array(n);
    this.setYaw(yaw);
    for (let i = 0; i < L.count; i++) this.snap(i);
  }

  get cos(): number {
    return this.c;
  }

  get sin(): number {
    return this.s;
  }

  setYaw(yaw: number): void {
    if (yaw === this.yaw) return;
    this.yaw = yaw;
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
    this.wake();
  }

  wake(): void {
    this.asleep = false;
    this.quiet = 0;
  }

  /** Puts lock `i` exactly on its rest shape, at rest (after undo, redo or reset). */
  snap(i: number): void {
    const rest = this.L.rest, pos = this.pos, prev = this.prev;
    const c = this.c, s = this.s;
    for (let j = 0, o = i * NODES * 3; j < NODES; j++, o += 3) {
      const x = rest[o], y = rest[o + 1], z = rest[o + 2];
      pos[o] = prev[o] = c * x + s * z;
      pos[o + 1] = prev[o + 1] = y;
      pos[o + 2] = prev[o + 2] = -s * x + c * z;
    }
    this.wake();
  }

  /** Copies the current shape of lock `i` (nodes `from`..last) into its rest shape. */
  setRestFromPose(i: number, from = 1, weight = 1): void {
    const rest = this.L.rest, pos = this.pos;
    const c = this.c, s = this.s;
    const last = lastNode(this.L.len[i]);
    for (let j = from, o = i * NODES * 3 + from * 3; j <= last; j++, o += 3) {
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      const hx = c * x - s * z, hz = s * x + c * z;
      rest[o] += (hx - rest[o]) * weight;
      rest[o + 1] += (y - rest[o + 1]) * weight;
      rest[o + 2] += (hz - rest[o + 2]) * weight;
    }
  }

  step(): void {
    if (this.asleep) return;
    const L = this.L, pos = this.pos, prev = this.prev, pin = this.pin, body = this.body, old = this.old;
    const rest = L.rest;
    const c = this.c, s = this.s;
    const g = GRAVITY * STEP * STEP;
    let move2 = 0, sum2 = 0, nodes = 0;

    for (let i = 0; i < L.count; i++) {
      const b = i * NODES * 3, bn = i * NODES;
      const last = lastNode(L.len[i]);
      const seg = L.seg[i], hold = L.hold[i];
      const K = L.kind[i] === KIND_BEARD ? K_BEARD : K_SCALP;
      const rx = L.root[i * 3], ry = L.root[i * 3 + 1], rz = L.root[i * 3 + 2];
      pos[b] = prev[b] = c * rx + s * rz;
      pos[b + 1] = prev[b + 1] = ry;
      pos[b + 2] = prev[b + 2] = -s * rx + c * rz;

      // Move: inertia, gravity, air, and a pull back toward the styled shape.
      for (let j = 1, o = b + 3; j <= last; j++, o += 3) {
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        old[o] = x; old[o + 1] = y; old[o + 2] = z;
        if (pin[bn + j]) {
          prev[o] = x; prev[o + 1] = y; prev[o + 2] = z;
          continue;
        }
        let px = x + (x - prev[o]) * DAMP;
        let py = y + (y - prev[o + 1]) * DAMP - g;
        let pz = z + (z - prev[o + 2]) * DAMP;
        const lx = rest[o], lz = rest[o + 2];
        const k = K[j] + (K_SET - K[j]) * hold;
        px += (c * lx + s * lz - px) * k;
        py += (rest[o + 1] - py) * k;
        pz += (-s * lx + c * lz - pz) * k;
        prev[o] = x; prev[o + 1] = y; prev[o + 2] = z;
        pos[o] = px; pos[o + 1] = py; pos[o + 2] = pz;
      }

      // Keep every segment its length, working out from the root.
      for (let j = 1, o = b + 3; j <= last; j++, o += 3) {
        if (pin[bn + j]) continue;
        const ax = pos[o - 3], ay = pos[o - 2], az = pos[o - 1];
        let dx = pos[o] - ax, dy = pos[o + 1] - ay, dz = pos[o + 2] - az;
        let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < 1e-9) {
          dx = 0; dy = -1; dz = 0; l = 1;
        }
        const f = seg / l;
        const nx = ax + dx * f, ny = ay + dy * f, nz = az + dz * f;
        const cx = nx - pos[o], cy = ny - pos[o + 1], cz = nz - pos[o + 2];
        pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz;
        if (j > 1 && !pin[bn + j - 1]) {
          prev[o - 3] += cx * DFTL;
          prev[o - 2] += cy * DFTL;
          prev[o - 1] += cz * DFTL;
        }
      }

      // Stay outside the head and shoulders (at this lock's layer).
      const off = L.offset[i];
      for (let j = 1, o = b + 3; j <= last; j++, o += 3) {
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        if (!pin[bn + j]) {
          const d = body.sample(c * x - s * z, y, s * x + c * z);
          const want = j === 1 ? off * 0.5 : off;
          if (d < want) {
            const push = want - d, nx = body.gx, nz = body.gz;
            pos[o] = x + (c * nx + s * nz) * push;
            pos[o + 1] = y + body.gy * push;
            pos[o + 2] = z + (-s * nx + c * nz) * push;
            prev[o] += (pos[o] - prev[o]) * FRICTION;
            prev[o + 1] += (pos[o + 1] - prev[o + 1]) * FRICTION;
            prev[o + 2] += (pos[o + 2] - prev[o + 2]) * FRICTION;
          }
        }
        const mx = pos[o] - old[o], my = pos[o + 1] - old[o + 1], mz = pos[o + 2] - old[o + 2];
        const m2 = mx * mx + my * my + mz * mz;
        if (m2 < STICK * STICK) {
          // Undo the tiny move but keep the velocity: at rest the chain's length
          // corrections leave a steady (cancelling) velocity that must survive.
          pos[o] = old[o]; pos[o + 1] = old[o + 1]; pos[o + 2] = old[o + 2];
          prev[o] -= mx; prev[o + 1] -= my; prev[o + 2] -= mz;
        } else {
          if (m2 > move2) move2 = m2;
          sum2 += m2;
        }
        nodes++;
      }
    }

    this.lastMove = Math.sqrt(move2);
    // Still when the hair as a whole has stopped (a few locks can trade tiny
    // nudges between the skin and their neighbours forever; those freeze too).
    const rms = Math.sqrt(sum2 / Math.max(1, nodes));
    if (rms < STILL && this.lastMove < 0.0006) {
      if (++this.quiet >= 30) this.asleep = true;
    } else {
      this.quiet = 0;
    }
  }
}
