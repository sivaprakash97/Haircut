import {
  BackSide, BufferAttribute, DataTexture, FloatType, InstancedBufferGeometry, Mesh, RGBAFormat, ShaderMaterial, Sphere, Vector3,
} from 'three';
import type { DebrisPool } from '../hair/debris';
import { DEBRIS } from '../hair/debris';
import { NODES, type LockData, lastNode } from '../hair/locks';
import type { LookUniforms, OutlineUniforms } from './materials';
import { toonFragment } from './materials';

// Draws every lock as a tapered tube in one instanced draw (plus one for the
// outline). The geometry holds no vertex data at all: the vertex shader reads
// the lock's node positions from a float texture, so after the physics moves
// the hair only that texture (a few hundred KB) is uploaded.

/** What the renderer reads each frame. */
export interface LockSource {
  L: LockData;
  /** World positions of the lock nodes (NODES × 3 per lock). */
  pos: Float32Array;
  /** cos and sin of the character's turn, to bring root normals into world space. */
  cos: number;
  sin: number;
  debris: DebrisPool;
}

export interface LockDetail {
  /** Rings per segment (Catmull-Rom between nodes). */
  sub: number;
  /** Sides per ring. */
  sides: number;
}

const TEXELS = 3;

const lockVertex = /* glsl */ `
precision highp float;
precision highp int;
#define NODES ${NODES}
uniform highp sampler2D uNodes;
uniform highp sampler2D uLocks;
uniform int uSides;
uniform int uSub;

vec3 unpackOct(float p) {
  float qu = floor(p / 4096.0);
  float qv = p - qu * 4096.0;
  vec2 e = vec2(qu, qv) / 4095.0 * 2.0 - 1.0;
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-v.z, 0.0);
  v.x += v.x >= 0.0 ? -t : t;
  v.y += v.y >= 0.0 ? -t : t;
  return normalize(v);
}

/** Position, normal, distance from the original root (m) and lock data for this vertex. */
void lockVertex(out vec3 P, out vec3 N, out float along, out vec4 lockA, out vec4 lockB) {
  int row = gl_InstanceID;
  int ring = gl_VertexID / uSides;
  int side = gl_VertexID - ring * uSides;
  lockA = texelFetch(uLocks, ivec2(0, row), 0); // len (segments), radius, segment length, hold
  lockB = texelFetch(uLocks, ivec2(1, row), 0); // r, g, b, blunt
  vec4 lockC = texelFetch(uLocks, ivec2(2, row), 0); // first segment (cut pieces), full length (segments)
  float len = lockA.x;
  int rings = (NODES - 1) * uSub + 1;
  // Ring 0 closes the start, ring rings + 1 closes the end; the rest follow the lock.
  bool cap = ring == 0 || ring > rings;
  float t = ring == 0 ? 0.0 : ring > rings ? len : min(float(ring - 1) / float(uSub), len);
  int last = clamp(int(ceil(len - 1e-4)), 1, NODES - 1);
  int k = min(int(floor(t)), last - 1);
  float f = t - float(k);
  vec4 n1 = texelFetch(uNodes, ivec2(k, row), 0);
  vec4 n2 = texelFetch(uNodes, ivec2(k + 1, row), 0);
  vec3 p1 = n1.xyz, p2 = n2.xyz;
  vec3 p0 = k > 0 ? texelFetch(uNodes, ivec2(k - 1, row), 0).xyz : 2.0 * p1 - p2;
  vec3 p3 = k + 2 <= last ? texelFetch(uNodes, ivec2(k + 2, row), 0).xyz : 2.0 * p2 - p1;
  // Catmull-Rom through the nodes, so locks curve smoothly.
  vec3 a = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
  vec3 b = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
  P = 0.5 * (2.0 * p1 + (p2 - p0) * f + a * f * f + b * f * f * f);
  vec3 T = 0.5 * ((p2 - p0) + 2.0 * a * f + 3.0 * b * f * f);
  float tl = length(T);
  T = tl > 1e-7 ? T / tl : normalize(p2 - p1 + vec3(0.0, -1e-6, 0.0));
  vec3 Y = mix(unpackOct(n1.w), unpackOct(n2.w), f);
  Y = Y - T * dot(Y, T);
  float yl = length(Y);
  Y = yl > 1e-5 ? Y / yl : normalize(cross(T, abs(T.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(T, Y);

  // Thickness: tapers to a point over the last few centimetres, or stays
  // nearly full width to a flat end where it was cut.
  float seg = lockA.z;
  float s = (lockC.x + t) * seg;
  float S = max(lockC.y * seg, 1e-4);
  float r = lockA.y;
  float zone = min(S * 0.8, 0.07);
  float pointed = pow(clamp((S - s) / zone, 0.0, 1.0), 0.6);
  // A cut end keeps most of its width, with a small bevel at the very end.
  float cutEnd = (1.0 - 0.18 * s / S) * mix(0.78, 1.0, smoothstep(0.0, 0.005, S - s));
  r *= mix(pointed, cutEnd, lockB.w);
  r *= mix(0.72, 1.0, smoothstep(0.0, 0.014, s)); // narrower where it leaves the scalp
  r *= 1.0 + 0.12 * sin(3.14159 * clamp(s / S, 0.0, 1.0));
  if (cap) r = 0.0;

  // Slightly flattened: wider along the scalp than it is thick.
  float ang = 6.2831853 * float(side) / float(uSides);
  float ca = cos(ang), sa = sin(ang);
  P += (B * (ca * 1.15) + Y * (sa * 0.72)) * r;
  N = cap ? (ring == 0 ? -T : T) : normalize(B * (ca / 1.15) + Y * (sa / 0.72));
  along = s;
}
`;

