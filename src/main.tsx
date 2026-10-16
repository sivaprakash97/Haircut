import { render } from 'preact';
import { isPresetId } from './engine/presetIds';
// Inlined into the main bundle so the worker doesn't cost a second network round trip.
import EngineWorker from './engine/worker?worker&inline';
import type { BuildRequest, FromWorker } from './engine/protocol';
import { QUALITY, TIERS, autoTier, type Tier } from './render/quality';
import { Stage } from './render/stage';
import { App, type AppState, effectiveTier } from './ui/App';
import { createStore } from './ui/store';

// Milliseconds since navigation start for each loading phase (shown in Details and copied with results).
const marks = { code: performance.now(), setup: 0, requested: 0, built: 0, ready: 0, hidden: document.visibilityState === 'hidden' };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !marks.ready) marks.hidden = true; // background tabs pause drawing
});

// Start the worker first so its startup overlaps WebGL setup.
const worker = new EngineWorker();

// URL parameters let a specific setup be shared or tested, e.g. ?preset=afro&quality=light&grain=1
const params = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean) => (params.has(name) ? params.get(name) !== '0' : fallback);
const qParam = params.get('quality');

const store = createStore<AppState>({
  phase: 'loading',
  error: '',
  preset: isPresetId(params.get('preset')) ? (params.get('preset') as AppState['preset']) : 'quiff',
  tierChoice: TIERS.includes(qParam as Tier) ? (qParam as Tier) : 'auto',
  autoTier: 'standard',
  look: { outline: flag('outline', true), ao: flag('ao', true), grain: flag('grain', false) },
  gpu: '',
  building: false,
  build: null,
  frame: null,
  loadMs: 0,
  timing: null,
  downloadKB: 0,
  benchRunning: false,
  bench: null,
});

declare global {
  interface Window {
    __haircut?: { ready: boolean; state: () => AppState; draws: () => number };
  }
}
window.__haircut = { ready: false, state: store.get, draws: () => stage?.drawCount ?? 0 };

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const loader = document.getElementById('loader');

function fail(message: string): void {
  store.set({ phase: 'error', error: message, building: false });
  if (loader) {
    loader.classList.add('failed');
    const p = loader.querySelector('p');
    if (p) p.textContent = message;
  }
}

let stage: Stage | null = null;
try {
  stage = new Stage(canvas);
} catch {
  fail('This browser could not start WebGL 2, which Haircut Playground needs.');
}

if (stage) start(stage);

function start(stage: Stage): void {
  const coarse = matchMedia('(pointer: coarse)').matches;
  store.set({ gpu: stage.gpu, autoTier: autoTier(stage.gpu, coarse) });
  stage.setLook(store.get().look);
  stage.setMaxDpr(QUALITY[effectiveTier(store.get())].maxDpr);
  stage.onStats = (frame) => store.set({ frame });
  marks.setup = performance.now();

  let requestId = 0;
  let requestedAt = 0;

  const rebuild = () => {
    const s = store.get();
    requestId++;
    requestedAt = performance.now();
    store.set({ building: true, bench: null });
    const req: BuildRequest = { type: 'build', id: requestId, preset: s.preset, cell: QUALITY[effectiveTier(s)].cell };
    worker.postMessage(req);
  };

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.id !== requestId) return; // superseded by a newer request
    if (msg.type === 'error') {
      fail(`Building the hair failed: ${msg.message}`);
      return;
    }
    stage.setHead(msg.head);
    stage.setHair(msg.hair);
    const totalMs = performance.now() - requestedAt;
    const build = { ...msg.stats, totalMs, cellMm: msg.cell * 1000 };
    if (store.get().phase === 'loading') {
      marks.built = performance.now();
      // Measure once the first frame with hair has been drawn.
      requestAnimationFrame(() => {
        marks.ready = performance.now();
        const html = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.responseEnd ?? 0;
        const timing = {
          pageMs: html,
          codeMs: marks.code - html,
          setupMs: marks.setup - marks.code,
          hairMs: marks.built - marks.requested,
          frameMs: marks.ready - marks.built,
          backgrounded: marks.hidden,
        };
        store.set({ phase: 'ready', building: false, build, loadMs: marks.ready, timing, downloadKB: downloadedKB() });
        loader?.classList.add('done');
        window.__haircut!.ready = true;
      });
    } else {
      store.set({ building: false, build });
    }
  };
  worker.onerror = (e) => fail(`The hair worker failed to start (${e.message || 'unknown error'}).`);

  // Request the hair before drawing the UI so the build starts as early as possible.
  rebuild();
  marks.requested = requestedAt;

  render(
    <App
      store={store}
      actions={{
        setPreset(id) {
          if (id === store.get().preset) return;
          store.set({ preset: id });
          rebuild();
        },
        setTier(t) {
          const before = effectiveTier(store.get());
          store.set({ tierChoice: t });
          const tier = effectiveTier(store.get());
          stage.setMaxDpr(QUALITY[tier].maxDpr);
          if (tier !== before) rebuild();
        },
        setLook(look) {
          store.set({ look });
          stage.setLook(look);
        },
        async runBenchmark() {
          store.set({ benchRunning: true, bench: null });
          const bench = await stage.benchmark(4);
          store.set({ benchRunning: false, bench });
        },
      }}
    />,
    document.getElementById('ui')!,
  );
}

/** Compressed bytes fetched for this page (0 when everything came from cache). */
function downloadedKB(): number {
  const entries = [
    ...performance.getEntriesByType('navigation'),
    ...performance.getEntriesByType('resource'),
  ] as PerformanceResourceTiming[];
  return entries.reduce((sum, e) => sum + (e.transferSize || 0), 0) / 1024;
}
