import type { Body } from './body';
import { KIND_BEARD, KIND_SCALP, NODES, ROOT_DEPTH, type LockData } from './locks';
import { mulberry32 } from './random';
import { isBeard, isScalp, smoothstep } from './regions';
import { Sim } from './sim';

// The starting hair: one overgrown, shaggy head of hair and a full beard.
// Roots are spread evenly over the scalp and beard areas of the head (and
// mirrored, so the two sides match), each lock is draped from its root under
// gravity, then the physics settles them for a moment.

const SCALP_SEG = 0.016;
const BEARD_SEG = 0.009;
/** Closest two roots may be (metres). */
const SCALP_SPACING = 0.0095;
const BEARD_SPACING = 0.0068;
const SETTLE_STEPS = 45;

/** Dark indigo-brown: reads as black hair under toon shading but keeps its highlights. */
export const HAIR_COLOR = 0x3d3456;

interface Candidate {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  kind: number;
}

/** Points on the skin, found by casting from a point inside the head toward evenly spread directions (x ≥ 0 half only). */
function surfacePoints(
  body: Body, cx: number, cy: number, cz: number, start: number, count: number, kind: number,
  keep: (x: number, y: number, z: number) => boolean,
): Candidate[] {
  const out: Candidate[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const dy = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(1 - dy * dy);
    const dx = Math.cos(golden * i) * r, dz = Math.sin(golden * i) * r;
    if (dx < 0) continue;
    let t0 = start, t1 = -1;
    for (let t = start; t < 0.2; t += 0.004) {
      if (body.sample(cx + dx * t, cy + dy * t, cz + dz * t) > 0) {
        t1 = t;
        break;
      }
      t0 = t;
    }
    if (t1 < 0) continue;
    for (let k = 0; k < 10; k++) {
      const tm = (t0 + t1) / 2;
      if (body.sample(cx + dx * tm, cy + dy * tm, cz + dz * tm) > 0) t1 = tm;
      else t0 = tm;
    }
    const x = cx + dx * t1, y = cy + dy * t1, z = cz + dz * t1;
    if (!keep(x, y, z)) continue;
    body.sample(x, y, z);
    out.push({ x, y, z, nx: body.gx, ny: body.gy, nz: body.gz, kind });
  }
  return out;
}

export function generateLocks(body: Body, seed = 7): LockData {
  const rand = mulberry32(seed);
  const cands = [
    // Cast from inside the skull and the jaw; casts start where the skin cannot be yet.
    ...surfacePoints(body, 0, 0.03, -0.006, 0.05, 7000, KIND_SCALP, isScalp),
    ...surfacePoints(body, 0, -0.035, 0.012, 0.035, 6000, KIND_BEARD, isBeard),
  ];
  // Visit candidates in a random order; accept those far enough from every accepted root (and its mirror image).
  const order = cands.map((c) => ({ c, key: rand() })).sort((a, b) => a.key - b.key).map((e) => e.c);
  const spacing = (k: number) => (k === KIND_BEARD ? BEARD_SPACING : SCALP_SPACING);
  const cell = 0.01;
  const grid = new Map<string, Candidate[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const clear = (p: Candidate): boolean => {
    const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell), gz = Math.floor(p.z / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          for (const q of grid.get(`${gx + i},${gy + j},${gz + k}`) ?? []) {
            const min = (spacing(p.kind) + spacing(q.kind)) / 2;
            const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
            if (dx * dx + dy * dy + dz * dz < min * min) return false;
          }
        }
      }
    }
    return true;
  };
  const add = (p: Candidate) => {
    const k = keyOf(p.x, p.y, p.z);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(p);
  };

  const roots: Candidate[] = [];
  const mirrorOf: number[] = [];
  for (const p of order) {
    const centre = p.x < spacing(p.kind) * 0.45;
    if (centre) {
      // On the centre line: exactly symmetric, so it is its own mirror image.
      const l = Math.hypot(p.ny, p.nz) || 1;
      p.x = 0;
      p.nx = 0;
      p.ny /= l;
      p.nz /= l;
    }
    if (!clear(p)) continue;
    add(p);
    if (centre) {
      mirrorOf.push(roots.length);
      roots.push(p);
    } else {
      const m: Candidate = { ...p, x: -p.x, nx: -p.nx };
      add(m);
      mirrorOf.push(roots.length + 1, roots.length);
      roots.push(p, m);
    }
  }

  const count = roots.length;
  const L: LockData = {
    count,
    root: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    seg: new Float32Array(count),
    radius: new Float32Array(count),
    offset: new Float32Array(count),
    kind: new Uint8Array(count),
    mirror: Int32Array.from(mirrorOf),
    rest: new Float32Array(count * NODES * 3),
    len: new Float32Array(count),
    hold: new Float32Array(count),
    blunt: new Float32Array(count),
    color: new Uint32Array(count),
  };

  // Per-lock variation is drawn once per mirrored pair so both sides match.
  const vary = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const m = mirrorOf[i];
    if (m < i) {
      vary.copyWithin(i * 4, m * 4, m * 4 + 4);
      continue;
    }
    for (let k = 0; k < 4; k++) vary[i * 4 + k] = rand();
  }

  for (let i = 0; i < count; i++) {
    const p = roots[i];
    const v = (k: number) => vary[i * 4 + k];
    const a = Math.abs(Math.atan2(p.x, p.z));
    const beard = p.kind === KIND_BEARD;
    L.kind[i] = p.kind;
    L.root[i * 3] = p.x - p.nx * ROOT_DEPTH;
    L.root[i * 3 + 1] = p.y - p.ny * ROOT_DEPTH;
    L.root[i * 3 + 2] = p.z - p.nz * ROOT_DEPTH;
    L.normal.set([p.nx, p.ny, p.nz], i * 3);
    const seg = beard ? BEARD_SEG : SCALP_SEG;
    L.seg[i] = seg;
    L.radius[i] = (beard ? 0.0042 : 0.0058) * (0.85 + 0.3 * v(0));
    L.offset[i] = beard
      ? 0.0015 + L.radius[i] * 0.5
      : 0.002 + 0.011 * smoothstep(-0.05, 0.115, p.y) + L.radius[i] * 0.6;

    let length: number;
    if (beard) {
      const moustache = p.y > -0.046 && Math.abs(p.x) < 0.036 && p.z > 0.06;
      length = moustache ? 0.034 : 0.05 + 0.035 * smoothstep(-0.03, -0.09, p.y) * (1 - smoothstep(0.6, 1.3, a));
    } else {
      // Fringe to the eyebrows, longer over the ears, longest at the back.
      length = 0.085 + 0.16 * smoothstep(0.45, 2.5, a);
    }
    length *= 0.88 + 0.24 * v(1);
    L.len[i] = Math.min(NODES - 1, length / seg + 0.2);
    // Slight brightness variation lock to lock adds depth.
    const shade = 0.88 + 0.22 * v(2) - (beard ? 0.05 : 0);
    L.color[i] = scaleColor(HAIR_COLOR, shade);
    drape(body, L, i, v(3));
  }

  // Let the physics settle the draped hair, then make that the rest shape.
  const sim = new Sim(L, body);
  for (let k = 0; k < SETTLE_STEPS; k++) sim.step();
  for (let i = 0; i < count; i++) sim.setRestFromPose(i);
  return L;
}