const fillVertex = /* glsl */ `
${lockVertex}
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
void main() {
  vec3 P, N; float along; vec4 la, lb;
  lockVertex(P, N, along, la, lb);
  vW = P;
  vN = N;
  // Darker toward the roots, where the hair is packed: depth without real shadows.
  vC = vec4(lb.rgb, mix(0.6, 1.0, smoothstep(0.0, 0.06, along)));
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const outlineVertex = /* glsl */ `
${lockVertex}
uniform float uWidth;
uniform vec2 uResolution;
void main() {
  vec3 P, N; float along; vec4 la, lb;
  lockVertex(P, N, along, la, lb);
  vec4 clip = projectionMatrix * viewMatrix * vec4(P, 1.0);
  vec2 dir = (projectionMatrix * viewMatrix * vec4(N, 0.0)).xy;
  float l = length(dir);
  dir = l > 1e-5 ? dir / l : vec2(0.0);
  // Thinner than the head's outline: locks are small, and many overlap.
  clip.xy += dir * uWidth * 0.7 * clip.w * 2.0 / uResolution;
  gl_Position = clip;
}`;

const outlineFragment = /* glsl */ `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

export class LockMesh {
  readonly fill: Mesh;
  readonly outline: Mesh;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly nodeTex: DataTexture;
  private readonly lockTex: DataTexture;
  private readonly nodeData: Float32Array;
  private readonly lockData: Float32Array;
  private readonly rows: number;
  private readonly uniforms: { uNodes: { value: DataTexture }; uLocks: { value: DataTexture }; uSides: { value: number }; uSub: { value: number } };

  constructor(private readonly count: number, look: LookUniforms, outline: OutlineUniforms) {
    this.rows = count + DEBRIS;
    this.nodeData = new Float32Array(this.rows * NODES * 4);
    this.lockData = new Float32Array(this.rows * TEXELS * 4);
    this.nodeTex = new DataTexture(this.nodeData, NODES, this.rows, RGBAFormat, FloatType);
    this.lockTex = new DataTexture(this.lockData, TEXELS, this.rows, RGBAFormat, FloatType);
    this.uniforms = { uNodes: { value: this.nodeTex }, uLocks: { value: this.lockTex }, uSides: { value: 6 }, uSub: { value: 2 } };

    this.geometry.instanceCount = count;
    // Never culled as a whole; the sphere just keeps three.js from computing one from (absent) positions.
    this.geometry.boundingSphere = new Sphere(new Vector3(0, -0.05, 0), 0.6);
    const fillMat = new ShaderMaterial({
      uniforms: { ...look, ...this.uniforms },
      vertexShader: fillVertex,
      fragmentShader: toonFragment,
    });
    const outlineMat = new ShaderMaterial({
      uniforms: { ...outline, ...this.uniforms },
      vertexShader: outlineVertex,
      fragmentShader: outlineFragment,
      side: BackSide,
    });
    this.fill = new Mesh(this.geometry, fillMat);
    this.outline = new Mesh(this.geometry, outlineMat);
    for (const m of [this.fill, this.outline]) m.frustumCulled = false;
  }

