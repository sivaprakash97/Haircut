import {
  BufferAttribute, Group, MOUSE, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, RingGeometry, Scene,
  SphereGeometry, Spherical, TOUCH, TorusGeometry, Vector2, Vector3, WebGLRenderer, type BufferGeometry, type ShaderMaterial,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Ray } from '../engine/pick';
import { EYES, MOUTH } from '../engine/headLayout';
import type { HitInfo, MeshPayload } from '../engine/protocol';
import { singleGeometry } from './chunks';
import { HairMesh } from './hairMesh';
import {
  createBackground, createLookUniforms, createOutlineMaterial, createOutlineUniforms, createToonMaterial,
  type LookUniforms, type OutlineUniforms,
} from './materials';

export interface Look {
  outline: boolean;
  ao: boolean;
  grain: boolean;
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

interface Debris {
  fill: Mesh;
  outline: Mesh;
  v: Vector3;
  spin: Vector3;
  age: number;
}

const TARGET = new Vector3(0, -0.005, 0);
const HEAD_CENTRE = new Vector3(0, 0.03, -0.005);
const MIN_DPR = 0.75;
const DEBRIS_LIFE = 1.5;

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly gpu: string;
  readonly orbit: OrbitControls;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.05, 10);
  private readonly look: LookUniforms = createLookUniforms();
  private readonly outlineU: OutlineUniforms = createOutlineUniforms();
  /** Skin, eyes and clothes. */
  private readonly toon: ShaderMaterial;
  /** Hair: same shading, plus sand grain and gel/dryer looks. */
  private readonly hairToon: ShaderMaterial;
  private readonly outline: ShaderMaterial;
  private readonly hair: HairMesh;
  private readonly headGroup = new Group();
  /** Every outline mesh lives here so one switch shows or hides them all. */
  private readonly outlineRoot = new Group();
  private readonly debris: Debris[] = [];
  private readonly cursor: Mesh;
  private maxDpr = 1.5;
  private dpr = 1;
  private raf = 0;
  private lastFrame = 0;
  private intervals: number[] = [];
  private slowFrames = 0;
  private benchmarking = false;
  onStats: ((s: FrameStats) => void) | null = null;
  private lastStatsAt = 0;
  /** Number of frames drawn so far (used by tests to catch duplicate render loops). */
  drawCount = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.gpu = gpuName(this.renderer);
    this.toon = createToonMaterial(this.look, false);
    this.hairToon = createToonMaterial(this.look, true);
    this.outline = createOutlineMaterial(this.outlineU);
    this.hair = new HairMesh(this.hairToon, this.outline);
    this.outlineRoot.add(this.hair.outlines);

    this.cursor = new Mesh(
      new RingGeometry(0.84, 1, 48),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;

    this.scene.add(createBackground(this.outlineU.uResolution), this.hair.fills, this.headGroup, this.outlineRoot, this.cursor);
    this.addEyes();
    this.addMouth();

    this.camera.position.set(0.33, 0.12, 0.75).add(TARGET);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.copy(TARGET);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.enablePan = false;
    this.orbit.minDistance = 0.32;
    this.orbit.maxDistance = 1.4;
    this.orbit.minPolarAngle = 0.25;
    this.orbit.maxPolarAngle = 1.95; // the bust is cut off below the shoulders
    this.orbit.rotateSpeed = 0.85;
    this.orbit.zoomSpeed = 0.8;
    // Right-drag (or a two-finger trackpad click) always rotates, even over the hair.
    this.orbit.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.orbit.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    this.orbit.addEventListener('change', () => this.requestRender());
    this.orbit.update();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setMaxDpr(maxDpr: number): void {
    this.maxDpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    this.applyDpr(this.maxDpr);
    this.requestRender();
  }

  setLook(look: Look): void {
    this.outlineRoot.visible = look.outline;
    this.look.uAO.value = look.ao ? 1 : 0;
    this.look.uGrain.value = look.grain ? 1 : 0;
    this.requestRender();
  }

  /** Replaces all hair (a new hairstyle or quality). */
  setHair(p: MeshPayload): void {
    this.hair.apply(p, true);
    this.requestRender();
  }

  /** Applies re-meshed bricks from an edit. */
  updateHair(p: MeshPayload, replaceAll: boolean): void {
    this.hair.apply(p, replaceAll);
    this.requestRender();
  }

  get hairTriangles(): number {
    return this.hair.triangles;
  }

  setHead(p: MeshPayload): void {
    for (const child of [...this.headGroup.children]) {
      this.headGroup.remove(child);
      (child as Mesh).geometry.dispose();
    }
    for (const child of [...this.outlineRoot.children]) if (child.userData.head) this.outlineRoot.remove(child);
    const g = singleGeometry(p);
    if (g) {
      this.headGroup.add(new Mesh(g, this.toon));
      const o = new Mesh(g, this.outline);
      o.userData.head = true;
      this.outlineRoot.add(o);
    }
    this.requestRender();
  }

  /** A piece cut loose: it tumbles away and shrinks out of sight. */
  addDebris(p: MeshPayload): void {
    const g = singleGeometry(p);
    if (!g) return;
    const c = g.boundingSphere!.center.clone();
    g.translate(-c.x, -c.y, -c.z);
    const fill = new Mesh(g, this.hairToon), outline = new Mesh(g, this.outline);
    fill.position.copy(c);
    outline.position.copy(c);
    const away = c.clone().sub(HEAD_CENTRE).setY(0).normalize().multiplyScalar(0.18);
    const v = away.add(new Vector3(0, 0.22, 0));
    const spin = new Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    this.scene.add(fill);
    this.outlineRoot.add(outline);
    this.debris.push({ fill, outline, v, spin, age: 0 });
    this.requestRender();
  }

  /** Brush outline on the surface under the pointer, or hidden when `hit` is null. */
  setCursor(hit: HitInfo | null, radius: number, color: number): void {
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

  /** Camera ray through a point on the canvas (client pixel coordinates). */
  rayFrom(clientX: number, clientY: number): Ray {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 2 - 1, y = -((clientY - r.top) / r.height) * 2 + 1;
    const o = this.camera.position;
    const d = new Vector3(x, y, 0.5).unproject(this.camera).sub(o).normalize();
    return [o.x, o.y, o.z, d.x, d.y, d.z];
  }

  /** Schedules a single frame; damping, falling debris and benchmarks keep it going while needed. */
  requestRender(): void {
    if (!this.raf && !this.benchmarking) this.raf = requestAnimationFrame(this.frame);
  }

  async benchmark(seconds = 4): Promise<BenchResult> {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.benchmarking = true;
    this.applyDpr(this.maxDpr);
    const start = this.camera.position.clone().sub(TARGET);
    const sph = new Spherical().setFromVector3(start);
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      let t0 = 0, prev = 0;
      const step = (now: number) => {
        if (!t0) t0 = prev = now;
        const t = (now - t0) / (seconds * 1000);
        if (prev !== now) times.push(now - prev);
        prev = now;
        const s = sph.clone();
        s.theta += Math.min(t, 1) * Math.PI * 2;
        this.camera.position.setFromSpherical(s).add(TARGET);
        this.camera.lookAt(TARGET);
        this.draw();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    this.camera.position.copy(start).add(TARGET);
    this.camera.lookAt(TARGET);
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
    const animating = this.updateDebris(dt);
    const moving = this.orbit.update() || animating;
    if (this.lastFrame) this.trackInterval(now - this.lastFrame);
    this.draw();
    if (moving) {
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

  private updateDebris(dt: number): boolean {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age >= DEBRIS_LIFE) {
        this.scene.remove(d.fill);
        this.outlineRoot.remove(d.outline);
        d.fill.geometry.dispose();
        this.debris.splice(i, 1);
        continue;
      }
      d.v.y -= 2.4 * dt; // a slow, cartoonish fall
      for (const m of [d.fill, d.outline]) {
        m.position.addScaledVector(d.v, dt);
        m.rotation.x += d.spin.x * dt;
        m.rotation.y += d.spin.y * dt;
        m.rotation.z += d.spin.z * dt;
        m.scale.setScalar(Math.min(1, (DEBRIS_LIFE - d.age) / 0.35));
      }
    }
    return this.debris.length > 0;
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
      hairTriangles: this.hair.triangles,
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
    this.scene.add(new Mesh(g, this.toon));
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
    this.scene.add(new Mesh(g, this.toon));
    if (outline) this.outlineRoot.add(new Mesh(g, this.outline));
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
