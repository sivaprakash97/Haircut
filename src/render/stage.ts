import {
  BufferAttribute, Group, Mesh, PerspectiveCamera, Scene, SphereGeometry, Spherical, Vector2, Vector3, WebGLRenderer,
  type BufferGeometry, type ShaderMaterial,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EYES } from '../engine/headLayout';
import type { MeshPayload } from '../engine/protocol';
import { chunkGeometries, singleGeometry } from './chunks';
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

const TARGET = new Vector3(0, -0.005, 0);
const MIN_DPR = 0.75;

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly gpu: string;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.05, 10);
  private readonly controls: OrbitControls;
  private readonly look: LookUniforms = createLookUniforms();
  private readonly outlineU: OutlineUniforms = createOutlineUniforms();
  /** Skin, eyes and clothes. */
  private readonly toon;
  /** Hair: same shading, plus optional sand grain. */
  private readonly hairToon;
  private readonly outline;
  private readonly hairGroup = new Group();
  private readonly headGroup = new Group();
  private readonly outlines: Mesh[] = [];
  private maxDpr = 1.5;
  private dpr = 1;
  private raf = 0;
  private lastFrame = 0;
  private intervals: number[] = [];
  private slowFrames = 0;
  private benchmarking = false;
  private hairTriangles = 0;
  private showOutline = true;
  onStats: ((s: FrameStats) => void) | null = null;
  private lastStatsAt = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.autoClear = true;
    this.gpu = gpuName(this.renderer);
    this.toon = createToonMaterial(this.look, { value: 0 });
    this.hairToon = createToonMaterial(this.look);
    this.outline = createOutlineMaterial(this.outlineU);

    this.scene.add(createBackground(this.outlineU.uResolution), this.hairGroup, this.headGroup);
    this.addEyes();

    this.camera.position.set(0.33, 0.12, 0.75).add(TARGET);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.32;
    this.controls.maxDistance = 1.4;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.95; // the bust is cut off below the shoulders
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.8;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.update();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setMaxDpr(maxDpr: number): void {
    this.maxDpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    this.applyDpr(this.maxDpr);
    this.requestRender();
  }

  setLook(look: Look): void {
    this.showOutline = look.outline;
    for (const o of this.outlines) o.visible = look.outline;
    this.look.uAO.value = look.ao ? 1 : 0;
    this.look.uGrain.value = look.grain ? 1 : 0;
    this.requestRender();
  }

  setHair(p: MeshPayload): void {
    this.replace(this.hairGroup, chunkGeometries(p), this.hairToon);
    this.hairTriangles = p.indices.length / 3;
    this.requestRender();
  }

  setHead(p: MeshPayload): void {
    const g = singleGeometry(p);
    this.replace(this.headGroup, g ? [g] : [], this.toon);
    this.requestRender();
  }

  /** Schedules a single frame; damping and benchmarks keep it going while needed. */
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
    const moving = this.controls.update();
    if (this.lastFrame) this.trackInterval(now - this.lastFrame);
    this.draw();
    if (moving) {
      this.lastFrame = now;
      this.raf = requestAnimationFrame(this.frame);
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
    this.resize();
  }

  private resize(): void {
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
    this.requestRender();
  }

  private replace(group: Group, geometries: BufferGeometry[], material: ShaderMaterial): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof Mesh && child.material === material) child.geometry.dispose(); // outline shares it
      const i = this.outlines.indexOf(child as Mesh);
      if (i >= 0) this.outlines.splice(i, 1);
    }
    for (const g of geometries) this.addMesh(group, g, material);
  }

  private addMesh(group: Group, g: BufferGeometry, material: ShaderMaterial): void {
    group.add(new Mesh(g, material));
    const o = new Mesh(g, this.outline);
    o.visible = this.showOutline;
    this.outlines.push(o);
    group.add(o);
  }

  private addEyes(): void {
    const eyes = new Group();
    for (const e of EYES) {
      eyes.add(...this.colouredSphere(e.r, [0.97, 0.96, 0.93], e.x, e.y, e.z));
      const dir = new Vector3(0, -0.04, 1).normalize(); // looking straight ahead
      const p = new Vector3(e.x, e.y, e.z).addScaledVector(dir, e.r * 0.74);
      eyes.add(...this.colouredSphere(e.r * 0.46, [0.08, 0.06, 0.1], p.x, p.y, p.z, false));
    }
    this.scene.add(eyes);
  }

  private colouredSphere(r: number, c: [number, number, number], x: number, y: number, z: number, outline = true): Mesh[] {
    const g = new SphereGeometry(r, 24, 16);
    const n = g.attributes.position.count;
    const col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) col.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4);
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    g.translate(x, y, z);
    const meshes = [new Mesh(g, this.toon)];
    if (outline) {
      const o = new Mesh(g, this.outline);
      this.outlines.push(o);
      meshes.push(o);
    }
    return meshes;
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
