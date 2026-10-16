import { useState } from 'preact/hooks';
import { PRESET_LIST, type PresetId } from '../engine/presetIds';
import type { BuildStats } from '../engine/protocol';
import { QUALITY, TIERS, type Tier } from '../render/quality';
import type { BenchResult, FrameStats, Look } from '../render/stage';
import { type Store, useStore } from './store';

export interface AppState {
  phase: 'loading' | 'ready' | 'error';
  error: string;
  preset: PresetId;
  tierChoice: Tier | 'auto';
  autoTier: Tier;
  look: Look;
  gpu: string;
  building: boolean;
  build: (BuildStats & { totalMs: number; cellMm: number }) | null;
  frame: FrameStats | null;
  loadMs: number;
  timing: LoadTiming | null;
  downloadKB: number;
  benchRunning: boolean;
  bench: BenchResult | null;
}

/** How the time to first usable frame splits up (ms). */
export interface LoadTiming {
  /** Navigation start until the HTML arrived (DNS, TLS, server). */
  pageMs: number;
  /** HTML arrived until the app code was running (download + parse). */
  codeMs: number;
  /** WebGL and scene setup. */
  setupMs: number;
  /** Hair request sent until the meshes came back from the worker. */
  hairMs: number;
  /** Uploading the meshes and drawing the first frame. */
  frameMs: number;
  /** The tab was in the background at some point (browsers pause drawing there). */
  backgrounded: boolean;
}

export function timingText(t: LoadTiming): string {
  const f = (ms: number) => (ms / 1000).toFixed(2);
  return `page ${f(t.pageMs)} · code ${f(t.codeMs)} · 3D setup ${f(t.setupMs)} · hair ${f(t.hairMs)} · first frame ${f(t.frameMs)}${
    t.backgrounded ? ' (tab was in the background while loading)' : ''
  }`;
}

export interface Actions {
  setPreset(id: PresetId): void;
  setTier(t: Tier | 'auto'): void;
  setLook(look: Look): void;
  runBenchmark(): void;
}

export const effectiveTier = (s: AppState): Tier => (s.tierChoice === 'auto' ? s.autoTier : s.tierChoice);

