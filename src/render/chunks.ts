import { BufferAttribute, BufferGeometry } from 'three';
import type { MeshPayload } from '../engine/protocol';
import { TABLE_STRIDE } from '../engine/surfaceNets';

/** One geometry holding every brick in the payload. */
export function singleGeometry(p: MeshPayload): BufferGeometry | null {
  const rows: number[] = [];
  for (let t = 0; t < p.table.length; t += TABLE_STRIDE) rows.push(t);
  return geometryFromRows(p, rows);
}

function geometryFromRows(p: MeshPayload, rows: number[]): BufferGeometry | null {
  let nv = 0, ni = 0;
  for (const t of rows) { nv += p.table[t + 2]; ni += p.table[t + 4]; }
  if (ni === 0) return null;
  const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 3), col = new Uint8Array(nv * 4), hold = new Uint8Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let v = 0, i = 0;
  for (const t of rows) {
    const v0 = p.table[t + 1], vc = p.table[t + 2], i0 = p.table[t + 3], ic = p.table[t + 4];
    pos.set(p.positions.subarray(v0 * 3, (v0 + vc) * 3), v * 3);
    nrm.set(p.normals.subarray(v0 * 3, (v0 + vc) * 3), v * 3);
    col.set(p.colors.subarray(v0 * 4, (v0 + vc) * 4), v * 4);
    hold.set(p.holds.subarray(v0, v0 + vc), v);
    for (let k = 0; k < ic; k++) idx[i + k] = p.indices[i0 + k] + v;
    v += vc; i += ic;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3, true));
  g.setAttribute('aColor', new BufferAttribute(col, 4, true));
  g.setAttribute('aHold', new BufferAttribute(hold, 1, true));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
