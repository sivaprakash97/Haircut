import type { Editor } from './edit';
import { BRICK, Field } from './grid';
import { type MeshBatch, meshBricks } from './surfaceNets';
import type { DistFn } from './tools';

let visited = new Uint8Array(0);
let queue = new Int32Array(0);

/**
 * Indices of material cells no longer connected to the scalp (6-connected
 * flood fill from cells touching the head).
 */
export function findDetached(f: Field, head: DistFn): Int32Array {
  const { nx, ny, nz, shape, cell, ox, oy, oz } = f;
  const n = shape.length;
  if (visited.length < n) {
    visited = new Uint8Array(n);
    queue = new Int32Array(n);
  } else {
    visited.fill(0, 0, n);
  }
  const touch = cell * 1.5;
  let qt = 0;
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      let o = f.idx(1, j, k);
      for (let i = 1; i < nx - 1; i++, o++) {
        if (shape[o] >= 0) continue;
        if (head(ox + i * cell, oy + j * cell, oz + k * cell) < touch) {
          visited[o] = 1;
          queue[qt++] = o;
        }
      }
    }
  }
  const sy = nx, sz = nx * ny;
  for (let qh = 0; qh < qt; qh++) {
    const o = queue[qh];
    // Boundary cells are always outside, so neighbours never leave the grid.
    for (const m of [o - 1, o + 1, o - sy, o + sy, o - sz, o + sz]) {
      if (!visited[m] && shape[m] < 0) {
        visited[m] = 1;
        queue[qt++] = m;
      }
    }
  }
  const out: number[] = [];
  for (let o = 0; o < n; o++) if (shape[o] < 0 && !visited[o]) out.push(o);
  return Int32Array.from(out);
}

/**
 * Removes loose pieces from the field (inside the open stroke, so undo brings
 * them back) and returns a mesh of them for the falling animation.
 */
export function removeDetached(ed: Editor, head: DistFn, minCellsForMesh = 24): MeshBatch | null {
  const f = ed.field;
  const cells = findDetached(f, head);
  if (cells.length === 0) return null;
  const { nx, ny } = f;
  let i0 = Infinity, j0 = Infinity, k0 = Infinity, i1 = -1, j1 = -1, k1 = -1;
  const bricks = new Set<number>();
  for (const o of cells) {
    const i = o % nx, j = ((o / nx) | 0) % ny, k = (o / (nx * ny)) | 0;
    i0 = Math.min(i0, i); j0 = Math.min(j0, j); k0 = Math.min(k0, k);
    i1 = Math.max(i1, i); j1 = Math.max(j1, j); k1 = Math.max(k1, k);
    bricks.add(((i / BRICK) | 0) + f.bx * (((j / BRICK) | 0) + f.by * ((k / BRICK) | 0)));
  }

  // Mesh the loose material on its own before removing it.
  let mesh: MeshBatch | null = null;
  if (cells.length >= minCellsForMesh) {
    const pad = 2;
    const piece = new Field(
      {
        min: [f.ox + (i0 - pad) * f.cell, f.oy + (j0 - pad) * f.cell, f.oz + (k0 - pad) * f.cell],
        max: [f.ox + (i1 + pad) * f.cell, f.oy + (j1 + pad) * f.cell, f.oz + (k1 + pad) * f.cell],
      },
      f.cell,
      f.band / f.cell,
    );
    piece.shape.fill(127);
    for (const o of cells) {
      const i = o % nx, j = ((o / nx) | 0) % ny, k = (o / (nx * ny)) | 0;
      const p = piece.idx(i - i0 + pad, j - j0 + pad, k - k0 + pad);
      piece.shape[p] = f.shape[o];
      piece.color[p] = f.color[o];
      piece.hold[p] = f.hold[o];
    }
    piece.near.fill(1);
    mesh = meshBricks(piece, undefined, { ao: 0.8 });
  }

  for (const b of bricks) {
    const bx = b % f.bx, by = ((b / f.bx) | 0) % f.by, bz = (b / (f.bx * f.by)) | 0;
    const box = f.boxAround(
      f.ox + bx * BRICK * f.cell, f.oy + by * BRICK * f.cell, f.oz + bz * BRICK * f.cell,
      f.ox + (bx * BRICK + BRICK - 1) * f.cell, f.oy + (by * BRICK + BRICK - 1) * f.cell, f.oz + (bz * BRICK + BRICK - 1) * f.cell,
    );
    if (box) ed.touch(box);
  }
  for (const o of cells) f.shape[o] = 127;
  return mesh;
}
