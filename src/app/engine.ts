import type { Ray } from '../engine/pick';
import type { PresetId } from '../engine/presetIds';
import type {
  BuildResult, DebugResult, EditResult, FromWorker, PickResult, StrokeRequest, ToWorker,
} from '../engine/protocol';
// Inlined into the main bundle so the worker doesn't cost a second network round trip.
import EngineWorker from '../engine/worker?worker&inline';

type Pending = { resolve: (m: FromWorker) => void; reject: (e: Error) => void };

/** Promise-based wrapper around the engine worker. Replies arrive in request order. */
export class Engine {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  onFailure: ((message: string) => void) | null = null;

  constructor() {
    // Started before anything else so the worker's startup overlaps WebGL setup.
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        p?.reject(new Error(msg.message));
        this.onFailure?.(msg.message);
      } else {
        p?.resolve(msg);
      }
    };
    this.worker.onerror = (e) => this.onFailure?.(`The hair worker failed to start (${e.message || 'unknown error'}).`);
  }

  build(preset: PresetId, cell: number): Promise<BuildResult> {
    return this.send({ type: 'build', preset, cell }) as Promise<BuildResult>;
  }

  pick(ray: Ray): Promise<PickResult> {
    return this.send({ type: 'pick', ray }) as Promise<PickResult>;
  }

  stroke(req: Omit<StrokeRequest, 'type' | 'id'>): Promise<EditResult> {
    return this.send({ type: 'stroke', ...req }) as Promise<EditResult>;
  }

  history(action: 'undo' | 'redo' | 'reset'): Promise<EditResult> {
    return this.send({ type: 'history', action }) as Promise<EditResult>;
  }

  debug(): Promise<DebugResult> {
    return this.send({ type: 'debug' }) as Promise<DebugResult>;
  }

  private send(msg: DistributiveOmit<ToWorker, 'id'>): Promise<FromWorker> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id } as ToWorker);
    });
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
