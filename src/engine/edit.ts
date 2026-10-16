import { BRICK, type CellBox, type Field } from './grid';

const B3 = BRICK * BRICK * BRICK;
/** Extra cells re-meshed around a finished stroke so baked occlusion catches up with the change. */
const AO_MARGIN = 4;

export interface BrickSnap {
  shape: Int8Array;
  color: Uint16Array;
  hold: Uint8Array;
}

interface FullSnap {
  shape: Int8Array;
  color: Uint16Array;
  hold: Uint8Array;
  near: Uint8Array;
}

type Step =
  | { kind: 'bricks'; before: Map<number, BrickSnap>; after: Map<number, BrickSnap>; bytes: number }
  | { kind: 'full'; before: FullSnap; after: FullSnap; bytes: number };

const SNAP_BYTES = B3 * 4; // 1 shape + 2 colour + 1 hold

/**
 * Owns edits to a Field: strokes are transactions that copy each 8³ brick the
 * first time they touch it, so undo/redo restore exact bytes. Also tracks
 * which bricks need re-meshing.
 */
export class Editor {
  private readonly initial: FullSnap;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private bytes = 0;
  private tx: Map<number, BrickSnap> | null = null;
  private txBox: CellBox | null = null;
  private readonly dirty = new Set<number>();
  private remeshAll = false;
  /** While a live preview is re-stamped, dirty bricks are decided by comparing contents instead. */
  private previewing = false;

  constructor(readonly field: Field, readonly maxBytes = 64 * 1024 * 1024) {
    this.initial = fullSnap(field);
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  get inStroke(): boolean {
    return this.tx !== null;
  }

  begin(): void {
    this.tx = new Map();
    this.txBox = null;
  }

  /** Call before writing any cell in `box`: snapshots bricks for undo and marks meshes dirty. */
  touch(box: CellBox): void {
    const f = this.field;
    if (this.tx) {
      for (let bz = (box.k0 / BRICK) | 0; bz <= ((box.k1 / BRICK) | 0); bz++) {
        for (let by = (box.j0 / BRICK) | 0; by <= ((box.j1 / BRICK) | 0); by++) {
          for (let bx = (box.i0 / BRICK) | 0; bx <= ((box.i1 / BRICK) | 0); bx++) {
            const b = bx + f.bx * (by + f.by * bz);
            if (!this.tx.has(b)) this.tx.set(b, snapBrick(f, b));
          }
        }
      }
      this.txBox = this.txBox ? union(this.txBox, box) : { ...box };
    }
    f.markNear(box);
    this.markDirty(box);
  }

  /**
   * Live previews (extrude) revert the stroke and re-stamp it every frame. Bracketing that
   * with previewStart/previewEnd re-meshes only bricks whose contents actually changed.
   */
  previewStart(): Map<number, BrickSnap> {
    const now = new Map<number, BrickSnap>();
    if (this.tx) for (const b of this.tx.keys()) now.set(b, snapBrick(this.field, b));
    this.previewing = true;
    return now;
  }

  previewEnd(prev: Map<number, BrickSnap>): void {
    this.previewing = false;
    if (!this.tx) return;
    for (const [b, before] of this.tx) {
      const old = prev.get(b) ?? before; // bricks first touched this frame held their pre-stroke state
      if (!sameSnap(old, snapBrick(this.field, b))) this.markDirty(brickBox(this.field, b));
    }
  }

  /** Restores every brick touched by the open stroke (for live previews such as extrude). */
  revertStroke(): void {
    if (!this.tx) return;
    for (const [b, snap] of this.tx) {
      writeBrick(this.field, b, snap);
      this.markDirty(brickBox(this.field, b));
    }
  }

  /** Ends the stroke; returns false if it changed nothing. */
  commit(): boolean {
    const tx = this.tx;
    this.tx = null;
    if (!tx || tx.size === 0) return false;
    if (this.txBox) this.markDirty(grow(this.txBox, AO_MARGIN, this.field));
    const after = new Map<number, BrickSnap>();
    let changed = false;
    for (const [b, before] of tx) {
      const now = snapBrick(this.field, b);
      after.set(b, now);
      if (!changed && !sameSnap(before, now)) changed = true;
    }
    if (!changed) return false;
    this.push({ kind: 'bricks', before: tx, after, bytes: tx.size * SNAP_BYTES * 2 });
    return true;
  }

  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.apply(step, 'before');
    this.redoStack.push(step);
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.apply(step, 'after');
    this.undoStack.push(step);
    return true;
  }

  /** Back to the starting hairstyle, as an undoable step. */
  reset(): void {
    const before = fullSnap(this.field);
    restoreFull(this.field, this.initial);
    this.push({ kind: 'full', before, after: this.initial, bytes: before.shape.length * 4 });
    this.remeshAll = true;
  }

  /** Bricks to re-mesh since the last call, or 'all'. */
  takeDirty(): number[] | 'all' {
    if (this.remeshAll) {
      this.remeshAll = false;
      this.dirty.clear();
      return 'all';
    }
    const list = [...this.dirty];
    this.dirty.clear();
    return list;
  }

