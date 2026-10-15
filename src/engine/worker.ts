import { buildField } from './build';
import { Field } from './grid';
import { HEAD_BOUNDS, headSDF, sampleHead } from './head';
import { HAIR_BOUNDS, PRESETS } from './presets';
import { type BuildRequest, type BuildResult, type FromWorker, type MeshPayload, payloadTransfers } from './protocol';
import { type MeshBatch, meshBricks } from './surfaceNets';

// Runs off the main thread: builds the head and hair volumes and meshes them.
// The hair Field stays here so later milestones can edit it in place.

interface WorkerScope {
  onmessage: ((e: MessageEvent<BuildRequest>) => void) | null;
  postMessage(message: FromWorker, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let hair: Field | null = null;

scope.onmessage = (e) => {
  const req = e.data;
  try {
    const result = build(req);
    scope.postMessage(result, [...payloadTransfers(result.hair), ...payloadTransfers(result.head)]);
  } catch (err) {
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) }, []);
  }
};

function build(req: BuildRequest): BuildResult {
  const preset = PRESETS[req.preset];

  let t = performance.now();
  hair = new Field(HAIR_BOUNDS, req.cell);
  buildField(hair, preset.sample, preset.lipschitz);
  const fieldMs = performance.now() - t;

  t = performance.now();
  const hairField = hair;
  const hairMesh = meshBricks(hairField, undefined, { ao: 1.25, occluder: headSDF });
  const meshMs = performance.now() - t;

  t = performance.now();
  const head = new Field(HEAD_BOUNDS, req.cell);
  buildField(head, sampleHead, 1.2);
  const headMesh = meshBricks(head, undefined, {
    ao: 1.1,
    occluder: (x, y, z) => hairField.sampleWorld(x, y, z),
  });
  const headMs = performance.now() - t;

  return {
    type: 'built',
    id: req.id,
    preset: req.preset,
    cell: req.cell,
    hair: payload(hairMesh, hairField),
    head: payload(headMesh, head),
    stats: { cells: hairField.cellCount, fieldMs, meshMs, headMs },
  };
}

function payload(batch: MeshBatch, f: Field): MeshPayload {
  return { ...batch, brickDims: [f.bx, f.by, f.bz] };
}
