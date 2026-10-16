import { useState } from 'preact/hooks';
import type { ToolChoice } from '../app/brush';
import { PRESET_LIST, type PresetId } from '../engine/presetIds';
import type { BuildStats, HistoryState } from '../engine/protocol';
import { QUALITY, TIERS, type Tier } from '../render/quality';
import type { BenchResult, FrameStats, Look } from '../render/stage';
import { type ToolInfo, TOOLS } from './tools';
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
  tool: ToolChoice;
  radiusCm: number;
  strength: number;
  mirror: boolean;
  history: HistoryState;
  /** Worker time for the most recent edit message (ms). */
  editMs: number;
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
  setTool(t: ToolChoice): void;
  setBrush(patch: Partial<Pick<AppState, 'radiusCm' | 'strength' | 'mirror'>>): void;
  undo(): void;
  redo(): void;
  reset(): void;
}

/** Order of the tool bar; keys 1–7 select them. */
export const TOOL_ORDER: ToolChoice[] = TOOLS.map((t) => t.id);

export const effectiveTier = (s: AppState): Tier => (s.tierChoice === 'auto' ? s.autoTier : s.tierChoice);

export function App({ store, actions }: { store: Store<AppState>; actions: Actions }) {
  const s = useStore(store);
  const [open, setOpen] = useState(() => window.innerWidth > 700);
  const tier = effectiveTier(s);
  const tool = TOOLS.find((t) => t.id === s.tool)!;
  const ready = s.phase === 'ready' && !s.building;

  return (
    <>
      <div class="topbar">
        <div class="history" role="group" aria-label="History">
          <IconButton label="Undo (Ctrl/⌘ Z)" disabled={!ready || s.history.undo === 0} onClick={actions.undo} icon={ICON_UNDO} />
          <IconButton label="Redo (Shift Ctrl/⌘ Z)" disabled={!ready || s.history.redo === 0} onClick={actions.redo} icon={ICON_REDO} />
          <IconButton label="Reset to the starting hairstyle" disabled={!ready} onClick={actions.reset} icon={ICON_RESET} />
        </div>
        <button class="panel-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide controls' : 'Controls'}
        </button>
      </div>

      {open && (
        <aside class="panel" aria-label="Controls">
          <header>
            <h1>Haircut Playground</h1>
            <p class="tag">Milestone 2 · sculpting tools</p>
          </header>

          <Group label="Starting hairstyle">
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
          {s.history.undo > 0 && <p class="note">Changing the hairstyle or quality starts over (your edits are cleared).</p>}

          <Group label="Look">
            <Choice on={s.look.outline} onClick={() => actions.setLook({ ...s.look, outline: !s.look.outline })}>Outline</Choice>
            <Choice on={s.look.ao} onClick={() => actions.setLook({ ...s.look, ao: !s.look.ao })}>Depth shading</Choice>
            <Choice on={s.look.grain} onClick={() => actions.setLook({ ...s.look, grain: !s.look.grain })}>Sand grain</Choice>
          </Group>

          <section class="bench">
            <button class="primary" disabled={s.benchRunning || !ready} onClick={actions.runBenchmark}>
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
              <Row k="Last edit" v={s.editMs ? `${s.editMs.toFixed(1)} ms in the background` : '—'} />
              <Row k="Hair build" v={s.build ? `${s.build.totalMs.toFixed(0)} ms (shape ${s.build.fieldMs.toFixed(0)}, mesh ${s.build.meshMs.toFixed(0)}, head ${s.build.headMs.toFixed(0)})` : '—'} />
              <Row k="Ready after" v={s.loadMs ? `${(s.loadMs / 1000).toFixed(2)} s` : '—'} />
              {s.timing && <Row k="Split (s)" v={timingText(s.timing)} />}
              <Row k="Downloaded" v={s.downloadKB ? `${s.downloadKB.toFixed(0)} KB` : 'cached'} />
            </dl>
          </details>
        </aside>
      )}

      <div class="dock">
        {tool.id !== 'view' && <BrushBar s={s} tool={tool} actions={actions} />}
        <nav class="toolbar" aria-label="Tools">
          {TOOLS.map((t, i) => (
            <button
              key={t.id}
              class={`tool${s.tool === t.id ? ' on' : ''}`}
              aria-pressed={s.tool === t.id}
              title={`${t.label} (${i + 1}): ${t.help}`}
              onClick={() => actions.setTool(t.id)}
              style={{ '--tool': t.color }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{t.icon}</svg>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <p class="hint">
          {tool.id === 'view'
            ? 'Drag to turn the head · scroll or pinch to zoom · pick a tool to start styling'
            : `${tool.help} · right-drag or drag empty space to rotate`}
        </p>
      </div>

      {s.building && s.phase === 'ready' && <div class="toast">Rebuilding hair…</div>}
      {s.phase === 'error' && <div class="toast error">{s.error}</div>}
    </>
  );
}

function BrushBar({ s, tool, actions }: { s: AppState; tool: ToolInfo; actions: Actions }) {
  return (
    <div class="brushbar" role="group" aria-label="Brush">
      {tool.size && (
        <label>
          <span>Size</span>
          <input
            type="range" min={0.8} max={5} step={0.1} value={s.radiusCm}
            onInput={(e) => actions.setBrush({ radiusCm: Number((e.target as HTMLInputElement).value) })}
          />
          <output>{s.radiusCm.toFixed(1)} cm</output>
        </label>
      )}
      {tool.strength && (
        <label>
          <span>Strength</span>
          <input
            type="range" min={0.1} max={1} step={0.05} value={s.strength}
            onInput={(e) => actions.setBrush({ strength: Number((e.target as HTMLInputElement).value) })}
          />
          <output>{Math.round(s.strength * 100)}%</output>
        </label>
      )}
      <button class={s.mirror ? 'on' : ''} aria-pressed={s.mirror} title="Mirror left and right (M)" onClick={() => actions.setBrush({ mirror: !s.mirror })}>
        Mirror
      </button>
    </div>
  );
}

function IconButton(props: { label: string; disabled: boolean; onClick: () => void; icon: preact.JSX.Element }) {
  return (
    <button class="icon" aria-label={props.label} title={props.label} disabled={props.disabled} onClick={props.onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{props.icon}</svg>
    </button>
  );
}

const ICON_UNDO = <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4" />;
const ICON_REDO = <path d="m15 14 5-5-5-5m5 5H9a5 5 0 0 0 0 10h4" />;
const ICON_RESET = (
  <>
    <path d="M4 12a8 8 0 1 0 2.3-5.6" />
    <path d="M4 4v4h4" />
  </>
);

export function benchText(s: AppState): string {
  const b = s.bench;
  if (!b) return '';
  const t = QUALITY[effectiveTier(s)];
  return [
    `Haircut speed test`,
    `GPU: ${s.gpu}`,
    `Hairstyle: ${s.preset} · Quality: ${t.label} (${(t.cell * 1000).toFixed(1)} mm)`,
    `Canvas: ${b.width}×${b.height} @${b.dpr.toFixed(2)}x`,
    `Result: ${b.avgFps.toFixed(0)} fps average, slowest 5% of frames ${b.p95Ms.toFixed(1)} ms`,
    `Triangles drawn: ${fmtK(b.triangles)}`,
    `Last edit: ${s.editMs ? `${s.editMs.toFixed(1)} ms` : 'none yet'}`,
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
