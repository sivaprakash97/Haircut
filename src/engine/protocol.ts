import type { Ray } from './pick';
import type { PresetId } from './presetIds';
import type { MeshBatch } from './surfaceNets';

export type ToolId = 'scissors' | 'comb' | 'grow' | 'extrude' | 'gel' | 'dryer';

export interface BuildRequest {
  type: 'build';
  id: number;
  preset: PresetId;
  /** Cell size in metres. */
  cell: number;
}

export interface PickRequest {
  type: 'pick';
  id: number;
  ray: Ray;
}

export interface StrokeRequest {
  type: 'stroke';
  id: number;
  phase: 'begin' | 'move' | 'end';
  tool: ToolId;
  ray: Ray;
  /** Brush radius in metres. */
  radius: number;
  /** 0..1 */
  strength: number;
  /** Also apply the stroke mirrored across the face's centre line. */
  mirror: boolean;
  /** Seconds since the previous stroke message (for time-based tools). */
  dt: number;
}

export interface HistoryRequest {
  type: 'history';
  id: number;
  action: 'undo' | 'redo' | 'reset';
}

/** Test hook: a checksum of the whole hair field. */
export interface DebugRequest {
  type: 'debug';
  id: number;
}

export type ToWorker = BuildRequest | PickRequest | StrokeRequest | HistoryRequest | DebugRequest;

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

export interface HitInfo {
  p: [number, number, number];
  n: [number, number, number];
  surface: 'hair' | 'head';
}

export interface HistoryState {
  undo: number;
  redo: number;
}

export interface BuildResult {
  type: 'built';
  id: number;
  preset: PresetId;
  cell: number;
  hair: MeshPayload;
  head: MeshPayload;
  stats: BuildStats;
  history: HistoryState;
}

export interface PickResult {
  type: 'picked';
  id: number;
  hit: HitInfo | null;
}

export interface EditResult {
  type: 'edited';
  id: number;
  /** Re-meshed bricks (empty bricks included so they can be cleared). */
  hair: MeshPayload | null;
  /** True when `hair` replaces every brick (reset, undoing a reset). */
  replaceAll: boolean;
  /** Where the pointer ray hits now (for the brush cursor). */
  hit: HitInfo | null;
  /** Pieces cut loose this stroke, to animate falling away. */
  debris: MeshPayload[];
  history: HistoryState;
  /** Worker time spent on this message. */
  ms: number;
}

export interface DebugResult {
  type: 'debug';
  id: number;
  checksum: number;
  insideCells: number;
}

export interface WorkerFailure {
  type: 'error';
  id: number;
  message: string;
}

export type FromWorker = BuildResult | PickResult | EditResult | DebugResult | WorkerFailure;

export function payloadTransfers(p: MeshPayload): ArrayBuffer[] {
  return [p.table.buffer, p.positions.buffer, p.normals.buffer, p.colors.buffer, p.holds.buffer, p.indices.buffer] as ArrayBuffer[];
}
