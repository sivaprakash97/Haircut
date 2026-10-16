import { beforeAll, describe, expect, it } from 'vitest';
import { buildBodyGrid } from '../src/engine/bodyGrid';
import { Body } from '../src/hair/body';
import { DebrisPool } from '../src/hair/debris';
import { generateLocks } from '../src/hair/generate';
import { KIND_BEARD, MIN_LEN, NODES, ROOT_DEPTH, type LockData, lastNode } from '../src/hair/locks';
import { mulberry32 } from '../src/hair/random';
import { HairSession, type Ray, type StrokeInput, type ToolId } from '../src/hair/session';
import { STEP, Sim } from '../src/hair/sim';

let body: Body;
let fresh: () => LockData;

beforeAll(() => {
  body = new Body(buildBodyGrid());
  const base = generateLocks(body);
  // Each test gets its own copy of the starting hair.
  fresh = () => ({
    ...base,
    root: base.root.slice(), normal: base.normal.slice(), seg: base.seg.slice(), radius: base.radius.slice(),
    offset: base.offset.slice(), kind: base.kind.slice(), mirror: base.mirror.slice(), rest: base.rest.slice(),
    len: base.len.slice(), hold: base.hold.slice(), blunt: base.blunt.slice(), color: base.color.slice(),
  });
});

/** A camera in front of the face (head space = world at yaw 0). */
const EYE = [0, 0.05, 0.9];
function rayTo(p: readonly number[], eye = EYE): Ray {
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [eye[0], eye[1], eye[2], d[0] / l, d[1] / l, d[2] / l];
}

function settle(s: HairSession, max = 400): void {
  for (let k = 0; k < max && !s.sim.asleep; k++) s.step();
}

/** Drags `tool` through head-space points (interpolated over `frames` updates), stepping the physics as it goes. */
function stroke(s: HairSession, tool: ToolId, pts: number[][], opts: Partial<StrokeInput> & { frames?: number; eye?: number[] } = {}): void {
  const frames = opts.frames ?? 20;
  for (let k = 0; k <= frames; k++) {
    const f = (k / frames) * (pts.length - 1);
    const a = Math.min(pts.length - 2, Math.floor(f)), u = pts.length > 1 ? f - a : 0;
    const p = pts.length > 1 ? [0, 1, 2].map((c) => pts[a][c] + (pts[a + 1][c] - pts[a][c]) * u) : pts[0];
    s.strokeStep({
      phase: k === 0 ? 'begin' : k === frames ? 'end' : 'move', tool, ray: rayTo(p, opts.eye), radius: opts.radius ?? 0.02,
      strength: opts.strength ?? 0.6, mirror: opts.mirror ?? false, dt: STEP, guard: opts.guard ?? 0.006,
    });
    s.step();
  }
}

const node = (s: HairSession, i: number, j: number) => {
  const o = (i * NODES + j) * 3;
  return [s.sim.pos[o], s.sim.pos[o + 1], s.sim.pos[o + 2]];
};
const tip = (s: HairSession, i: number) => node(s, i, lastNode(s.L.len[i]));

