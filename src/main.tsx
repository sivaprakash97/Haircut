import { render } from 'preact';
import { BrushController, type BrushSettings, type ToolChoice } from './app/brush';
import { Engine } from './app/engine';
import { isPresetId } from './engine/presetIds';
import type { EditResult } from './engine/protocol';
import { QUALITY, TIERS, autoTier, type Tier } from './render/quality';
import { Stage } from './render/stage';
import { App, type AppState, TOOL_ORDER, effectiveTier } from './ui/App';
import { createStore } from './ui/store';

// Milliseconds since navigation start for each loading phase (shown in Details and copied with results).
const marks = { code: performance.now(), setup: 0, requested: 0, built: 0, ready: 0, hidden: document.visibilityState === 'hidden' };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !marks.ready) marks.hidden = true; // background tabs pause drawing
});

const engine = new Engine();

// URL parameters let a specific setup be shared or tested, e.g. ?preset=afro&quality=light&grain=1&tool=comb
const params = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean) => (params.has(name) ? params.get(name) !== '0' : fallback);
const qParam = params.get('quality');
const toolParam = params.get('tool') as ToolChoice | null;

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
  tool: toolParam && (TOOL_ORDER as string[]).includes(toolParam) ? toolParam : 'view',
  radiusCm: 2,
  strength: 0.6,
  mirror: flag('mirror', false),
  history: { undo: 0, redo: 0 },
  editMs: 0,
});

declare global {
  interface Window {
    __haircut?: {
      ready: boolean;
      state: () => AppState;
      draws: () => number;
      /** Checksum and material count of the hair volume (tests use it to prove an edit happened and was undone). */
      field: () => Promise<{ checksum: number; insideCells: number }>;
    };
  }
}
window.__haircut = {
  ready: false,
  state: store.get,
  draws: () => stage?.drawCount ?? 0,
  field: () => engine.debug().then((d) => ({ checksum: d.checksum, insideCells: d.insideCells })),
};

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
engine.onFailure = (m) => fail(`Something went wrong in the hair engine: ${m}`);

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

  let buildId = 0;
  const rebuild = async () => {
    const s = store.get();
    const id = ++buildId;
    const requestedAt = performance.now();
    if (!marks.requested) marks.requested = requestedAt;
    store.set({ building: true, bench: null });
    let res;
    try {
      res = await engine.build(s.preset, QUALITY[effectiveTier(s)].cell);
    } catch {
      return; // reported through engine.onFailure
    }
    if (id !== buildId) return; // superseded by a newer request
    stage.setHead(res.head);
    stage.setHair(res.hair);
    const build = { ...res.stats, totalMs: performance.now() - requestedAt, cellMm: res.cell * 1000 };
    if (store.get().phase !== 'loading') {
      store.set({ building: false, build, history: res.history });
      return;
    }
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
      store.set({ phase: 'ready', building: false, build, history: res.history, loadMs: marks.ready, timing, downloadKB: downloadedKB() });
      loader?.classList.add('done');
      window.__haircut!.ready = true;
    });
  };

  const applyEdit = (r: EditResult) => {
    if (r.hair) stage.updateHair(r.hair, r.replaceAll);
    for (const d of r.debris) stage.addDebris(d);
    store.set({ history: r.history, editMs: r.ms });
  };

  const settings = (): BrushSettings => {
    const s = store.get();
    return { tool: s.tool, radius: s.radiusCm / 100, strength: s.strength, mirror: s.mirror };
  };
  const brush = new BrushController(canvas, stage, engine, settings, applyEdit, () => store.get().phase === 'ready' && !store.get().building);

  const history = async (action: 'undo' | 'redo' | 'reset') => {
    if (brush.busy || store.get().building) return;
    applyEdit(await engine.history(action));
  };

  // Request the hair before drawing the UI so the build starts as early as possible.
  rebuild();

  const actions = {
    setPreset(id: AppState['preset']) {
      if (id === store.get().preset) return;
      store.set({ preset: id });
      rebuild();
    },
    setTier(t: Tier | 'auto') {
      const before = effectiveTier(store.get());
      store.set({ tierChoice: t });
      const tier = effectiveTier(store.get());
      stage.setMaxDpr(QUALITY[tier].maxDpr);
      if (tier !== before) rebuild();
    },
    setLook(look: AppState['look']) {
      store.set({ look });
      stage.setLook(look);
    },
    async runBenchmark() {
      store.set({ benchRunning: true, bench: null });
      const bench = await stage.benchmark(4);
      store.set({ benchRunning: false, bench });
    },
    setTool(tool: ToolChoice) {
      store.set({ tool });
      brush.refreshCursor();
    },
    setBrush(patch: Partial<Pick<AppState, 'radiusCm' | 'strength' | 'mirror'>>) {
      store.set(patch);
      brush.refreshCursor();
    },
    undo: () => history('undo'),
    redo: () => history('redo'),
    reset: () => history('reset'),
  };

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) actions.redo();
      else actions.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      actions.redo();
    } else if (!mod && !e.altKey) {
      const n = Number(e.key);
      if (n >= 1 && n <= TOOL_ORDER.length) actions.setTool(TOOL_ORDER[n - 1]);
      else if (e.key === '[') actions.setBrush({ radiusCm: Math.max(0.8, store.get().radiusCm - 0.4) });
      else if (e.key === ']') actions.setBrush({ radiusCm: Math.min(5, store.get().radiusCm + 0.4) });
      else if (e.key.toLowerCase() === 'm') actions.setBrush({ mirror: !store.get().mirror });
    }
  });

  render(<App store={store} actions={actions} />, document.getElementById('ui')!);
}

/** Compressed bytes fetched for this page (0 when everything came from cache). */
function downloadedKB(): number {
  const entries = [
    ...performance.getEntriesByType('navigation'),
    ...performance.getEntriesByType('resource'),
  ] as PerformanceResourceTiming[];
  return entries.reduce((sum, e) => sum + (e.transferSize || 0), 0) / 1024;
}
