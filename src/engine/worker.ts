import { Body } from '../hair/body';
import { generateLocks } from '../hair/generate';
import { lockTransfers } from '../hair/locks';
import { buildBodyGrid } from './bodyGrid';
import { buildField } from './build';
import { Field } from './grid';
import { HEAD_BOUNDS, sampleHead } from './head';
import { type FromWorker, type MeshPayload, type ToWorker, payloadTransfers } from './protocol';
import { meshBricks } from './surfaceNets';

// Off the main thread: builds the head mesh, the collision body and the
// starting hair, then hands them to the page (typed arrays are transferred,
// not copied).

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'head') {
      const t = performance.now();
      const f = new Field(HEAD_BOUNDS, msg.cell);
      buildField(f, sampleHead, 1.2);
      const head: MeshPayload = { ...meshBricks(f, undefined, { ao: 1.1 }), brickDims: [f.bx, f.by, f.bz] };
      scope.postMessage({ type: 'head', id: msg.id, cell: msg.cell, head, ms: performance.now() - t }, payloadTransfers(head));
    } else {
      let t = performance.now();
      const grid = buildBodyGrid();
      const bodyMs = performance.now() - t;
      t = performance.now();
      const locks = generateLocks(new Body(grid));
      const locksMs = performance.now() - t;
      scope.postMessage({ type: 'hair', id: msg.id, body: grid, locks, bodyMs, locksMs }, [grid.data.buffer as ArrayBuffer, ...lockTransfers(locks)]);
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) }, []);
  }
};
