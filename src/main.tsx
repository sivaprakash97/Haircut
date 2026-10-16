import { render } from 'preact';
import { Engine } from './app/engine';
import { type BrushSettings, Input, type ToolChoice } from './app/input';
import { Body } from './hair/body';
import { NODES } from './hair/locks';
import { HairSession } from './hair/session';
import { STEP } from './hair/sim';
import { QUALITY, TIERS, autoTier, type Tier } from './render/quality';
import { Stage } from './render/stage';
import { App, type AppState, TOOL_ORDER, effectiveTier } from './ui/App';
import { createStore } from './ui/store';

// Milliseconds since navigation start for each loading phase (shown in Details and copied with results).
const marks = { code: performance.now(), setup: 0, requested: 0, built: 0, ready: 0, hidden: document.visibilityState === 'hidden' };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !marks.ready) marks.hidden = true; // background tabs pause drawing
});

// The worker starts on the starting hair straight away; it's the slowest part of loading.
const engine = new Engine();
marks.requested = performance.now();
const hairRequest = engine.hair();

// URL parameters let a specific setup be shared or tested, e.g. ?quality=light&tool=comb&mirror=1
const params = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean) => (params.has(name) ? params.get(name) !== '0' : fallback);
const qParam = params.get('quality');
const toolParam = params.get('tool') as ToolChoice | null;
const yawParam = params.has('yaw') ? Number(params.get('yaw')) : NaN;

const store = createStore<AppState>({
  phase: 'loading',
  error: '',
  tierChoice: TIERS.includes(qParam as Tier) ? (qParam as Tier) : 'auto',
  autoTier: 'standard',
  look: { outline: flag('outline', true), ao: flag('ao', true) },
  gpu: '',
  building: false,
  build: null,
  locks: 0,
  simMs: 0,
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
  guardCm: 0.6,
  history: { undo: 0, redo: 0 },
  editMs: 0,
});

let session: HairSession | null = null;

