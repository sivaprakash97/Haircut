import { describe, expect, it } from 'vitest';
import { buildField } from '../src/engine/build';
import { Field } from '../src/engine/grid';
import { HEAD_BOUNDS, headSDF, sampleHead } from '../src/engine/head';
import { HAIR_BOUNDS, PRESETS, PRESET_IDS } from '../src/engine/presets';
import { TABLE_STRIDE, meshBricks, type MeshBatch } from '../src/engine/surfaceNets';

const sphereBounds = { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] } as const;

function sphereField(cell: number, r = 0.06): Field {
  const f = new Field(sphereBounds, cell);
  buildField(f, (x, y, z, out) => {
    out.d = Math.hypot(x - 0.003, y + 0.002, z - 0.001) - r; // off-centre so cells are not symmetric
    out.r = 1; out.g = 0.5; out.b = 0.25;
  });
  return f;
}

/** Global vertex positions and triangles, with per-brick indices made global. */
function flatten(batch: MeshBatch): { pos: Float32Array; tris: number[] } {
  const tris: number[] = [];
  for (let t = 0; t < batch.table.length; t += TABLE_STRIDE) {
    const v0 = batch.table[t + 1], i0 = batch.table[t + 3], ic = batch.table[t + 4];
    for (let i = 0; i < ic; i++) tris.push(batch.indices[i0 + i] + v0);
  }
  return { pos: batch.positions, tris };
}

function keyOf(pos: Float32Array, v: number): string {
  return `${pos[v * 3]},${pos[v * 3 + 1]},${pos[v * 3 + 2]}`;
}

describe('surface nets', () => {
  it('produces a closed, consistently oriented surface across brick seams', () => {
    const f = sphereField(0.004);
    const { pos, tris } = flatten(meshBricks(f));
    expect(tris.length).toBeGreaterThan(1000);
    // Bricks duplicate seam vertices; identical positions identify them.
    const directed = new Map<string, number>();
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = keyOf(pos, tris[t + e]), b = keyOf(pos, tris[t + ((e + 1) % 3)]);
        const k = `${a}|${b}`;
        directed.set(k, (directed.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of directed) {
      const [a, b] = k.split('|');
      expect(n).toBe(1);
      expect(directed.get(`${b}|${a}`)).toBe(1); // every edge has exactly one opposite twin => no cracks
    }
  });

  it('faces point outward', () => {
    const f = sphereField(0.004);
    const { pos, tris } = flatten(meshBricks(f));
    let outward = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const cx = pos[a] - 0.003, cy = pos[a + 1] + 0.002, cz = pos[a + 2] - 0.001;
      if (nx * cx + ny * cy + nz * cz > 0) outward++;
    }
    expect(outward).toBe(tris.length / 3);
  });

  it('places vertices on the surface with unit normals', () => {
    const f = sphereField(0.003);
    const m = meshBricks(f);
    for (let v = 0; v < m.positions.length / 3; v++) {
      const x = m.positions[v * 3] - 0.003, y = m.positions[v * 3 + 1] + 0.002, z = m.positions[v * 3 + 2] - 0.001;
      expect(Math.abs(Math.hypot(x, y, z) - 0.06)).toBeLessThan(0.003 * 0.25);
      const n = Math.hypot(m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]) / 127;
      expect(Math.abs(n - 1)).toBeLessThan(0.02);
    }
  });

  it('re-meshing a subset of bricks matches the full mesh for those bricks', () => {
    const f = sphereField(0.004);
    const full = meshBricks(f);
    const pick = [];
    for (let t = 0; t < full.table.length; t += TABLE_STRIDE * 7) pick.push(full.table[t]);
    const part = meshBricks(f, pick);
    const rowOf = (m: MeshBatch, brick: number) => {
      for (let t = 0; t < m.table.length; t += TABLE_STRIDE) if (m.table[t] === brick) return t;
      throw new Error(`brick ${brick} missing`);
    };
    for (const b of pick) {
      const tf = rowOf(full, b), tp = rowOf(part, b);
      const [vf, nvf, if0, nif] = [full.table[tf + 1], full.table[tf + 2], full.table[tf + 3], full.table[tf + 4]];
      const [vp, nvp, ip0, nip] = [part.table[tp + 1], part.table[tp + 2], part.table[tp + 3], part.table[tp + 4]];
      expect(nvp).toBe(nvf);
      expect(nip).toBe(nif);
      expect(part.positions.subarray(vp * 3, (vp + nvp) * 3)).toEqual(full.positions.subarray(vf * 3, (vf + nvf) * 3));
      expect(part.indices.subarray(ip0, ip0 + nip)).toEqual(full.indices.subarray(if0, if0 + nif));
    }
  });

  it('is deterministic', () => {
    const a = meshBricks(sphereField(0.004));
    const b = meshBricks(sphereField(0.004));
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
  });
});

describe('field', () => {
  it('quantizes within the band and saturates outside it', () => {
    const f = new Field(sphereBounds, 0.004);
    expect(f.quantize(0)).toBe(0);
    expect(f.quantize(f.band * 2)).toBe(127);
    expect(f.quantize(-f.band * 2)).toBe(-127);
    expect(Math.abs(f.quantize(f.band / 2) - 64)).toBeLessThanOrEqual(1);
  });
});

describe('presets and head', () => {
  for (const id of PRESET_IDS) {
    it(`${id}: builds a finite mesh that stays outside the head`, () => {
      const cell = 0.004;
      const f = new Field(HAIR_BOUNDS, cell);
      buildField(f, PRESETS[id].sample, PRESETS[id].lipschitz);
      const m = meshBricks(f, undefined, { ao: 1.25, occluder: headSDF });
      const nv = m.positions.length / 3;
      expect(nv).toBeGreaterThan(2000);
      for (let i = 0; i < m.positions.length; i++) expect(Number.isFinite(m.positions[i])).toBe(true);
      let deep = 0;
      for (let v = 0; v < nv; v++) {
        if (headSDF(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]) < -cell) deep++;
      }
      expect(deep).toBe(0);
    });
  }

  it('head builds a mesh', () => {
    const f = new Field(HEAD_BOUNDS, 0.004);
    buildField(f, sampleHead, 1.2);
    const m = meshBricks(f);
    expect(m.indices.length / 3).toBeGreaterThan(5000);
  });
});
