import type { FromWorker, HairResult, HeadResult, ToWorker } from '../engine/protocol';
// Inlined into the main bundle so the worker doesn't cost a second network round trip.
import BuildWorker from '../engine/worker?worker&inline';

type Pending = { resolve: (m: FromWorker) => void; reject: (e: Error) => void };

/**
 * Promise-based wrapper around two build workers: one makes the starting hair,
 * the other the head mesh, so the two run side by side while loading.
 */
export class Engine {
  private readonly hairWorker: Worker;
  private readonly headWorker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  onFailure: ((message: string) => void) | null = null;

  constructor() {
    // Started before anything else so the workers' startup overlaps WebGL setup.
    this.hairWorker = this.start();
    this.headWorker = this.start();
  }

  private start(): Worker {
    const w = new BuildWorker();
    w.onmessage = (e: MessageEvent<FromWorker>) => {
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
    w.onerror = (e) => this.onFailure?.(`A build worker failed to start (${e.message || 'unknown error'}).`);
    return w;
  }

  /** Collision body and the starting hair. */
  hair(): Promise<HairResult> {
    return this.send({ type: 'hair' }) as Promise<HairResult>;
  }

  /** Head mesh at a quality's cell size. */
  head(cell: number): Promise<HeadResult> {
    return this.send({ type: 'head', cell }) as Promise<HeadResult>;
  }

  private send(msg: DistributiveOmit<ToWorker, 'id'>): Promise<FromWorker> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (msg.type === 'hair' ? this.hairWorker : this.headWorker).postMessage({ ...msg, id } as ToWorker);
    });
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