declare global {
  interface Window {
    __haircut?: {
      ready: boolean;
      state: () => AppState;
      draws: () => number;
      /** The hair's style checksum and a few totals (tests use them to prove an edit happened and was undone). */
      hair: () => { checksum: number; length: number; falling: number; asleep: boolean; locks: number };
      /** Head-space point (metres) -> client pixels, for aiming in tests. */
      screen: (x: number, y: number, z: number) => [number, number];
      /** Head-space position of node `j` of lock `i`, and its visible length (segments). */
      lock: (i: number) => { root: number[]; tip: number[]; len: number };
    };
  }
}

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
engine.onFailure = (m) => fail(`Something went wrong while building the hair: ${m}`);

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
  if (Number.isFinite(yawParam)) stage.yaw = yawParam;
  stage.setLook(store.get().look);
  const applyTier = () => {
    const q = QUALITY[effectiveTier(store.get())];
    stage.setMaxDpr(q.maxDpr);
    stage.setHairDetail({ sub: q.sub, sides: q.sides });
  };
  applyTier();
  let simMs = 0;
  stage.onStats = (frame) => store.set({ frame, simMs });
  marks.setup = performance.now();

  window.__haircut = {
    ready: false,
    state: store.get,
    draws: () => stage.drawCount,
    hair: () => ({
      checksum: session?.checksum() ?? 0,
      length: session?.totalLength() ?? 0,
      falling: session?.debris.active ?? 0,
      asleep: session?.sim.asleep ?? false,
      locks: session?.L.count ?? 0,
    }),
    screen: (x, y, z) => {
      const c = Math.cos(stage.yaw), s = Math.sin(stage.yaw);
      return stage.toScreen([c * x + s * z, y, -s * x + c * z]);
    },
    lock: (i) => {
      const L = session!.L;
      const b = i * NODES * 3, t = (i * NODES + Math.ceil(L.len[i])) * 3;
      return { root: Array.from(L.rest.subarray(b, b + 3)), tip: Array.from(L.rest.subarray(t, t + 3)), len: L.len[i] };
    },
  };

  let headId = 0;
  const buildHead = async () => {
    const id = ++headId;
    store.set({ building: true, bench: null });
    const t = performance.now();
    try {
      const res = await engine.head(QUALITY[effectiveTier(store.get())].cell);
      if (id !== headId) return null;
      stage.setHead(res.head);
      return { ms: res.ms, wall: performance.now() - t };
    } catch {
      return null; // reported through engine.onFailure
    } finally {
      if (id === headId) store.set({ building: false });
    }
  };

  // Physics runs at a fixed 60 steps a second, inside the stage's frame loop.
  let acc = 0;
  let wasMoving = true;
  stage.animate = (dt) => {
    const s = session;
    if (!s) return false;
    const stroking = input.update(dt);
    s.sim.setYaw(stage.yaw);
    acc = Math.min(acc + dt, STEP * 3);
    let steps = 0, moving = !s.sim.asleep || s.debris.active > 0;
    while (acc >= STEP * 0.999 && steps < 2) {
      const t = performance.now();
      moving = s.step();
      if (moving) simMs = simMs * 0.9 + (performance.now() - t) * 0.1;
      acc -= STEP;
      steps++;
    }
    // Upload while moving, plus once more as it stops (so the final pose, without the last falling piece, is drawn).
    if (steps && (moving || wasMoving)) stage.hairMoved();
    if (steps) wasMoving = moving;
    // Keep the frame loop going only while something moves.
    return stroking || moving;
  };

  const settings = (): BrushSettings => {
    const s = store.get();
    return { tool: s.tool, radius: s.radiusCm / 100, strength: s.strength, mirror: s.mirror, guard: s.guardCm / 100 };
  };
  const syncHistory = () => {
    if (!session) return;
    store.set({ history: { undo: session.history.undoCount, redo: session.history.redoCount }, editMs: input.lastStrokeMs, simMs });
  };
  const input = new Input(canvas, stage, () => (store.get().phase === 'ready' ? session : null), settings, syncHistory);

  const history = (action: 'undo' | 'redo' | 'reset') => {
    if (!session || input.busy) return;
    session[action]();
    stage.hairChanged();
    syncHistory();
  };

  // Both builds run in workers, side by side, while the page sets up.
  const headRequest = buildHead();
  Promise.all([hairRequest, headRequest]).then(([hair, head]) => {
    if (!hair || !head) return;
    session = new HairSession(hair.locks, new Body(hair.body), stage.yaw);
    const sim = session.sim, debris = session.debris, L = session.L;
    stage.setHair({ L, pos: sim.pos, debris, get cos() { return sim.cos; }, get sin() { return sim.sin; } }, L.count);
    marks.built = performance.now();
    const build = { bodyMs: hair.bodyMs, locksMs: hair.locksMs, headMs: head.ms, totalMs: marks.built - marks.requested };
    // Measure once the first frame with hair has been drawn.
    requestAnimationFrame(() => {
      marks.ready = performance.now();
      const html = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.responseEnd ?? 0;
      const timing = {
        pageMs: html,
        codeMs: marks.code - html,
        setupMs: marks.setup - marks.code,
        hairMs: marks.built - marks.setup,
        frameMs: marks.ready - marks.built,
        backgrounded: marks.hidden,
      };
      store.set({ phase: 'ready', build, locks: L.count, loadMs: marks.ready, timing, downloadKB: downloadedKB() });
      loader?.classList.add('done');
      window.__haircut!.ready = true;
    });
  }).catch(() => { /* reported through engine.onFailure */ });

  const actions = {
    setTier(t: Tier | 'auto') {
      const before = effectiveTier(store.get());
      store.set({ tierChoice: t });
      applyTier();
      if (effectiveTier(store.get()) !== before) buildHead();
    },
    setLook(look: AppState['look']) {
      store.set({ look });
      stage.setLook(look);
    },
    async runBenchmark() {
      store.set({ benchRunning: true, bench: null });
      const bench = await stage.benchmark(4);
      store.set({ benchRunning: false, bench, simMs });
    },
    setTool(tool: ToolChoice) {
      store.set({ tool });
      if (tool === 'view') stage.setCursor(null, 0, 0);
    },
    setBrush(patch: Partial<Pick<AppState, 'radiusCm' | 'strength' | 'mirror' | 'guardCm'>>) {
      store.set(patch);
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