describe('starting hair', () => {
  it('is the same on every load', () => {
    const a = generateLocks(body), b = generateLocks(body);
    expect(a.count).toBe(b.count);
    expect(a.rest).toEqual(b.rest);
    expect(a.len).toEqual(b.len);
  });

  it('covers the scalp and a beard with hundreds of locks, mirrored left and right', () => {
    const L = fresh();
    const beard = L.kind.filter((k) => k === KIND_BEARD).length;
    expect(L.count - beard).toBeGreaterThan(300);
    expect(beard).toBeGreaterThan(150);
    for (let i = 0; i < L.count; i++) {
      const m = L.mirror[i];
      expect(L.mirror[m]).toBe(i);
      expect(L.root[m * 3]).toBeCloseTo(-L.root[i * 3], 6);
      expect(L.root[m * 3 + 1]).toBeCloseTo(L.root[i * 3 + 1], 6);
      expect(L.len[m]).toBeCloseTo(L.len[i], 6);
    }
  });

  it('roots sit just under the skin and the hair hangs outside the head', () => {
    const L = fresh();
    for (let i = 0; i < L.count; i++) {
      const d = body.sample(L.root[i * 3], L.root[i * 3 + 1], L.root[i * 3 + 2]);
      expect(Math.abs(d + ROOT_DEPTH)).toBeLessThan(0.0025);
      for (let j = 2; j <= lastNode(L.len[i]); j++) {
        const o = (i * NODES + j) * 3;
        expect(body.sample(L.rest[o], L.rest[o + 1], L.rest[o + 2])).toBeGreaterThan(0);
      }
    }
  });

  it('is overgrown: long hair at the back, a fringe at the front, a full beard', () => {
    const L = fresh();
    let back = 0, fringe = 0, beard = 0;
    for (let i = 0; i < L.count; i++) {
      const length = L.len[i] * L.seg[i];
      if (L.kind[i] === KIND_BEARD) beard = Math.max(beard, length);
      else if (L.root[i * 3 + 2] < -0.06) back = Math.max(back, length);
      else if (L.root[i * 3 + 2] > 0.06) fringe = Math.max(fringe, length);
    }
    expect(back).toBeGreaterThan(0.22);
    expect(fringe).toBeGreaterThan(0.07);
    expect(beard).toBeGreaterThan(0.06);
  });
});

describe('physics', () => {
  it('settles and goes to sleep, then wakes and swings when the head turns', () => {
    const s = new HairSession(fresh(), body);
    settle(s, 600);
    expect(s.sim.asleep).toBe(true);
    const before = tip(s, 0);
    for (let k = 0; k < 20; k++) {
      s.sim.setYaw(k * 0.04);
      s.step();
    }
    expect(s.sim.asleep).toBe(false);
    expect(Math.hypot(...tip(s, 0).map((v, a) => v - before[a]))).toBeGreaterThan(0.005);
    settle(s, 900);
    expect(s.sim.asleep).toBe(true);
  });

  it('keeps every segment its length and the hair out of the head, even when spun hard', () => {
    const L = fresh();
    const sim = new Sim(L, body);
    for (let k = 0; k < 240; k++) {
      sim.setYaw(Math.sin(k * 0.08) * 1.6);
      sim.step();
    }
    let maxErr = 0, inside = 0;
    for (let i = 0; i < L.count; i++) {
      for (let j = 1; j <= lastNode(L.len[i]); j++) {
        const o = (i * NODES + j) * 3;
        const l = Math.hypot(sim.pos[o] - sim.pos[o - 3], sim.pos[o + 1] - sim.pos[o - 2], sim.pos[o + 2] - sim.pos[o - 1]);
        expect(Number.isFinite(l)).toBe(true);
        maxErr = Math.max(maxErr, Math.abs(l - L.seg[i]) / L.seg[i]);
        if (j >= 2) {
          const c = sim.cos, s = sim.sin, x = sim.pos[o], z = sim.pos[o + 2];
          if (body.sample(c * x - s * z, sim.pos[o + 1], s * x + c * z) < -0.002) inside++;
        }
      }
    }
    expect(maxErr).toBeLessThan(0.15);
    expect(inside).toBe(0);
  });

  it('gelled hair holds its shape; loose hair hangs', () => {
    const L = fresh();
    const s = new HairSession(L, body);
    // Point one lock and its neighbour straight out from the head, gel only one.
    const pick = [...Array(L.count).keys()].find((i) => L.kind[i] === 0 && L.root[i * 3 + 1] > 0.1)!;
    const other = L.mirror[pick];
    for (const i of [pick, other]) {
      const n = [L.normal[i * 3], L.normal[i * 3 + 1], L.normal[i * 3 + 2]];
      for (let j = 0; j < NODES; j++) for (let a = 0; a < 3; a++) L.rest[(i * NODES + j) * 3 + a] = L.root[i * 3 + a] + n[a] * L.seg[i] * j;
      s.sim.snap(i);
    }
    L.hold[pick] = 1;
    for (let k = 0; k < 120; k++) s.step();
    const h = (i: number) => tip(s, i)[1];
    expect(h(pick)).toBeGreaterThan(h(other) + 0.05);
  });
});

