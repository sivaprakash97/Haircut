import { b565, g565, r565 } from './color';
import { BRICK, type Field } from './grid';

/**
 * Meshes for a set of bricks, packed into shared arrays.
 * `table` holds 5 ints per brick: brick index, first vertex, vertex count,
 * first index, index count. Indices are local to each brick (0-based).
 */
export interface MeshBatch {
  table: Int32Array;
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  indices: Uint32Array;
}

export interface MeshOptions {
  /** Extra occluder for ambient occlusion: world position -> distance in metres. */
  occluder?: (x: number, y: number, z: number) => number;
  /** Ambient-occlusion strength; 0 disables it. */
  ao?: number;
  /** Keep table rows for bricks that produced no geometry (needed when updating). */
  includeEmpty?: boolean;
}

export const TABLE_STRIDE = 5;

const AO_STEPS = [1.0, 2.0, 3.4];
const AO_WEIGHTS = [0.5, 0.32, 0.18];
// Cube edges as corner pairs; corner n has offset (n & 1, (n >> 1) & 1, (n >> 2) & 1).
const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];

class Writer {
  pos = new Float32Array(3 * 8192);
  nrm = new Int8Array(3 * 8192);
  col = new Uint8Array(4 * 8192);
  idx = new Uint32Array(6 * 8192);
  nv = 0;
  ni = 0;

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, ao: number): void {
    if ((this.nv + 1) * 3 > this.pos.length) this.growVertices();
    const v3 = this.nv * 3, v4 = this.nv * 4;
    this.pos[v3] = x; this.pos[v3 + 1] = y; this.pos[v3 + 2] = z;
    this.nrm[v3] = Math.round(nx * 127); this.nrm[v3 + 1] = Math.round(ny * 127); this.nrm[v3 + 2] = Math.round(nz * 127);
    this.col[v4] = Math.round(r * 255); this.col[v4 + 1] = Math.round(g * 255);
    this.col[v4 + 2] = Math.round(b * 255); this.col[v4 + 3] = Math.round(ao * 255);
    this.nv++;
  }

  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const next = new Uint32Array(this.idx.length * 2);
      next.set(this.idx);
      this.idx = next;
    }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }

  private growVertices(): void {
    const pos = new Float32Array(this.pos.length * 2); pos.set(this.pos); this.pos = pos;
    const nrm = new Int8Array(this.nrm.length * 2); nrm.set(this.nrm); this.nrm = nrm;
    const col = new Uint8Array(this.col.length * 2); col.set(this.col); this.col = col;
  }
}

/** Extracts a Surface Nets mesh for each listed brick (every brick that can hold surface if omitted). */
export function meshBricks(field: Field, bricks?: ArrayLike<number>, opts: MeshOptions = {}): MeshBatch {
  const list = bricks ?? field.activeBricks();
  const w = new Writer();
  const table: number[] = [];
  const cellVert = new Int32Array((BRICK + 1) ** 3);
  for (let n = 0; n < list.length; n++) {
    const b = list[n];
    const v0 = w.nv, i0 = w.ni;
    meshBrick(field, b, w, cellVert, opts);
    if (w.nv > v0 || opts.includeEmpty) table.push(b, v0, w.nv - v0, i0, w.ni - i0);
  }
  return {
    table: Int32Array.from(table),
    positions: w.pos.slice(0, w.nv * 3),
    normals: w.nrm.slice(0, w.nv * 3),
    colors: w.col.slice(0, w.nv * 4),
    indices: w.idx.slice(0, w.ni),
  };
}

