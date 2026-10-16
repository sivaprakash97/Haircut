import { NODES, type LockData } from './locks';

// Undo and redo for strokes. A stroke copies a lock's style (rest shape,
// length, gel, cut end, colour) the first time it touches that lock; when the
// stroke ends the new style is copied too. Undo and redo restore exact values.

const PER_LOCK = NODES * 3 + 4;
/** History is capped by memory, not by step count. */
const MAX_BYTES = 48 * 1024 * 1024;

interface Entry {
  locks: Int32Array;
  /** Style of each lock before the stroke, then after it: PER_LOCK floats each. */
  before: Float32Array;
  after: Float32Array;
  color: Uint32Array;
}

export class History {
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private current: Map<number, number> | null = null;
  private scratch: Float32Array = new Float32Array(0);
  private scratchColor: number[] = [];
  private bytes = 0;

  constructor(private readonly L: LockData) {}

  get inStroke(): boolean {
    return this.current !== null;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  begin(): void {
    this.current = new Map();
    this.scratchColor = [];
  }

  /** Call before changing lock `i`'s style during a stroke. */
  touch(i: number): void {
    const cur = this.current;
    if (!cur || cur.has(i)) return;
    const slot = cur.size;
    cur.set(i, slot);
    if ((slot + 1) * PER_LOCK > this.scratch.length) {
      const next = new Float32Array(Math.max(PER_LOCK * 64, this.scratch.length * 2));
      next.set(this.scratch);
      this.scratch = next;
    }
    this.save(i, this.scratch, slot * PER_LOCK);
    this.scratchColor.push(this.L.color[i]);
  }

  /** Ends the stroke; returns false if it changed nothing (no history entry). */
  commit(): boolean {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.size === 0) return false;
    const locks = Int32Array.from(cur.keys());
    const before = this.scratch.slice(0, locks.length * PER_LOCK);
    const after = new Float32Array(before.length);
    let changed = false;
    for (let s = 0; s < locks.length; s++) {
      this.save(locks[s], after, s * PER_LOCK);
      if (!changed) {
        for (let k = s * PER_LOCK; k < (s + 1) * PER_LOCK; k++) {
          if (after[k] !== before[k]) {
            changed = true;
            break;
          }
        }
        if (this.L.color[locks[s]] !== this.scratchColor[s]) changed = true;
      }
    }
    if (!changed) return false;
    const color = new Uint32Array(locks.length * 2);
    for (let s = 0; s < locks.length; s++) {
      color[s * 2] = this.scratchColor[s];
      color[s * 2 + 1] = this.L.color[locks[s]];
    }
    this.push({ locks, before, after, color });
    return true;
  }

  /** Restores the state before the last stroke; returns the locks that changed. */
  undo(): Int32Array | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push(e);
    this.apply(e, false);
    return e.locks;
  }

  redo(): Int32Array | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push(e);
    this.apply(e, true);
    return e.locks;
  }

  private push(e: Entry): void {
    for (const r of this.redoStack) this.bytes -= size(r);
    this.redoStack.length = 0;
    this.undoStack.push(e);
    this.bytes += size(e);
    while (this.bytes > MAX_BYTES && this.undoStack.length > 1) this.bytes -= size(this.undoStack.shift()!);
  }

  private apply(e: Entry, after: boolean): void {
    const src = after ? e.after : e.before;
    for (let s = 0; s < e.locks.length; s++) {
      const i = e.locks[s];
      this.load(i, src, s * PER_LOCK);
      this.L.color[i] = e.color[s * 2 + (after ? 1 : 0)];
    }
  }

  private save(i: number, out: Float32Array, o: number): void {
    const L = this.L;
    out.set(L.rest.subarray(i * NODES * 3, (i + 1) * NODES * 3), o);
    const t = o + NODES * 3;
    out[t] = L.len[i];
    out[t + 1] = L.hold[i];
    out[t + 2] = L.blunt[i];
  }

  private load(i: number, src: Float32Array, o: number): void {
    const L = this.L;
    L.rest.set(src.subarray(o, o + NODES * 3), i * NODES * 3);
    const t = o + NODES * 3;
    L.len[i] = src[t];
    L.hold[i] = src[t + 1];
    L.blunt[i] = src[t + 2];
  }
}

function size(e: Entry): number {
  return e.before.byteLength * 2 + e.locks.byteLength + e.color.byteLength;
}