describe('tools', () => {
  it('scissors cut every lock the blade crosses; the ends fall and the cut is blunt', () => {
    const s = new HairSession(fresh(), body);
    settle(s);
    const length = s.totalLength();
    // Across the fringe, just above the eyes.
    stroke(s, 'scissors', [[-0.1, 0.035, 0.12], [0.1, 0.035, 0.12]], { frames: 12 });
    expect(s.totalLength()).toBeLessThan(length - 0.3);
    expect(s.debris.active).toBeGreaterThan(5);
    const cut = [...Array(s.L.count).keys()].filter((i) => s.L.blunt[i] === 1);
    expect(cut.length).toBeGreaterThan(5);
    for (const i of cut) expect(s.L.len[i]).toBeGreaterThanOrEqual(MIN_LEN);
    // Hair behind the head is safe.
    const back = [...Array(s.L.count).keys()].filter((i) => s.L.root[i * 3 + 2] < -0.07);
    expect(back.every((i) => s.L.blunt[i] === 0)).toBe(true);
  });

  it('clippers buzz the hair rooted under them down to the guard, on both sides with mirror', () => {
    const L = fresh();
    const s = new HairSession(L, body);
    settle(s);
    stroke(s, 'clippers', [[0.045, 0.1, 0.06], [0.05, 0.085, 0.07]], { radius: 0.025, guard: 0.004, mirror: true, frames: 10 });
    const buzzed = [...Array(L.count).keys()].filter((i) => L.len[i] * L.seg[i] < 0.004 + ROOT_DEPTH + 0.002);
    expect(buzzed.length).toBeGreaterThan(4);
    // Mirror: the same locks on the other side are buzzed too.
    for (const i of buzzed) expect(L.len[L.mirror[i]] * L.seg[i]).toBeLessThan(0.012);
  });

  it('the comb sweeps the fringe up and it stays there', () => {
    const L = fresh();
    const s = new HairSession(L, body);
    settle(s);
    const fringe = [...Array(L.count).keys()].filter((i) => L.kind[i] === 0 && L.root[i * 3 + 2] > 0.05 && Math.abs(L.root[i * 3]) < 0.03);
    const avgTipY = () => fringe.reduce((a, i) => a + tip(s, i)[1], 0) / fringe.length;
    const before = avgTipY();
    stroke(s, 'comb', [[0, 0.07, 0.115], [0, 0.11, 0.08], [0, 0.135, 0.02], [0, 0.12, -0.05]], { radius: 0.025, frames: 24 });
    settle(s, 600);
    expect(avgTipY()).toBeGreaterThan(before + 0.04);
    expect(Math.max(...fringe.map((i) => L.hold[i]))).toBeGreaterThan(0.2); // combed hair is a little set
  });

  it('grow lengthens hair under the brush, also stubble on bare scalp', () => {
    const L = fresh();
    const s = new HairSession(L, body);
    settle(s);
    // Seen from above: shave a patch on the crown, then grow it back.
    const eye = [0, 0.7, 0.1], crown = [[0.02, 0.11, 0.0]];
    stroke(s, 'clippers', crown, { radius: 0.02, guard: 0, frames: 4, eye });
    const shaved = [...Array(L.count).keys()].filter((i) => L.len[i] <= MIN_LEN + 1e-6);
    expect(shaved.length).toBeGreaterThan(2);
    settle(s);
    stroke(s, 'grow', crown, { radius: 0.02, frames: 60, eye });
    expect(shaved.filter((i) => L.len[i] > 1).length).toBeGreaterThan(1);
    expect(shaved.some((i) => L.blunt[i] < 1)).toBe(true); // regrown hair has natural tips again
  });

  it('extrude pulls hair out (growing it to reach) and gels it so it stays', () => {
    const L = fresh();
    const s = new HairSession(L, body);
    settle(s);
    const length = s.totalLength();
    // Press on the crown and pull up and away.
    stroke(s, 'extrude', [[0.02, 0.125, 0.0], [0.03, 0.2, 0.0], [0.04, 0.27, 0.0]], { radius: 0.02, frames: 16 });
    settle(s, 600);
    const pulled = [...Array(L.count).keys()].filter((i) => L.hold[i] > 0.85);
    expect(pulled.length).toBeGreaterThan(3);
    expect(Math.max(...pulled.map((i) => tip(s, i)[1]))).toBeGreaterThan(0.2);
    expect(s.totalLength()).toBeGreaterThan(length);
  });

  it('gel stiffens hair; the dryer blows it around and loosens gel', () => {
    const L = fresh();
    const s = new HairSession(L, body);
    settle(s);
    stroke(s, 'gel', [[0.04, 0.08, 0.09], [0.05, 0.06, 0.09]], { radius: 0.025, frames: 30 });
    const gelled = [...Array(L.count).keys()].filter((i) => L.hold[i] > 0.5);
    expect(gelled.length).toBeGreaterThan(3);
    const before = s.sim.pos.slice();
    stroke(s, 'dryer', [[0.0, -0.07, 0.1]], { radius: 0.03, frames: 40 });
    let moved = 0;
    for (let i = 0; i < before.length; i++) moved = Math.max(moved, Math.abs(s.sim.pos[i] - before[i]));
    expect(moved).toBeGreaterThan(0.01);
    expect(s.sim.winds.length).toBe(0); // the air stops when the button is released
    stroke(s, 'dryer', [[0.045, 0.07, 0.1]], { radius: 0.03, frames: 60 });
    expect(Math.min(...gelled.map((i) => L.hold[i]))).toBeLessThan(0.9);
  });
});

