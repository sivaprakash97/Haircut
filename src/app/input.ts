import type { HairSession, Hit, StrokeInput, ToolId } from '../hair/session';
import type { Stage } from '../render/stage';

export type ToolChoice = ToolId | 'view';

export interface BrushSettings {
  tool: ToolChoice;
  /** Brush radius in metres. */
  radius: number;
  strength: number;
  mirror: boolean;
  /** Clipper guard length in metres. */
  guard: number;
}

/** Cursor colour per tool. */
export const TOOL_COLORS: Record<ToolId, number> = {
  scissors: 0xff4d6d, clippers: 0xb98cff, comb: 0x7cc6ff, grow: 0x6be38a, extrude: 0xffc43d,
};

/** Scissors use a thin blade, not the brush size. */
const SCISSORS_CURSOR = 0.005;
const TURN_SPEED = 0.0105;
const TILT_SPEED = 0.006;

type Mode = 'idle' | 'stroke' | 'turn' | 'pinch';

interface Pointer {
  x: number;
  y: number;
}

/**
 * Pointer input. A press on hair (or skin, for tools that work there) uses the
 * tool; scissors cut from anywhere, so you can swipe across a lock from
 * outside it. Any other press, a right-drag, or the Rotate tool turns the
 * character (the salon chair spins, and the hair swings with it). Scroll or
 * pinch zooms. Strokes are applied once per frame with the latest position.
 */
export class Input {
  private mode: Mode = 'idle';
  private readonly pointers = new Map<number, Pointer>();
  private strokePointer = -1;
  private lastMoveAt = 0;
  private pinchDist = 0;
  private settings: BrushSettings;
  private tool: ToolId = 'comb';
  /** Milliseconds the last stroke update took (tool work only). */
  lastStrokeMs = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stage: Stage,
    private readonly hair: () => HairSession | null,
    private readonly getSettings: () => BrushSettings,
    private readonly onEdited: () => void,
  ) {
    this.settings = getSettings();
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', () => {
      if (this.mode === 'idle') this.stage.setCursor(null, 0, 0);
    });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get busy(): boolean {
    return this.mode === 'stroke';
  }

  /** Call when the tool or brush changes so the cursor updates without waiting for a move. */
  refreshCursor(x?: number, y?: number): void {
    const s = this.getSettings();
    const hair = this.hair();
    if (s.tool === 'view' || !hair || x === undefined || y === undefined) {
      if (s.tool === 'view') this.stage.setCursor(null, 0, 0);
      return;
    }
    this.showCursor(hair.pick(this.stage.rayFrom(x, y)));
  }

  /** Once per frame (from the stage's animation): applies the stroke at the latest pointer position. */
  update(dt: number): boolean {
    if (this.mode !== 'stroke') return false;
    const p = this.pointers.get(this.strokePointer);
    if (p) this.apply('move', p, dt);
    return true;
  }

  private onDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.settings = this.getSettings();
    if (this.pointers.size === 2) {
      // Second finger: end any stroke and pinch to zoom (and turn) instead.
      if (this.mode === 'stroke') this.finish();
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.mode = 'pinch';
      return;
    }
    if (this.pointers.size > 2 || this.mode !== 'idle') return;
    e.preventDefault();
    this.lastMoveAt = performance.now();
    const hair = this.hair();
    const tool = this.settings.tool;
    if (tool !== 'view' && e.button === 0 && hair) {
      const p = { x: e.clientX, y: e.clientY };
      const hit = hair.pick(this.stage.rayFrom(p.x, p.y));
      if (tool === 'scissors' || hit) {
        this.tool = tool;
        this.mode = 'stroke';
        this.strokePointer = e.pointerId;
        this.apply('begin', p, 0);
        this.stage.requestRender();
        return;
      }
    }
    this.mode = 'turn';
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      // Hovering with a mouse: show where the tool would act.
      if (e.target === this.canvas && e.pointerType === 'mouse' && e.buttons === 0) this.refreshCursor(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    const now = performance.now(), dtMs = now - this.lastMoveAt;
    if (this.mode === 'turn') {
      this.stage.turn(dx * TURN_SPEED, dy * TILT_SPEED, dtMs);
      this.lastMoveAt = now;
    } else if (this.mode === 'pinch' && this.pointers.size === 2) {
      const before = [...this.pointers.values()].map((q) => ({ ...q }));
      p.x = e.clientX;
      p.y = e.clientY;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && dist > 0) this.stage.zoom(this.pinchDist / dist);
      this.pinchDist = dist;
      const mx = (a.x + b.x - before[0].x - before[1].x) / 2, my = (a.y + b.y - before[0].y - before[1].y) / 2;
      this.stage.turn(mx * TURN_SPEED, my * TILT_SPEED, dtMs);
      this.lastMoveAt = now;
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    if (this.mode === 'stroke' && e.pointerId === this.strokePointer) this.finish();
    this.pointers.delete(e.pointerId);
    if (this.mode === 'turn' || this.mode === 'pinch') {
      if (this.pointers.size === 0) {
        this.stage.release(performance.now() - this.lastMoveAt);
        this.mode = 'idle';
      } else if (this.mode === 'pinch') {
        this.mode = 'turn'; // one finger left: keep turning with it
      }
    } else if (this.pointers.size === 0) {
      this.mode = 'idle';
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.stage.zoom(Math.exp(e.deltaY * 0.0012));
  };

  private finish(): void {
    const p = this.pointers.get(this.strokePointer);
    if (p) this.apply('end', p, 0);
    this.mode = 'idle';
    this.strokePointer = -1;
    this.onEdited();
  }

  private apply(phase: StrokeInput['phase'], p: Pointer, dt: number): void {
    const hair = this.hair();
    if (!hair) return;
    const s = this.settings;
    const t0 = performance.now();
    const hit = hair.strokeStep({
      phase, tool: this.tool, ray: this.stage.rayFrom(p.x, p.y), radius: s.radius, strength: s.strength, mirror: s.mirror, dt, guard: s.guard,
    });
    this.lastStrokeMs = performance.now() - t0;
    this.stage.hairChanged();
    this.showCursor(phase === 'end' ? hair.pick(this.stage.rayFrom(p.x, p.y)) : hit);
  }

  private showCursor(hit: Hit | null): void {
    const s = this.getSettings();
    if (s.tool === 'view' || !hit) return this.stage.setCursor(null, 0, 0);
    this.stage.setCursor(hit, s.tool === 'scissors' ? SCISSORS_CURSOR : s.radius, TOOL_COLORS[s.tool]);
  }
}