/**
 * Builds a lock's starting shape: out along the skin normal, curving down
 * under gravity and away from the head, with a slight wave.
 */
function drape(body: Body, L: LockData, i: number, phase: number): void {
  const seg = L.seg[i], off = L.offset[i];
  const nx = L.normal[i * 3], ny = L.normal[i * 3 + 1], nz = L.normal[i * 3 + 2];
  const b = i * NODES * 3, rest = L.rest;
  rest[b] = L.root[i * 3];
  rest[b + 1] = L.root[i * 3 + 1];
  rest[b + 2] = L.root[i * 3 + 2];
  // Outward from the head's vertical axis, and a sideways direction for the wave.
  const ox = rest[b], oz = rest[b + 2] + 0.005;
  const ol = Math.hypot(ox, oz) || 1;
  const outX = ox / ol, outZ = oz / ol;
  const sideX = -outZ, sideZ = outX;
  let dx = nx, dy = ny, dz = nz;
  for (let j = 1; j < NODES; j++) {
    const fall = Math.min(1, 0.2 + j * 0.4);
    const wave = 0.22 * Math.sin(j * 0.85 + phase * 6.28);
    let wx = nx * (1 - fall) + (outX * 0.22 + sideX * wave) * fall;
    let wy = ny * (1 - fall) - fall;
    let wz = nz * (1 - fall) + (outZ * 0.22 + sideZ * wave) * fall;
    const wl = Math.hypot(wx, wy, wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    dx = dx * 0.45 + wx * 0.55;
    dy = dy * 0.45 + wy * 0.55;
    dz = dz * 0.45 + wz * 0.55;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const o = b + j * 3;
    const px = rest[o - 3], py = rest[o - 2], pz = rest[o - 1];
    let qx = px + dx * seg, qy = py + dy * seg, qz = pz + dz * seg;
    for (let it = 0; it < 3; it++) {
      const d = body.sample(qx, qy, qz);
      const want = j === 1 ? off * 0.5 : off;
      if (d >= want) break;
      qx += body.gx * (want - d);
      qy += body.gy * (want - d);
      qz += body.gz * (want - d);
      const ex = qx - px, ey = qy - py, ez = qz - pz, el = Math.hypot(ex, ey, ez) || 1;
      qx = px + (ex / el) * seg;
      qy = py + (ey / el) * seg;
      qz = pz + (ez / el) * seg;
    }
    rest[o] = qx;
    rest[o + 1] = qy;
    rest[o + 2] = qz;
    const ex = qx - px, ey = qy - py, ez = qz - pz, el = Math.hypot(ex, ey, ez) || 1;
    dx = ex / el; dy = ey / el; dz = ez / el;
  }
}

export function scaleColor(hex: number, k: number): number {
  const ch = (shift: number) => Math.min(255, Math.max(0, Math.round(((hex >> shift) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
