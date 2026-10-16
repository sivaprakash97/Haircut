import { beforeAll, describe, expect, it } from 'vitest';
import { buildField } from '../src/engine/build';
import { findDetached, removeDetached } from '../src/engine/detach';
import { Editor } from '../src/engine/edit';
import { Field } from '../src/engine/grid';
import { HEAD_BOUNDS, headSDF, sampleHead } from '../src/engine/head';
import { type Ray, raycast } from '../src/engine/pick';
import { HAIR_BOUNDS, PRESETS } from '../src/engine/presets';
import { TABLE_STRIDE, type MeshBatch, type MeshOptions, meshBricks } from '../src/engine/surfaceNets';
import { type DistFn, type Vec3, cutSlice, extrude, grow, paintHold, slump, smudge } from '../src/engine/tools';

const CELL = 0.004;
const MESH: MeshOptions = { ao: 1.25, occluder: headSDF };

let headField: Field;
let headDist: DistFn;

beforeAll(() => {
  headField = new Field(HEAD_BOUNDS, CELL);
  buildField(headField, sampleHead, 1.2);
  headDist = (x, y, z) => headField.sampleWorld(x, y, z);
});

function hairField(preset: keyof typeof PRESETS): Field {
  const f = new Field(HAIR_BOUNDS, CELL);
  buildField(f, PRESETS[preset].sample, PRESETS[preset].lipschitz);
  return f;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** A ray from a random point on a sphere around the head toward (roughly) its centre. */
function randomRay(rand: () => number): Ray {
  const az = rand() * Math.PI * 2, el = (rand() - 0.25) * 1.4;
  const o: Vec3 = [Math.cos(el) * Math.sin(az) * 0.6, 0.05 + Math.sin(el) * 0.6, Math.cos(el) * Math.cos(az) * 0.6];
  const t: Vec3 = [(rand() - 0.5) * 0.12, 0.05 + (rand() - 0.5) * 0.14, (rand() - 0.5) * 0.12];
  const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]], l = Math.hypot(d[0], d[1], d[2]);
  return [o[0], o[1], o[2], d[0] / l, d[1] / l, d[2] / l];
}

/** Applies one random stroke of a random tool, the way the worker would. */
function randomStroke(ed: Editor, rand: () => number): string {
  const f = ed.field;
  const ray = randomRay(rand);
  const hit = raycast(f, headField, ray);
  if (!hit) return 'miss';
  const r = 0.01 + rand() * 0.025;
  const tool = Math.floor(rand() * 6);
  ed.begin();
  switch (tool) {
    case 0:
      for (let i = 0; i < 4; i++) grow(ed, headDist, hit.p, hit.n, r, 0.004, 0x1234);
      break;
    case 1: {
      const d: Vec3 = [(rand() - 0.5) * r, (rand() - 0.5) * r, (rand() - 0.5) * r];
      smudge(ed, headDist, hit.p, d, r, 1);
      break;
    }
    case 2:
      paintHold(ed, hit.p, r, (rand() - 0.5) * 400);
      break;
    case 3:
      paintHold(ed, hit.p, r, -255);
      for (let i = 0; i < 3; i++) slump(ed, headDist, hit.p, r, 0.05);
      break;
    case 4: {
      const pull = { a: hit.p, n: hit.n, color: 0x4321, b: [hit.p[0] + hit.n[0] * 0.05, hit.p[1] + hit.n[1] * 0.05, hit.p[2] + hit.n[2] * 0.05] as Vec3 };
      extrude(ed, headDist, [pull], r);
      pull.b = [hit.p[0] + hit.n[0] * 0.08, hit.p[1] + hit.n[1] * 0.08, hit.p[2] + hit.n[2] * 0.08];
      extrude(ed, headDist, [pull], r);
      break;
    }
    case 5: {
      const o: Vec3 = [ray[0], ray[1], ray[2]];
      const d0: Vec3 = [ray[3], ray[4], ray[5]];
      const side = [-d0[2], 0, d0[0]], sl = Math.hypot(side[0], side[2]) || 1;
      const d1raw = [d0[0] + (side[0] / sl) * 0.15, d0[1] + 0.02, d0[2] + (side[2] / sl) * 0.15];
      const l1 = Math.hypot(d1raw[0], d1raw[1], d1raw[2]);
      cutSlice(ed, o, d0, [d1raw[0] / l1, d1raw[1] / l1, d1raw[2] / l1], hit.t - 0.012, hit.t + 0.058);
      removeDetached(ed, headDist);
      break;
    }
  }
  ed.commit();
  return ['grow', 'smudge', 'hold', 'dryer', 'extrude', 'scissors'][tool];
}

type BrickMesh = { pos: Float32Array; idx: Uint32Array; col: Uint8Array; hold: Uint8Array };

