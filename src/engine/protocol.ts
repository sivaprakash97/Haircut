import type { PresetId } from './presetIds';
import type { MeshBatch } from './surfaceNets';

export interface BuildRequest {
  type: 'build';
  id: number;
  preset: PresetId;
  /** Cell size in metres. */
  cell: number;
}

export interface MeshPayload extends MeshBatch {
  /** Brick counts per axis of the grid the batch came from. */
  brickDims: [number, number, number];
}

export interface BuildStats {
  cells: number;
  fieldMs: number;
  meshMs: number;
  headMs: number;
}

export interface BuildResult {
  type: 'built';
  id: number;
  preset: PresetId;
  cell: number;
  hair: MeshPayload;
  head: MeshPayload;
  stats: BuildStats;
}

export interface WorkerFailure {
  type: 'error';
  id: number;
  message: string;
}

export type FromWorker = BuildResult | WorkerFailure;

export function payloadTransfers(p: MeshPayload): ArrayBuffer[] {
  return [p.table.buffer, p.positions.buffer, p.normals.buffer, p.colors.buffer, p.indices.buffer] as ArrayBuffer[];
}