  /** Tube resolution (rings per segment, sides): rebuilt only when the quality changes. */
  setDetail(d: LockDetail): void {
    this.uniforms.uSub.value = d.sub;
    this.uniforms.uSides.value = d.sides;
    const rings = (NODES - 1) * d.sub + 3; // plus a closing ring at each end
    const idx = new Uint16Array((rings - 1) * d.sides * 6);
    let n = 0;
    for (let r = 0; r < rings - 1; r++) {
      for (let s = 0; s < d.sides; s++) {
        const a = r * d.sides + s, b = r * d.sides + ((s + 1) % d.sides);
        const c = a + d.sides, e = b + d.sides;
        idx[n++] = a; idx[n++] = c; idx[n++] = e;
        idx[n++] = a; idx[n++] = e; idx[n++] = b;
      }
    }
    this.geometry.setIndex(new BufferAttribute(idx, 1));
  }

  /** Triangles in one full lock (for stats). */
  get trianglesPerLock(): number {
    return (this.geometry.index?.count ?? 0) / 3;
  }

  /** Copies node positions (plus a twist-free frame per node) and lock data into the textures. */
  update(src: LockSource): void {
    const { L, pos, cos: c, sin: s, debris } = src;
    const ld = this.lockData;
    for (let i = 0; i < this.count; i++) {
      const nx = L.normal[i * 3], ny = L.normal[i * 3 + 1], nz = L.normal[i * 3 + 2];
      this.writeNodes(i, pos, i * NODES * 3, lastNode(L.len[i]), c * nx + s * nz, ny, -s * nx + c * nz);
      const o = i * TEXELS * 4, col = L.color[i];
      ld[o] = L.len[i]; ld[o + 1] = L.radius[i]; ld[o + 2] = L.seg[i]; ld[o + 3] = L.hold[i];
      ld[o + 4] = ((col >> 16) & 255) / 255; ld[o + 5] = ((col >> 8) & 255) / 255; ld[o + 6] = (col & 255) / 255; ld[o + 7] = L.blunt[i];
      ld[o + 8] = 0; ld[o + 9] = L.len[i];
    }
    let used = 0;
    for (let k = 0; k < DEBRIS; k++) {
      const row = this.count + k, o = row * TEXELS * 4;
      const len = debris.len[k];
      ld[o] = len;
      if (len === 0) {
        ld[o + 1] = 0;
        continue;
      }
      used = k + 1;
      this.writeNodes(row, debris.pos, k * NODES * 3, lastNode(len), 0, 1, 0);
      const col = debris.color[k];
      ld[o + 1] = debris.radius[k] * debris.scale(k); ld[o + 2] = debris.seg[k]; ld[o + 3] = 0;
      ld[o + 4] = ((col >> 16) & 255) / 255; ld[o + 5] = ((col >> 8) & 255) / 255; ld[o + 6] = (col & 255) / 255; ld[o + 7] = debris.blunt[k];
      ld[o + 8] = debris.tStart[k]; ld[o + 9] = debris.fullLen[k];
    }
    // Only draw debris rows up to the last one in use.
    this.geometry.instanceCount = this.count + used;
    this.nodeTex.needsUpdate = true;
    this.lockTex.needsUpdate = true;
  }

  /**
   * One lock's nodes: positions, plus a cross-section orientation carried down
   * the lock by parallel transport (starting from the skin normal), so tubes
   * never twist or pinch.
   */
  private writeNodes(row: number, pos: Float32Array, base: number, last: number, ux: number, uy: number, uz: number): void {
    const nd = this.nodeData;
    let yx = ux, yy = uy, yz = uz;
    for (let j = 0; j <= last; j++) {
      const p = base + j * 3;
      const a = j > 0 ? p - 3 : p, b = j < last ? p + 3 : p;
      let tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-9) {
        tx /= tl; ty /= tl; tz /= tl;
        const d = yx * tx + yy * ty + yz * tz;
        let qx = yx - tx * d, qy = yy - ty * d, qz = yz - tz * d;
        let ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
        if (ql < 1e-4) {
          // The lock runs straight along the reference: any perpendicular will do.
          if (Math.abs(ty) < 0.9) { qx = -tz; qy = 0; qz = tx; } else { qx = 0; qy = tz; qz = -ty; }
          ql = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
        }
        yx = qx / ql; yy = qy / ql; yz = qz / ql;
      }
      const o = (row * NODES + j) * 4;
      nd[o] = pos[p]; nd[o + 1] = pos[p + 1]; nd[o + 2] = pos[p + 2];
      nd[o + 3] = packOct(yx, yy, yz);
    }
  }
}

/** Unit vector -> one float holding two 12-bit octahedral coordinates (exact in float32). */
export function packOct(x: number, y: number, z: number): number {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1, v = y / l1;
  if (z < 0) {
    const pu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1), pv = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = pu;
    v = pv;
  }
  const qu = Math.round((u * 0.5 + 0.5) * 4095), qv = Math.round((v * 0.5 + 0.5) * 4095);
  return qu * 4096 + qv;
}
