import type { Ray } from '../engine/pick';
import type { EditResult, ToolId } from '../engine/protocol';
import type { Stage } from '../render/stage';
import type { Engine } from './engine';

export type ToolChoice = ToolId | 'view';

export interface BrushSettings {
  tool: ToolChoice;
  /** Brush radius in metres. */
  radius: number;
  strength: number;
  mirror: boolean;
}

/** Cursor colour per tool. */
export const TOOL_COLORS: Record<ToolId, number> = {
  scissors: 0xff4d6d, comb: 0x7cc6ff, grow: 0x6be38a, extrude: 0xffc43d, gel: 0x6fe7ff, dryer: 0xffa36b,
};

/** Scissors use a thin blade, not the brush size. */
const SCISSORS_CURSOR = 0.006;

type State = 'idle' | 'pending' | 'stroking' | 'ending';

/**
 * Turns pointer input into strokes. A press on hair (or on the scalp, for tools
 * that can work there) starts the tool; a press on empty space rotates the view.
 * Scissors cut from anywhere, so you can swipe across a lock from outside it.
 * At most one stroke message is in flight; the latest pointer position wins.
 */
export class BrushController {
  private state: State = 'idle';
  private pointerId = -1;
  private pointerDown = false;
  private lastX = 0;
  private lastY = 0;
  private lastSent = 0;
  private inflight = false;
  private raf = 0;
  private hoverInflight = false;
  private hoverQueued = false;
  private readonly synthetic = new WeakSet<Event>();
  private settings: BrushSettings;
  private tool: ToolChoice = 'view';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stage: Stage,
    private readonly engine: Engine,
    private readonly getSettings: () => BrushSettings,
    private readonly onEdit: (r: EditResult) => void,
    private readonly canEdit: () => boolean,
  ) {
    this.settings = getSettings();
    // Capture phase on the parent runs before OrbitControls' own listener on the canvas.
    canvas.parentElement!.addEventListener('pointerdown', this.onDown, { capture: true });
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', () => this.stage.setCursor(null, 0, 0));
  }

  get busy(): boolean {
    return this.state !== 'idle';
  }

  /** Call when the tool changes so the cursor updates without waiting for a move. */
  refreshCursor(): void {
    if (this.getSettings().tool === 'view') this.stage.setCursor(null, 0, 0);
    else this.hover();
  }

  private onDown = (e: PointerEvent): void => {
    if (e.target !== this.canvas || this.synthetic.has(e)) return;
    this.settings = this.getSettings();
    if (this.state !== 'idle') {
      // A second finger during a stroke ends it rather than starting a gesture mid-edit.
      e.stopImmediatePropagation();
      if (this.state === 'stroking') this.finish();
      return;
    }
    if (this.settings.tool === 'view' || e.button !== 0 || !e.isPrimary || !this.canEdit()) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.tool = this.settings.tool;
    this.pointerId = e.pointerId;
    this.pointerDown = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.tool === 'scissors') {
      this.start();
      return;
    }
    this.state = 'pending';
    const down = e;
    this.engine.pick(this.ray()).then((res) => {
      if (this.state !== 'pending') return;
      const usable = res.hit && (res.hit.surface === 'hair' || this.tool === 'grow' || this.tool === 'extrude');
      if (usable) {
        this.start();
        if (!this.pointerDown) this.finish(); // a quick tap still makes one dab
      } else {
        this.state = 'idle';
        // Missed the hair: hand the press to the camera instead.
        if (this.pointerDown) this.forwardToOrbit(down);
      }
    });
  };

  private onMove = (e: PointerEvent): void => {
    if (this.pointerDown && e.pointerId === this.pointerId) {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    if (e.target !== this.canvas || e.pointerType !== 'mouse' || e.buttons !== 0) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.getSettings().tool !== 'view') this.hover();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointerDown || e.pointerId !== this.pointerId) return;
    this.pointerDown = false;
    if (this.state === 'stroking') this.finish();
  };

  private start(): void {
    this.state = 'stroking';
    this.lastSent = performance.now();
    this.send('begin');
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Once per frame while stroking: send the latest position if the worker is free. */
  private tick = (): void => {
    if (this.state !== 'stroking') return;
    if (!this.inflight) this.send('move');
    this.raf = requestAnimationFrame(this.tick);
  };

  private finish(): void {
    if (this.state !== 'stroking') return;
    cancelAnimationFrame(this.raf);
    this.state = 'ending';
    this.send('end');
  }

  private send(phase: 'begin' | 'move' | 'end'): void {
    const s = this.settings;
    const now = performance.now();
    const dt = (now - this.lastSent) / 1000;
    this.lastSent = now;
    this.inflight = true;
    this.engine
      .stroke({ phase, tool: this.tool as ToolId, ray: this.ray(), radius: s.radius, strength: s.strength, mirror: s.mirror, dt })
      .then((res) => {
        this.inflight = false;
        this.onEdit(res);
        this.showCursor(res.hit);
        if (phase === 'end') this.state = 'idle';
      })
      .catch(() => {
        this.inflight = false;
        this.state = 'idle';
      });
  }

  private hover(): void {
    if (this.hoverInflight) {
      this.hoverQueued = true;
      return;
    }
    this.hoverInflight = true;
    this.engine.pick(this.ray()).then((res) => {
      this.hoverInflight = false;
      if (this.state === 'idle') this.showCursor(res.hit);
      if (this.hoverQueued) {
        this.hoverQueued = false;
        this.hover();
      }
    });
  }

  private showCursor(hit: EditResult['hit']): void {
    const s = this.getSettings();
    if (s.tool === 'view' || !hit) return this.stage.setCursor(null, 0, 0);
    this.stage.setCursor(hit, s.tool === 'scissors' ? SCISSORS_CURSOR : s.radius, TOOL_COLORS[s.tool]);
  }

  private ray(): Ray {
    return this.stage.rayFrom(this.lastX, this.lastY);
  }

  /** Replays a press to OrbitControls (which we kept from seeing it) so the drag rotates the view. */
  private forwardToOrbit(e: PointerEvent): void {
    const copy = new PointerEvent('pointerdown', e);
    this.synthetic.add(copy);
    this.canvas.dispatchEvent(copy);
  }
}