function meshBrick(f: Field, b: number, w: Writer, cellVert: Int32Array, opts: MeshOptions): void {
  const { nx, ny, nz, shape, color, cell, ox, oy, oz } = f;
  const sy = nx, sz = nx * ny;
  const co = [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1];
  const bxi = b % f.bx, byi = ((b / f.bx) | 0) % f.by, bzi = (b / (f.bx * f.by)) | 0;
  // Cells are indexed by their lowest corner; valid cells are 0..n-2 per axis.
  const si = bxi * BRICK, sj = byi * BRICK, sk = bzi * BRICK;
  const ei = Math.min(si + BRICK, nx - 1), ej = Math.min(sj + BRICK, ny - 1), ek = Math.min(sk + BRICK, nz - 1);
  // Vertices are also needed for the cell layer just below the brick (shared faces).
  const ci0 = Math.max(si - 1, 0), cj0 = Math.max(sj - 1, 0), ck0 = Math.max(sk - 1, 0);
  const W = BRICK + 1;
  const vBase = w.nv;
  const aoStrength = opts.ao ?? 0;
  const occluder = opts.occluder;
  let corner0 = 0, corner1 = 0, corner2 = 0, corner3 = 0, corner4 = 0, corner5 = 0, corner6 = 0, corner7 = 0;
  const cv = [0, 0, 0, 0, 0, 0, 0, 0];

  for (let k = ck0; k < ek; k++) {
    for (let j = cj0; j < ej; j++) {
      for (let i = ci0; i < ei; i++) {
        const c = i - ci0 + W * (j - cj0 + W * (k - ck0));
        const o = i + sy * j + sz * k;
        corner0 = shape[o]; corner1 = shape[o + co[1]]; corner2 = shape[o + co[2]]; corner3 = shape[o + co[3]];
        corner4 = shape[o + co[4]]; corner5 = shape[o + co[5]]; corner6 = shape[o + co[6]]; corner7 = shape[o + co[7]];
        const mask =
          (corner0 < 0 ? 1 : 0) | (corner1 < 0 ? 2 : 0) | (corner2 < 0 ? 4 : 0) | (corner3 < 0 ? 8 : 0) |
          (corner4 < 0 ? 16 : 0) | (corner5 < 0 ? 32 : 0) | (corner6 < 0 ? 64 : 0) | (corner7 < 0 ? 128 : 0);
        if (mask === 0 || mask === 255) {
          cellVert[c] = -1;
          continue;
        }
        cv[0] = corner0; cv[1] = corner1; cv[2] = corner2; cv[3] = corner3;
        cv[4] = corner4; cv[5] = corner5; cv[6] = corner6; cv[7] = corner7;

        // Vertex = mean of the surface crossings on the cell's edges.
        let px = 0, py = 0, pz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = EA[e], bb = EB[e];
          const va = cv[a], vb = cv[bb];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          px += (a & 1) + ((bb & 1) - (a & 1)) * t;
          py += ((a >> 1) & 1) + (((bb >> 1) & 1) - ((a >> 1) & 1)) * t;
          pz += ((a >> 2) & 1) + (((bb >> 2) & 1) - ((a >> 2) & 1)) * t;
          cnt++;
        }
        const gx = i + px / cnt, gy = j + py / cnt, gz = k + pz / cnt;
        const wx = ox + gx * cell, wy = oy + gy * cell, wz = oz + gz * cell;

        // Normal from central differences of the trilinear field (smooth across cells).
        let gnx = f.sampleGrid(gx + 1, gy, gz) - f.sampleGrid(gx - 1, gy, gz);
        let gny = f.sampleGrid(gx, gy + 1, gz) - f.sampleGrid(gx, gy - 1, gz);
        let gnz = f.sampleGrid(gx, gy, gz + 1) - f.sampleGrid(gx, gy, gz - 1);
        const gl = Math.sqrt(gnx * gnx + gny * gny + gnz * gnz);
        if (gl > 1e-12) { gnx /= gl; gny /= gl; gnz /= gl; } else { gnx = 0; gny = 1; gnz = 0; }

        // Colour = mean of the inside corners' material colour.
        let r = 0, g = 0, bl = 0, ins = 0;
        for (let n = 0; n < 8; n++) {
          if (!(mask & (1 << n))) continue;
          const col = color[o + co[n]];
          r += r565(col); g += g565(col); bl += b565(col); ins++;
        }

        // Ambient occlusion: how much material sits just outside the surface.
        let ao = 1;
        if (aoStrength > 0) {
          let occ = 0;
          for (let s = 0; s < AO_STEPS.length; s++) {
            const h = AO_STEPS[s];
            let d = f.sampleGrid(gx + gnx * h, gy + gny * h, gz + gnz * h);
            if (occluder) d = Math.min(d, occluder(wx + gnx * h * cell, wy + gny * h * cell, wz + gnz * h * cell));
            occ += (AO_WEIGHTS[s] * Math.max(0, h * cell - d)) / (h * cell);
          }
          ao = Math.min(1, Math.max(0, 1 - occ * aoStrength));
        }

        w.vertex(wx, wy, wz, gnx, gny, gnz, r / ins, g / ins, bl / ins, ao);
        cellVert[c] = w.nv - 1 - vBase;
      }
    }
  }

  // One quad per grid edge with a sign change, joining the 4 cells around it.
  // Only edges whose lower corner lies in this brick are emitted, so bricks never duplicate faces.
  const vAt = (i: number, j: number, k: number): number => cellVert[i - ci0 + W * (j - cj0 + W * (k - ck0))];
  for (let k = sk; k < ek; k++) {
    for (let j = sj; j < ej; j++) {
      for (let i = si; i < ei; i++) {
        const o = i + sy * j + sz * k;
        const inside = shape[o] < 0;
        if (j > 0 && k > 0 && inside !== shape[o + 1] < 0) {
          quad(w, vAt(i, j, k), vAt(i, j - 1, k), vAt(i, j - 1, k - 1), vAt(i, j, k - 1), inside);
        }
        if (i > 0 && k > 0 && inside !== shape[o + sy] < 0) {
          quad(w, vAt(i, j, k), vAt(i, j, k - 1), vAt(i - 1, j, k - 1), vAt(i - 1, j, k), inside);
        }
        if (i > 0 && j > 0 && inside !== shape[o + sz] < 0) {
          quad(w, vAt(i, j, k), vAt(i - 1, j, k), vAt(i - 1, j - 1, k), vAt(i, j - 1, k), inside);
        }
      }
    }
  }

  function quad(wr: Writer, q0: number, q1: number, q2: number, q3: number, outward: boolean): void {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) return;
    if (!outward) { const t = q1; q1 = q3; q3 = t; }
    // Split along the shorter diagonal for better-shaped triangles.
    const p = wr.pos, a = (vBase + q0) * 3, bq = (vBase + q1) * 3, cq = (vBase + q2) * 3, dq = (vBase + q3) * 3;
    const d02 = (p[a] - p[cq]) ** 2 + (p[a + 1] - p[cq + 1]) ** 2 + (p[a + 2] - p[cq + 2]) ** 2;
    const d13 = (p[bq] - p[dq]) ** 2 + (p[bq + 1] - p[dq + 1]) ** 2 + (p[bq + 2] - p[dq + 2]) ** 2;
    if (d02 <= d13) { wr.tri(q0, q1, q2); wr.tri(q0, q2, q3); } else { wr.tri(q0, q1, q3); wr.tri(q1, q2, q3); }
  }
}
