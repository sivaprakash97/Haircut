import { BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3, type Material } from 'three';
import type { MeshPayload } from '../engine/protocol';
import { TABLE_STRIDE } from '../engine/surfaceNets';

/** Bricks per render chunk along each axis: tens of draw calls instead of thousands. */
const CHUNK = 4;

interface BrickData {
  pos: Float32Array;
  nrm: Int8Array;
  col: Uint8Array;
  hold: Uint8Array;
  idx: Uint32Array;
}

interface Chunk {
  bricks: Map<number, BrickData>;
  geometry: BufferGeometry | null;
  capV: number;
  capI: number;
  fill: Mesh | null;
  outline: Mesh | null;
}

/**
 * The editable hair: per-brick meshes from the worker, grouped into render
 * chunks. An edit rebuilds only the chunks containing changed bricks, reusing
 * GPU buffers when the new data fits and uploading just the used range.
 */
export class HairMesh {
  readonly fills = new Group();
  readonly outlines = new Group();
  triangles = 0;
  private readonly chunks = new Map<number, Chunk>();
  private dims: [number, number, number] = [1, 1, 1];

  constructor(private readonly material: Material, private readonly outlineMaterial: Material) {}

  apply(p: MeshPayload, replaceAll: boolean): void {
    if (replaceAll) this.clear();
    this.dims = p.brickDims;
    const touched = new Set<number>();
    for (let t = 0; t < p.table.length; t += TABLE_STRIDE) {
      const b = p.table[t], v0 = p.table[t + 1], vc = p.table[t + 2], i0 = p.table[t + 3], ic = p.table[t + 4];
      const key = this.chunkKey(b);
      let chunk = this.chunks.get(key);
      if (!chunk) this.chunks.set(key, (chunk = { bricks: new Map(), geometry: null, capV: 0, capI: 0, fill: null, outline: null }));
      if (ic === 0) {
        chunk.bricks.delete(b);
      } else {
        chunk.bricks.set(b, {
          pos: p.positions.slice(v0 * 3, (v0 + vc) * 3),
          nrm: p.normals.slice(v0 * 3, (v0 + vc) * 3),
          col: p.colors.slice(v0 * 4, (v0 + vc) * 4),
          hold: p.holds.slice(v0, v0 + vc),
          idx: p.indices.slice(i0, i0 + ic),
        });
      }
      touched.add(key);
    }
    for (const key of touched) this.rebuild(key);
    this.triangles = 0;
    for (const c of this.chunks.values()) for (const b of c.bricks.values()) this.triangles += b.idx.length / 3;
  }

  clear(): void {
    for (const key of [...this.chunks.keys()]) this.drop(key);
    this.triangles = 0;
  }

  private chunkKey(b: number): number {
    const [bx, by] = this.dims;
    const x = b % bx, y = ((b / bx) | 0) % by, z = (b / (bx * by)) | 0;
    return ((z / CHUNK) | 0) * 1_000_000 + ((y / CHUNK) | 0) * 1000 + ((x / CHUNK) | 0);
  }

  private drop(key: number): void {
    const c = this.chunks.get(key);
    if (!c) return;
    if (c.fill) this.fills.remove(c.fill);
    if (c.outline) this.outlines.remove(c.outline);
    c.geometry?.dispose();
    this.chunks.delete(key);
  }

  private rebuild(key: number): void {
    const c = this.chunks.get(key)!;
    let nv = 0, ni = 0;
    for (const b of c.bricks.values()) { nv += b.pos.length / 3; ni += b.idx.length; }
    if (ni === 0) return this.drop(key);

    if (!c.geometry || nv > c.capV || ni > c.capI) {
      // Grow with headroom so later strokes usually fit in place.
      c.capV = Math.ceil(nv * 1.5) + 64;
      c.capI = Math.ceil(ni * 1.5) + 192;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(c.capV * 3), 3));
      g.setAttribute('normal', new BufferAttribute(new Int8Array(c.capV * 3), 3, true));
      g.setAttribute('aColor', new BufferAttribute(new Uint8Array(c.capV * 4), 4, true));
      g.setAttribute('aHold', new BufferAttribute(new Uint8Array(c.capV), 1, true));
      g.setIndex(new BufferAttribute(c.capV > 65535 ? new Uint32Array(c.capI) : new Uint16Array(c.capI), 1));
      c.geometry?.dispose();
      c.geometry = g;
      if (!c.fill) {
        c.fill = new Mesh(g, this.material);
        c.outline = new Mesh(g, this.outlineMaterial);
        this.fills.add(c.fill);
        this.outlines.add(c.outline!);
      } else {
        c.fill.geometry = g;
        c.outline!.geometry = g;
      }
    }

    const g = c.geometry;
    const pos = g.getAttribute('position') as BufferAttribute, nrm = g.getAttribute('normal') as BufferAttribute;
    const col = g.getAttribute('aColor') as BufferAttribute, hold = g.getAttribute('aHold') as BufferAttribute;
    const index = g.getIndex()!;
    const P = pos.array as Float32Array, N = nrm.array as Int8Array, C = col.array as Uint8Array, H = hold.array as Uint8Array;
    const I = index.array as Uint16Array | Uint32Array;
    let v = 0, i = 0;
    for (const b of c.bricks.values()) {
      const vc = b.pos.length / 3;
      P.set(b.pos, v * 3); N.set(b.nrm, v * 3); C.set(b.col, v * 4); H.set(b.hold, v);
      for (let k = 0; k < b.idx.length; k++) I[i + k] = b.idx[k] + v;
      v += vc; i += b.idx.length;
    }
    for (const [attr, size] of [[pos, 3], [nrm, 3], [col, 4], [hold, 1]] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, v * size);
      attr.needsUpdate = true;
    }
    index.clearUpdateRanges();
    index.addUpdateRange(0, i);
    index.needsUpdate = true;
    g.setDrawRange(0, i);
    g.boundingSphere = boundingSphere(P, v);
  }
}

/** Bounding sphere of the first `n` vertices (the rest of the buffer is spare capacity). */
function boundingSphere(p: Float32Array, n: number): Sphere {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let v = 0; v < n * 3; v += 3) {
    x0 = Math.min(x0, p[v]); y0 = Math.min(y0, p[v + 1]); z0 = Math.min(z0, p[v + 2]);
    x1 = Math.max(x1, p[v]); y1 = Math.max(y1, p[v + 1]); z1 = Math.max(z1, p[v + 2]);
  }
  const c = new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  let r2 = 0;
  for (let v = 0; v < n * 3; v += 3) r2 = Math.max(r2, (p[v] - c.x) ** 2 + (p[v + 1] - c.y) ** 2 + (p[v + 2] - c.z) ** 2);
  return new Sphere(c, Math.sqrt(r2));
}
