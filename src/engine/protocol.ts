import type { BodyGrid } from '../hair/body';
import type { LockData } from '../hair/locks';
import type { MeshBatch } from './surfaceNets';

// Messages between the page and the build worker. The worker builds the
// things that are slow to compute and never change while styling: the head
// mesh (per quality setting), the collision body, and the starting hair.

export interface HeadRequest {
  type: 'head';
  id: number;
  /** Cell size in metres. */
  cell: number;
}

export interface HairRequest {
  type: 'hair';
  id: number;
}

export type ToWorker = HeadRequest | HairRequest;

export interface MeshPayload extends MeshBatch {
  /** Brick counts per axis of the grid the batch came from. */
  brickDims: [number, number, number];
}

export interface HeadResult {
  type: 'head';
  id: number;
  cell: number;
  head: MeshPayload;
  ms: number;
}

export interface HairResult {
  type: 'hair';
  id: number;
  body: BodyGrid;
  locks: LockData;
  /** Time to build the collision body and the starting hair. */
  bodyMs: number;
  locksMs: number;
}

export interface WorkerFailure {
  type: 'error';
  id: number;
  message: string;
}

export type FromWorker = HeadResult | HairResult | WorkerFailure;

export function payloadTransfers(p: MeshPayload): ArrayBuffer[] {
  return [p.table.buffer, p.positions.buffer, p.normals.buffer, p.colors.buffer, p.holds.buffer, p.indices.buffer] as ArrayBuffer[];
}