  private push(step: Step): void {
    this.undoStack.push(step);
    this.bytes += step.bytes;
    for (const s of this.redoStack) this.bytes -= s.bytes;
    this.redoStack = [];
    while (this.bytes > this.maxBytes && this.undoStack.length > 1) {
      this.bytes -= this.undoStack.shift()!.bytes;
    }
  }

  private apply(step: Step, which: 'before' | 'after'): void {
    if (step.kind === 'full') {
      restoreFull(this.field, step[which]);
      this.remeshAll = true;
      return;
    }
    for (const [b, snap] of step[which]) {
      writeBrick(this.field, b, snap);
      const box = brickBox(this.field, b);
      this.field.markNear(box);
      this.markDirty(grow(box, AO_MARGIN, this.field));
    }
  }

  /**
   * Bricks whose meshes read any cell in `box`. A brick's vertices span one cell layer beyond it,
   * and their normals sample one more, so cells up to 2 layers outside a brick affect it.
   */
  private markDirty(box: CellBox): void {
    if (this.previewing) return;
    const f = this.field, m = 2;
    const b0x = Math.max(0, Math.floor((box.i0 - m) / BRICK)), b1x = Math.min(f.bx - 1, Math.floor((box.i1 + m) / BRICK));
    const b0y = Math.max(0, Math.floor((box.j0 - m) / BRICK)), b1y = Math.min(f.by - 1, Math.floor((box.j1 + m) / BRICK));
    const b0z = Math.max(0, Math.floor((box.k0 - m) / BRICK)), b1z = Math.min(f.bz - 1, Math.floor((box.k1 + m) / BRICK));
    for (let z = b0z; z <= b1z; z++) {
      for (let y = b0y; y <= b1y; y++) for (let x = b0x; x <= b1x; x++) this.dirty.add(x + f.bx * (y + f.by * z));
    }
  }
}

/** Cells owned by brick `b` (cell index / 8 = brick index). */
export function brickBox(f: Field, b: number): CellBox {
  const bx = b % f.bx, by = ((b / f.bx) | 0) % f.by, bz = (b / (f.bx * f.by)) | 0;
  return {
    i0: bx * BRICK, i1: Math.min(bx * BRICK + BRICK, f.nx) - 1,
    j0: by * BRICK, j1: Math.min(by * BRICK + BRICK, f.ny) - 1,
    k0: bz * BRICK, k1: Math.min(bz * BRICK + BRICK, f.nz) - 1,
  };
}

export function snapBrick(f: Field, b: number): BrickSnap {
  const s: BrickSnap = { shape: new Int8Array(B3), color: new Uint16Array(B3), hold: new Uint8Array(B3) };
  const box = brickBox(f, b);
  const len = box.i1 - box.i0 + 1;
  for (let k = box.k0; k <= box.k1; k++) {
    for (let j = box.j0; j <= box.j1; j++) {
      const o = f.idx(box.i0, j, k), d = ((k - box.k0) * BRICK + (j - box.j0)) * BRICK;
      s.shape.set(f.shape.subarray(o, o + len), d);
      s.color.set(f.color.subarray(o, o + len), d);
      s.hold.set(f.hold.subarray(o, o + len), d);
    }
  }
  return s;
}

export function writeBrick(f: Field, b: number, s: BrickSnap): void {
  const box = brickBox(f, b);
  const len = box.i1 - box.i0 + 1;
  for (let k = box.k0; k <= box.k1; k++) {
    for (let j = box.j0; j <= box.j1; j++) {
      const o = f.idx(box.i0, j, k), d = ((k - box.k0) * BRICK + (j - box.j0)) * BRICK;
      f.shape.set(s.shape.subarray(d, d + len), o);
      f.color.set(s.color.subarray(d, d + len), o);
      f.hold.set(s.hold.subarray(d, d + len), o);
    }
  }
}

function sameSnap(a: BrickSnap, b: BrickSnap): boolean {
  for (let i = 0; i < B3; i++) {
    if (a.shape[i] !== b.shape[i] || a.color[i] !== b.color[i] || a.hold[i] !== b.hold[i]) return false;
  }
  return true;
}

function fullSnap(f: Field): FullSnap {
  return { shape: f.shape.slice(), color: f.color.slice(), hold: f.hold.slice(), near: f.near.slice() };
}

function restoreFull(f: Field, s: FullSnap): void {
  f.shape.set(s.shape);
  f.color.set(s.color);
  f.hold.set(s.hold);
  f.near.set(s.near);
}

function union(a: CellBox, b: CellBox): CellBox {
  return {
    i0: Math.min(a.i0, b.i0), j0: Math.min(a.j0, b.j0), k0: Math.min(a.k0, b.k0),
    i1: Math.max(a.i1, b.i1), j1: Math.max(a.j1, b.j1), k1: Math.max(a.k1, b.k1),
  };
}

function grow(b: CellBox, m: number, f: Field): CellBox {
  return {
    i0: Math.max(0, b.i0 - m), j0: Math.max(0, b.j0 - m), k0: Math.max(0, b.k0 - m),
    i1: Math.min(f.nx - 1, b.i1 + m), j1: Math.min(f.ny - 1, b.j1 + m), k1: Math.min(f.nz - 1, b.k1 + m),
  };
}