export function App({ store, actions }: { store: Store<AppState>; actions: Actions }) {
  const s = useStore(store);
  const [open, setOpen] = useState(() => window.innerWidth > 700);
  const tier = effectiveTier(s);

  return (
    <>
      <button class="panel-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide controls' : 'Controls'}
      </button>
      {open && (
        <aside class="panel" aria-label="Controls">
          <header>
            <h1>Haircut Playground</h1>
            <p class="tag">Milestone 1 · hair clay preview</p>
          </header>

          <Group label="Hairstyle">
            {PRESET_LIST.map((p) => (
              <Choice key={p.id} on={s.preset === p.id} disabled={s.building} onClick={() => actions.setPreset(p.id)}>
                {p.label}
              </Choice>
            ))}
          </Group>

          <Group label="Quality">
            <Choice on={s.tierChoice === 'auto'} disabled={s.building} onClick={() => actions.setTier('auto')}>
              Auto ({QUALITY[s.autoTier].label})
            </Choice>
            {TIERS.map((t) => (
              <Choice key={t} on={s.tierChoice === t} disabled={s.building} onClick={() => actions.setTier(t)}>
                {QUALITY[t].label}
              </Choice>
            ))}
          </Group>

          <Group label="Look">
            <Toggle on={s.look.outline} onClick={() => actions.setLook({ ...s.look, outline: !s.look.outline })}>Outline</Toggle>
            <Toggle on={s.look.ao} onClick={() => actions.setLook({ ...s.look, ao: !s.look.ao })}>Depth shading</Toggle>
            <Toggle on={s.look.grain} onClick={() => actions.setLook({ ...s.look, grain: !s.look.grain })}>Sand grain</Toggle>
          </Group>

          <section class="bench">
            <button class="primary" disabled={s.benchRunning || s.phase !== 'ready' || s.building} onClick={actions.runBenchmark}>
              {s.benchRunning ? 'Measuring…' : 'Run speed test'}
            </button>
            {s.bench && <BenchSummary s={s} tier={tier} />}
          </section>

          <details class="stats">
            <summary>Details</summary>
            <dl>
              <Row k="Graphics" v={s.gpu || '—'} />
              <Row k="Quality" v={`${QUALITY[tier].label} · ${(QUALITY[tier].cell * 1000).toFixed(1)} mm cells`} />
              <Row k="Hair cells" v={s.build ? `${(s.build.cells / 1e6).toFixed(2)} M` : '—'} />
              <Row k="Triangles" v={s.frame ? `${fmtK(s.frame.hairTriangles)} hair · ${fmtK(s.frame.triangles)} drawn` : '—'} />
              <Row k="Draw calls" v={s.frame ? String(s.frame.drawCalls) : '—'} />
              <Row k="Resolution" v={s.frame ? `${s.frame.width}×${s.frame.height} @${s.frame.dpr.toFixed(2)}x` : '—'} />
              <Row k="Frame time" v={s.frame && s.frame.frameMs ? `${s.frame.frameMs.toFixed(1)} ms` : 'idle (not drawing)'} />
              <Row k="Hair build" v={s.build ? `${s.build.totalMs.toFixed(0)} ms (shape ${s.build.fieldMs.toFixed(0)}, mesh ${s.build.meshMs.toFixed(0)}, head ${s.build.headMs.toFixed(0)})` : '—'} />
              <Row k="Ready after" v={s.loadMs ? `${(s.loadMs / 1000).toFixed(2)} s` : '—'} />
              {s.timing && <Row k="Split (s)" v={timingText(s.timing)} />}
              <Row k="Downloaded" v={s.downloadKB ? `${s.downloadKB.toFixed(0)} KB` : 'cached'} />
            </dl>
          </details>
        </aside>
      )}
      {s.building && s.phase === 'ready' && <div class="toast">Rebuilding hair…</div>}
      {s.phase === 'error' && <div class="toast error">{s.error}</div>}
      <p class="hint">Drag to rotate · scroll or pinch to zoom</p>
    </>
  );
}

export function benchText(s: AppState): string {
  const b = s.bench;
  if (!b) return '';
  const t = QUALITY[effectiveTier(s)];
  return [
    `Haircut M1 speed test`,
    `GPU: ${s.gpu}`,
    `Hairstyle: ${s.preset} · Quality: ${t.label} (${(t.cell * 1000).toFixed(1)} mm)`,
    `Canvas: ${b.width}×${b.height} @${b.dpr.toFixed(2)}x`,
    `Result: ${b.avgFps.toFixed(0)} fps average, slowest 5% of frames ${b.p95Ms.toFixed(1)} ms`,
    `Triangles drawn: ${fmtK(b.triangles)}`,
    `Ready after ${(s.loadMs / 1000).toFixed(2)} s (${s.timing ? timingText(s.timing) : 'no split'}) · downloaded ${s.downloadKB.toFixed(0)} KB`,
    `Browser: ${navigator.userAgent}`,
  ].join('\n');
}

function BenchSummary({ s, tier }: { s: AppState; tier: Tier }) {
  const b = s.bench!;
  const [copied, setCopied] = useState(false);
  const smooth = b.avgFps >= 55 && b.p95Ms <= 20;
  return (
    <div class="bench-result">
      <p>
        <strong>{b.avgFps.toFixed(0)} fps</strong> average · slowest frames {b.p95Ms.toFixed(1)} ms
        <br />
        {QUALITY[tier].label} at {b.width}×{b.height}. {smooth ? 'Smooth.' : 'Below target; try a lower quality.'}
      </p>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(benchText(s));
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy results'}
      </button>
    </div>
  );
}

function Group({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <section>
      <h2>{label}</h2>
      <div class="seg" role="group" aria-label={label}>{children}</div>
    </section>
  );
}

function Choice(props: { on: boolean; disabled?: boolean; onClick: () => void; children: preact.ComponentChildren }) {
  return (
    <button class={props.on ? 'on' : ''} aria-pressed={props.on} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

const Toggle = Choice;

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}