describe('history', () => {
  it('undo restores the exact starting hair after random strokes, redo replays them, reset is undoable', () => {
    const s = new HairSession(fresh(), body);
    settle(s);
    const start = s.checksum();
    const rand = mulberry32(3);
    const tools: ToolId[] = ['scissors', 'clippers', 'comb', 'grow', 'extrude', 'gel', 'dryer'];
    const sums: number[] = [];
    for (let k = 0; k < 21; k++) {
      const tool = tools[k % tools.length];
      const p = () => [(rand() - 0.5) * 0.14, 0.02 + rand() * 0.1, 0.06 + rand() * 0.05];
      stroke(s, tool, [p(), p()], { frames: 6, mirror: rand() > 0.5, radius: 0.015 + rand() * 0.02 });
      sums.push(s.checksum());
    }
    const steps = s.history.undoCount;
    expect(steps).toBeGreaterThan(10);
    const end = s.checksum();
    while (s.undo());
    expect(s.checksum()).toBe(start);
    while (s.redo());
    expect(s.checksum()).toBe(end);
    expect(s.reset()).toBe(true);
    expect(s.checksum()).toBe(start);
    s.undo();
    expect(s.checksum()).toBe(end);
  });
});

describe('falling pieces', () => {
  it('keep the length that was cut off and disappear after a moment', () => {
    const pool = new DebrisPool();
    const pts = new Float32Array([0, 0, 0, 0, -0.05, 0, 0.02, -0.08, 0]);
    pool.spawn({ points: pts, vx: 0, vy: 0, vz: 0, seg: 0.016, radius: 0.005, color: 0, tStart: 2, fullLen: 8, blunt: 0 });
    const length = 0.05 + Math.hypot(0.02, 0.03);
    expect(pool.len[0] * 0.016).toBeCloseTo(length, 3);
    let frames = 0;
    while (pool.step(body, 1, 0)) frames++;
    expect(frames).toBeGreaterThan(60);
    expect(pool.active).toBe(0);
  });
});
