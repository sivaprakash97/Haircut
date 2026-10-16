import {
  BufferAttribute, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, RingGeometry, Scene, SphereGeometry,
  TorusGeometry, Vector2, Vector3, WebGLRenderer, type BufferGeometry, type ShaderMaterial,
} from 'three';
import { EYES, MOUTH } from '../engine/headLayout';
import type { MeshPayload } from '../engine/protocol';
import type { Hit, Ray } from '../hair/session';
import { singleGeometry } from './chunks';
import { type LockDetail, LockMesh, type LockSource } from './lockMesh';
import {
  createBackground, createLookUniforms, createOutlineMaterial, createOutlineUniforms, createToonMaterial,
  type LookUniforms, type OutlineUniforms,
} from './materials';

export interface Look {
  outline: boolean;
  ao: boolean;
}

export interface FrameStats {
  dpr: number;
  /** Median interval between consecutive animated frames (ms), or 0 when idle. */
  frameMs: number;
  triangles: number;
  drawCalls: number;
  hairTriangles: number;
  width: number;
  height: number;
}

export interface BenchResult {
  frames: number;
  avgFps: number;
  p95Ms: number;
  dpr: number;
  width: number;
  height: number;
  triangles: number;
}

/** Point the camera looks at: the face, with room for long hair below. */
const TARGET = new Vector3(0, -0.035, 0);
const MIN_DPR = 0.75;
const PITCH_MIN = -0.3;
const PITCH_MAX = 1.25;
const DIST_MIN = 0.36;
const DIST_MAX = 1.5;

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly gpu: string;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.05, 10);
  private readonly look: LookUniforms = createLookUniforms();
  private readonly outlineU: OutlineUniforms = createOutlineUniforms();
  private readonly toon: ShaderMaterial;
  private readonly outline: ShaderMaterial;
  /** The character turns (the salon chair spins); the camera only tilts and zooms. */
  private readonly character = new Group();
  private readonly headGroup = new Group();
  /** Every outline mesh, so one switch shows or hides them all. */
  private readonly outlines: Mesh[] = [];
  private outlinesOn = true;
  private hair: LockMesh | null = null;
  private hairSource: LockSource | null = null;
  private hairDirty = false;
  private detail: LockDetail = { sub: 2, sides: 6 };
  private readonly cursor: Mesh;

  /** Turn of the character about the vertical axis (radians). */
  yaw = 0.42;
  private yawVel = 0;
  private dragging = false;
  private pitch = 0.1;
  private pitchGoal = 0.1;
  private dist = 0.9;
  private distGoal = 0.9;

  private maxDpr = 1.5;
  private dpr = 1;
  private raf = 0;
  private lastFrame = 0;
  private intervals: number[] = [];
  private slowFrames = 0;
  private benchmarking = false;
  /** Called every frame before drawing (physics, strokes); return true to keep animating. */
  animate: ((dt: number) => boolean) | null = null;
  onStats: ((s: FrameStats) => void) | null = null;
  private lastStatsAt = 0;
  /** Number of frames drawn so far (used by tests to catch duplicate render loops). */
  drawCount = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.gpu = gpuName(this.renderer);
    this.toon = createToonMaterial(this.look);
    this.outline = createOutlineMaterial(this.outlineU);

    this.cursor = new Mesh(
      new RingGeometry(0.84, 1, 48),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;

    this.character.add(this.headGroup);
    this.scene.add(createBackground(this.outlineU.uResolution), this.character, this.cursor);
    this.addEyes();
    this.addMouth();
    this.character.rotation.y = this.yaw;
    this.placeCamera();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setMaxDpr(maxDpr: number): void {
    this.maxDpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    this.applyDpr(this.maxDpr);
    this.requestRender();
  }

  setLook(look: Look): void {
    this.outlinesOn = look.outline;
    for (const m of this.outlines) m.visible = look.outline;
    this.look.uAO.value = look.ao ? 1 : 0;
    this.requestRender();
  }

  /** The hair to draw: `src` is read every frame the hair moves. */
  setHair(src: LockSource, count: number): void {
    const mesh = new LockMesh(count, this.look, this.outlineU);
    mesh.setDetail(this.detail);
    this.hair = mesh;
    this.hairSource = src;
    this.scene.add(mesh.fill, mesh.outline);
    this.outlines.push(mesh.outline);
    mesh.outline.visible = this.outlinesOn;
    this.hairChanged();
  }

  setHairDetail(d: LockDetail): void {
    this.detail = d;
    this.hair?.setDetail(d);
    this.requestRender();
  }

  /** The hair moved or was edited: upload it and draw a frame. */
  hairChanged(): void {
    this.hairDirty = true;
    this.requestRender();
  }

  /** Inside the frame loop: upload the hair before this frame is drawn (the loop decides whether to continue). */
  hairMoved(): void {
    this.hairDirty = true;
  }

  get hairTriangles(): number {
    return this.hair ? this.hair.trianglesPerLock * (this.hairSource?.L.count ?? 0) : 0;
  }

  setHead(p: MeshPayload): void {
    for (const child of [...this.headGroup.children]) {
      this.headGroup.remove(child);
      const i = this.outlines.indexOf(child as Mesh);
      if (i >= 0) this.outlines.splice(i, 1);
      else (child as Mesh).geometry.dispose();
    }
    const g = singleGeometry(p);
    if (g) {
      this.headGroup.add(new Mesh(g, this.toon));
      this.addOutline(this.headGroup, new Mesh(g, this.outline));
    }
    this.requestRender();
  }

  // ---------------------------------------------------------------- view

  /** Drag: turn the character (horizontal) and tilt the camera (vertical), in radians. */
  turn(dYaw: number, dPitch: number, dtMs: number): void {
    this.dragging = true;
    this.yaw += dYaw;
    // Velocity for the spin that continues after release (smoothed over recent moves).
    const v = dtMs > 0 ? dYaw / (dtMs / 1000) : 0;
    this.yawVel = this.yawVel * 0.5 + v * 0.5;
    this.pitchGoal = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitchGoal + dPitch));
    this.requestRender();
  }

  /** Drag ended: let the character keep spinning and slow down. */
  release(idleMs: number): void {
    this.dragging = false;
    if (idleMs > 80) this.yawVel = 0;
    this.yawVel = Math.max(-6, Math.min(6, this.yawVel));
    this.requestRender();
  }

  /** Zoom by a factor (>1 moves away). */
  zoom(factor: number): void {
    this.distGoal = Math.min(DIST_MAX, Math.max(DIST_MIN, this.distGoal * factor));
    this.requestRender();
  }

  /** Brush outline on the surface under the pointer, or hidden when `hit` is null. */
  setCursor(hit: Hit | null, radius: number, color: number): void {
    const c = this.cursor;
    const was = c.visible;
    c.visible = hit !== null;
    if (hit) {
      const n = new Vector3(...hit.n);
      c.position.set(...hit.p).addScaledVector(n, 0.0015);
      c.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n));
      c.scale.setScalar(radius);
      (c.material as MeshBasicMaterial).color.setHex(color);
    }
    if (hit || was) this.requestRender();
  }

  /** Camera ray through a point on the canvas (client pixel coordinates), world space. */
  rayFrom(clientX: number, clientY: number): Ray {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 2 - 1, y = -((clientY - r.top) / r.height) * 2 + 1;
    const o = this.camera.position;
    const d = new Vector3(x, y, 0.5).unproject(this.camera).sub(o).normalize();
    return [o.x, o.y, o.z, d.x, d.y, d.z];
  }

  /** World point -> client pixel coordinates (tests aim with it). */
  toScreen(p: readonly [number, number, number]): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const v = new Vector3(...p).project(this.camera);
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  /** Schedules a single frame; motion, physics and benchmarks keep it going while needed. */
  requestRender(): void {
    if (!this.raf && !this.benchmarking) this.raf = requestAnimationFrame(this.frame);
  }

  async benchmark(seconds = 4): Promise<BenchResult> {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.benchmarking = true;
    this.applyDpr(this.maxDpr);
    const startYaw = this.yaw;
    const times: number[] = [];
    // One full turn of the chair: the hair swings, so this measures physics and drawing together.
    await new Promise<void>((resolve) => {
      let t0 = 0, prev = 0;
      const step = (now: number) => {
        if (!t0) t0 = prev = now;
        const t = (now - t0) / (seconds * 1000);
        if (prev !== now) times.push(now - prev);
        const dt = Math.min(0.05, (now - prev) / 1000) || 1 / 60;
        prev = now;
        this.yaw = startYaw + (1 - Math.cos(Math.min(t, 1) * Math.PI)) * Math.PI;
        this.character.rotation.y = this.yaw;
        this.animate?.(dt);
        this.draw();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    this.benchmarking = false;
    this.requestRender();
    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    return {
      frames: times.length,
      avgFps: 1000 / mean,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      dpr: this.dpr,
      width: size.x,
      height: size.y,
      triangles: this.renderer.info.render.triangles,
    };
  }

  private frame = (now: number): void => {
    this.raf = 0;
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 1 / 60;
    const viewMoving = this.updateView(dt);
    const animating = this.animate?.(dt) ?? false;
    if (this.lastFrame) this.trackInterval(now - this.lastFrame);
    this.draw();
    if (viewMoving || animating) {
      this.lastFrame = now;
      // Only one frame may be pending (a resize may already have scheduled one).
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    } else {
      this.lastFrame = 0;
      this.intervals.length = 0;
      if (this.dpr < this.maxDpr) {
        // Motion stopped: render one crisp frame at full resolution.
        this.applyDpr(this.maxDpr);
        this.draw();
      }
      this.emitStats(true);
    }
  };

  /** Spin momentum and eased tilt/zoom; true while still moving. */
  private updateView(dt: number): boolean {
    let moving = this.dragging;
    if (!this.dragging && this.yawVel !== 0) {
      this.yaw += this.yawVel * dt;
      this.yawVel *= Math.exp(-dt * 3.2); // the chair slows down
      if (Math.abs(this.yawVel) < 0.02) this.yawVel = 0;
      moving = true;
    }
    const k = 1 - Math.exp(-dt * 14);
    const dp = this.pitchGoal - this.pitch, dd = this.distGoal - this.dist;
    if (Math.abs(dp) > 1e-4 || Math.abs(dd) > 1e-5) {
      this.pitch += dp * k;
      this.dist += dd * k;
      moving = true;
    } else {
      this.pitch = this.pitchGoal;
      this.dist = this.distGoal;
    }
    this.character.rotation.y = this.yaw;
    this.placeCamera();
    return moving;
  }

  private placeCamera(): void {
    const c = this.camera;
    c.position.set(0, Math.sin(this.pitch) * this.dist, Math.cos(this.pitch) * this.dist).add(TARGET);
    c.lookAt(TARGET);
    c.updateMatrixWorld();
  }

  /** Lowers resolution while moving if frames are slow; restored when motion stops. */
  private trackInterval(ms: number): void {
    this.intervals.push(ms);
    if (this.intervals.length > 30) this.intervals.shift();
    this.slowFrames = ms > 21 ? this.slowFrames + 1 : 0;
    if (this.slowFrames >= 6 && this.dpr > MIN_DPR) {
      this.applyDpr(Math.max(MIN_DPR, this.dpr - 0.25));
      this.slowFrames = 0;
    }
  }

  private draw(): void {
    this.drawCount++;
    if (this.hairDirty && this.hair && this.hairSource) {
      this.hair.update(this.hairSource);
      this.hairDirty = false;
    }
    this.look.uCamPos.value.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.emitStats(false);
  }

  private emitStats(force: boolean): void {
    if (!this.onStats) return;
    const now = performance.now();
    if (!force && now - this.lastStatsAt < 250) return;
    this.lastStatsAt = now;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const info = this.renderer.info.render;
    const res = this.outlineU.uResolution.value;
    this.onStats({
      dpr: this.dpr,
      frameMs: sorted.length ? sorted[sorted.length >> 1] : 0,
      triangles: info.triangles,
      drawCalls: info.calls,
      hairTriangles: this.hairTriangles,
      width: res.x,
      height: res.y,
    });
  }

  private applyDpr(dpr: number): void {
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.resize(false); // callers draw (or schedule) the next frame themselves
  }

  private resize(scheduleFrame = true): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the bust's width in view on tall (portrait) screens by widening the vertical angle.
    const aspect = w / h, minAspect = 0.9;
    this.camera.fov = aspect >= minAspect ? 30 : (2 * Math.atan((Math.tan((15 * Math.PI) / 180) * minAspect) / aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this.outlineU.uResolution.value);
    this.outlineU.uWidth.value = 2.4 * this.dpr;
    if (scheduleFrame) this.requestRender();
  }

  private addOutline(parent: Group, m: Mesh): void {
    m.visible = this.outlinesOn;
    parent.add(m);
    this.outlines.push(m);
  }

  private addEyes(): void {
    for (const e of EYES) {
      this.colouredSphere(e.r, [0.97, 0.96, 0.93], e.x, e.y, e.z, true);
      const dir = new Vector3(0, -0.04, 1).normalize(); // looking straight ahead
      const p = new Vector3(e.x, e.y, e.z).addScaledVector(dir, e.r * 0.74);
      this.colouredSphere(e.r * 0.46, [0.08, 0.06, 0.1], p.x, p.y, p.z, false);
    }
  }

  private addMouth(): void {
    const m = MOUTH;
    const g: BufferGeometry = new TorusGeometry(m.radius, m.tube, 8, 24, m.arc);
    g.rotateZ(-Math.PI / 2 - m.arc / 2); // centre the arc at the bottom: a slight smile
    g.translate(m.x, m.y, m.z);
    this.colour(g, [0.27, 0.12, 0.15]);
    this.character.add(new Mesh(g, this.toon));
  }

  private colour(g: BufferGeometry, c: [number, number, number]): void {
    const n = g.attributes.position.count;
    const col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) col.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4);
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
  }

  private colouredSphere(r: number, c: [number, number, number], x: number, y: number, z: number, outline: boolean): void {
    const g: BufferGeometry = new SphereGeometry(r, 24, 16);
    this.colour(g, c);
    g.translate(x, y, z);
    this.character.add(new Mesh(g, this.toon));
    if (outline) this.addOutline(this.character, new Mesh(g, this.outline));
  }
}

function gpuName(r: WebGLRenderer): string {
  const gl = r.getContext();
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* some browsers hide it */
  }
  return String(gl.getParameter(gl.RENDERER));
}
