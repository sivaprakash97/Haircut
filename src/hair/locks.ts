// Hair as chunky cartoon locks: each lock is a chain of nodes rooted on the
// scalp or beard area. Everything here is plain typed arrays so the starting
// hair can be built in the worker and handed to the page without copying.
//
// "Head space" is the character's own frame (metres, y up, face toward +z);
// the character turns about the y axis, so world = R(yaw) · head.

/** Nodes per lock, root included, so a lock has at most NODES - 1 segments. */
export const NODES = 21;
/** Shortest a lock can be cut to (segments): a short stub of stubble stays on the scalp. */
export const MIN_LEN = 0.3;

/** Roots sit this far under the skin so the open end of each lock is hidden. */
export const ROOT_DEPTH = 0.003;

export const KIND_SCALP = 0;
export const KIND_BEARD = 1;

export interface LockData {
  count: number;
  /** Root in head space, 3 per lock: just under the skin, so the open end of the tube is hidden. */
  root: Float32Array;
  /** Skin normal at the root (head space), 3 per lock. */
  normal: Float32Array;
  /** Segment length (metres). */
  seg: Float32Array;
  /** Lock thickness at its widest (metres). */
  radius: Float32Array;
  /** How far the lock keeps from the skin (metres). Locks rooted higher sit further out, which gives the hair volume. */
  offset: Float32Array;
  kind: Uint8Array;
  /** Index of the lock mirrored across the face's centre line (itself on the centre line). */
  mirror: Int32Array;

  // Style: everything undo and redo restore.
  /** Shape the lock settles into, head space, NODES × 3 per lock. */
  rest: Float32Array;
  /** Visible length in segments (fractional). */
  len: Float32Array;
  /** 0 = loose, 1 = fully gelled. */
  hold: Float32Array;
  /** 1 when the end was cut flat, 0 for a natural tapered tip (growing it back blends toward 0). */
  blunt: Float32Array;
  /** 0xRRGGBB, sRGB. */
  color: Uint32Array;
}

/** Index of the last node that carries visible hair. */
export function lastNode(len: number): number {
  const n = Math.ceil(len - 1e-6);
  return n < 1 ? 1 : n > NODES - 1 ? NODES - 1 : n;
}

export function lockTransfers(d: LockData): ArrayBuffer[] {
  return [d.root, d.normal, d.seg, d.radius, d.offset, d.kind, d.mirror, d.rest, d.len, d.hold, d.blunt, d.color].map(
    (a) => a.buffer as ArrayBuffer,
  );
}

/** FNV-1a over the style arrays; equal hashes mean undo restored the exact same hair. */
export function styleChecksum(d: LockData): number {
  let h = 2166136261;
  const mix = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  };
  for (const a of [d.rest, d.len, d.hold, d.blunt, d.color]) mix(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return h >>> 0;
}