function brickMap(m: MeshBatch, into = new Map<number, BrickMesh>()): Map<number, BrickMesh> {
  for (let t = 0; t < m.table.length; t += TABLE_STRIDE) {
    const [b, v0, vc, i0, ic] = [m.table[t], m.table[t + 1], m.table[t + 2], m.table[t + 3], m.table[t + 4]];
    if (ic === 0) {
      into.delete(b);
      continue;
    }
    into.set(b, {
      pos: m.positions.slice(v0 * 3, (v0 + vc) * 3),
      idx: m.indices.slice(i0, i0 + ic),
      col: m.colors.slice(v0 * 4, (v0 + vc) * 4),
      hold: m.holds.slice(v0, v0 + vc),
    });
  }
  return into;
}

function remesh(ed: Editor): MeshBatch | 'all' {
  const dirty = ed.takeDirty();
  return dirty === 'all' ? 'all' : meshBricks(ed.field, dirty, { ...MESH, includeEmpty: true });
}

describe('editing', () => {
  it('undo restores exact bytes, and redo replays them', () => {
    const f = hairField('quiff');
    const ed = new Editor(f);
    const start = { shape: f.shape.slice(), color: f.color.slice(), hold: f.hold.slice() };
    const rand = rng(7);
    let strokes = 0;
    for (let i = 0; i < 40; i++) if (randomStroke(ed, rand) !== 'miss') strokes++;
    expect(strokes).toBeGreaterThan(25);
    const end = { shape: f.shape.slice(), color: f.color.slice(), hold: f.hold.slice() };
    expect(end.shape).not.toEqual(start.shape);

    while (ed.undo());
    expect(f.shape).toEqual(start.shape);
    expect(f.color).toEqual(start.color);
    expect(f.hold).toEqual(start.hold);

    while (ed.redo());
    expect(f.shape).toEqual(end.shape);
    expect(f.color).toEqual(end.color);
    expect(f.hold).toEqual(end.hold);
  });

  it('reset returns to the starting hairstyle and can itself be undone', () => {
    const f = hairField('spikes');
    const ed = new Editor(f);
    const start = f.shape.slice();
    const rand = rng(11);
    for (let i = 0; i < 10; i++) randomStroke(ed, rand);
    const edited = f.shape.slice();
    ed.reset();
    expect(f.shape).toEqual(start);
    ed.undo();
    expect(f.shape).toEqual(edited);
  });

  it('re-meshing only dirty bricks gives the same meshes as a full rebuild', () => {
    const f = hairField('afro');
    const ed = new Editor(f);
    const live = brickMap(meshBricks(f, undefined, MESH));
    const rand = rng(3);
    for (let i = 0; i < 30; i++) {
      randomStroke(ed, rand);
      if (i % 9 === 8) ed.undo();
      const m = remesh(ed);
      if (m === 'all') throw new Error('unexpected full remesh');
      brickMap(m, live);
    }
    const fresh = brickMap(meshBricks(f, undefined, MESH));
    expect([...live.keys()].sort((a, b) => a - b)).toEqual([...fresh.keys()].sort((a, b) => a - b));
    for (const [b, mesh] of fresh) {
      const got = live.get(b)!;
      expect(got.pos).toEqual(mesh.pos);
      expect(got.idx).toEqual(mesh.idx);
      expect(got.col).toEqual(mesh.col);
      expect(got.hold).toEqual(mesh.hold);
    }
  });

  it('keeps the surface watertight and out of the head after many edits', () => {
    const f = hairField('quiff');
    const ed = new Editor(f);
    const rand = rng(99);
    for (let i = 0; i < 40; i++) randomStroke(ed, rand);
    const m = meshBricks(f, undefined, MESH);
    // Global triangles; seam vertices are duplicated across bricks, identified by position.
    const key = (v: number) => `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`;
    const count = new Map<string, number>();
    for (let t = 0; t < m.table.length; t += TABLE_STRIDE) {
      const v0 = m.table[t + 1], i0 = m.table[t + 3], ic = m.table[t + 4];
      for (let i = 0; i < ic; i += 3) {
        const tri = [m.indices[i0 + i] + v0, m.indices[i0 + i + 1] + v0, m.indices[i0 + i + 2] + v0].map(key);
        for (let e = 0; e < 3; e++) {
          const k = `${tri[e]}|${tri[(e + 1) % 3]}`;
          count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
    }
    let unmatched = 0;
    for (const [k, n] of count) {
      const [a, b] = k.split('|');
      if ((count.get(`${b}|${a}`) ?? 0) !== n) unmatched++;
    }
    expect(unmatched).toBe(0);
    for (let i = 0; i < m.positions.length; i++) expect(Number.isFinite(m.positions[i])).toBe(true);
    let deep = 0;
    for (let v = 0; v < m.positions.length / 3; v++) {
      if (headSDF(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]) < -CELL) deep++;
    }
    expect(deep).toBe(0);
  });
});

describe('tools', () => {
  const inside = (f: Field) => f.shape.reduce((n, v) => n + (v < 0 ? 1 : 0), 0);

  it('scissors cut a spike off, the piece is removed, and undo puts it back', () => {
    const f = hairField('spikes');
    const ed = new Editor(f);
    const before = inside(f);
    // The back-top spike points along u; slice across it 12 cm from the skull centre.
    const az = Math.PI, el = (58 * Math.PI) / 180;
    const u: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    const P: Vec3 = [u[0] * 0.125, 0.026 + u[1] * 0.125, -0.006 + u[2] * 0.125];
    const v: Vec3 = [1, 0, 0];
    const w: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const O: Vec3 = [P[0] + w[0] * 0.5, P[1] + w[1] * 0.5, P[2] + w[2] * 0.5];
    const dir = (q: Vec3): Vec3 => {
      const d = [q[0] - O[0], q[1] - O[1], q[2] - O[2]], l = Math.hypot(d[0], d[1], d[2]);
      return [d[0] / l, d[1] / l, d[2] / l];
    };
    ed.begin();
    cutSlice(ed, O, dir([P[0] - 0.05, P[1], P[2]]), dir([P[0] + 0.05, P[1], P[2]]), 0.45, 0.55);
    expect(findDetached(f, headDist).length).toBeGreaterThan(50);
    const piece = removeDetached(ed, headDist);
    ed.commit();
    expect(piece).not.toBeNull();
    expect(piece!.indices.length).toBeGreaterThan(300);
    expect(findDetached(f, headDist).length).toBe(0);
    expect(inside(f)).toBeLessThan(before - 50);
    ed.undo();
    expect(inside(f)).toBe(before);
  });

  it('grow adds material, also on bare scalp', () => {
    const f = hairField('spikes');
    const ed = new Editor(f);
    const before = inside(f);
    const hit = raycast(f, headField, [0, -0.02, 0.6, 0, 0, -1])!; // the forehead/face
    expect(hit).not.toBeNull();
    ed.begin();
    for (let i = 0; i < 20; i++) grow(ed, headDist, hit.p, hit.n, 0.015, 0.002, 0x0f0f);
    ed.commit();
    expect(inside(f)).toBeGreaterThan(before + 100);
  });

  it('comb moves material along the stroke', () => {
    const f = hairField('quiff');
    const ed = new Editor(f);
    const hit = raycast(f, headField, [0.6, 0.11, 0.02, -1, 0, 0])!; // side of the quiff
    const before = f.shape.slice();
    ed.begin();
    for (let i = 0; i < 6; i++) smudge(ed, headDist, [hit.p[0], hit.p[1], hit.p[2] + i * 0.004], [0, 0, 0.004], 0.03, 1);
    ed.commit();
    // Cells that gained material should lie ahead of where the stroke started.
    let gained = 0, z = 0;
    for (let o = 0; o < f.shape.length; o++) {
      if (before[o] >= 0 && f.shape[o] < 0) {
        gained++;
        z += f.oz + ((o / (f.nx * f.ny)) | 0) * f.cell;
      }
    }
    expect(gained).toBeGreaterThan(30);
    expect(z / gained).toBeGreaterThan(hit.p[2] + 0.01);
  });

  it('extrude previews live: a shorter pull replaces a longer one', () => {
    const f = hairField('quiff');
    const ed = new Editor(f);
    const hit = raycast(f, headField, [0, 0.4, 0, 0, -1, 0])!; // top of the head
    const base = inside(f);
    const pull = { a: hit.p, n: hit.n, color: 0x7777, b: [hit.p[0], hit.p[1] + 0.1, hit.p[2]] as Vec3 };
    ed.begin();
    extrude(ed, headDist, [pull], 0.015);
    const long = inside(f);
    pull.b = [hit.p[0], hit.p[1] + 0.04, hit.p[2]];
    extrude(ed, headDist, [pull], 0.015);
    const short = inside(f);
    ed.commit();
    expect(long).toBeGreaterThan(base + 100);
    expect(short).toBeGreaterThan(base);
    expect(short).toBeLessThan(long);
  });

  it('dried material sags while gelled material holds', () => {
    const run = (hold: number) => {
      const f = hairField('spikes');
      const ed = new Editor(f);
      const tip: Vec3 = [0, 0.026 + Math.sin((62 * Math.PI) / 180) * 0.13, -0.006 + Math.cos((62 * Math.PI) / 180) * 0.13];
      ed.begin();
      paintHold(ed, tip, 0.04, hold - 200);
      for (let i = 0; i < 20; i++) slump(ed, headDist, tip, 0.03, 0.05);
      ed.commit();
      let y = 0, n = 0;
      for (let o = 0; o < f.shape.length; o++) {
        if (f.shape[o] >= 0) continue;
        const i = o % f.nx, j = ((o / f.nx) | 0) % f.ny, k = (o / (f.nx * f.ny)) | 0;
        const p = [f.ox + i * f.cell, f.oy + j * f.cell, f.oz + k * f.cell];
        if (Math.hypot(p[0] - tip[0], p[1] - tip[1], p[2] - tip[2]) < 0.035) { y += p[1]; n++; }
      }
      return y / n;
    };
    const gelled = run(255), dried = run(0);
    expect(dried).toBeLessThan(gelled - 0.002);
  });
});
