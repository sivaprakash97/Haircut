import { BackSide, Color, Mesh, BufferGeometry, BufferAttribute, ShaderMaterial, Vector2, Vector3 } from 'three';

// Colours are authored in sRGB and written straight to the canvas (these
// shaders skip three's colour-space conversion), which suits flat toon colour.

export interface LookUniforms {
  uLightDir: { value: Vector3 };
  uCamPos: { value: Vector3 };
  uShadowTint: { value: Color };
  uRim: { value: Color };
  uAO: { value: number };
  uGrain: { value: number };
}

export function createLookUniforms(): LookUniforms {
  return {
    uLightDir: { value: new Vector3(-0.45, 0.8, 0.55).normalize() },
    uCamPos: { value: new Vector3() },
    uShadowTint: { value: new Color(0.6, 0.54, 0.8) },
    uRim: { value: new Color(1.0, 0.93, 0.8) },
    uAO: { value: 1 },
    uGrain: { value: 0 },
  };
}

const toonVertex = /* glsl */ `
attribute vec4 aColor;
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vC = aColor;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const toonFragment = /* glsl */ `
uniform vec3 uLightDir;
uniform vec3 uCamPos;
uniform vec3 uShadowTint;
uniform vec3 uRim;
uniform float uAO;
uniform float uGrain;
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCamPos - vW);
  float ndl = dot(n, uLightDir);
  float aa = fwidth(ndl) * 1.2 + 0.03;                   // slightly soft edge reads as clay
  float lit = smoothstep(-aa, aa, ndl - 0.03);           // light/shadow terminator
  float hi = smoothstep(0.72 - aa, 0.72 + aa, ndl);      // small highlight band
  vec3 base = vC.rgb;
  vec3 col = mix(base * uShadowTint, base, lit);
  col = mix(col, min(base * 1.1 + 0.03, vec3(1.0)), hi * 0.4);

  // Clay crevices: baked ambient occlusion.
  col *= mix(1.0, vC.a, uAO);

  // Rim light on the lit side.
  float fres = 1.0 - max(dot(n, v), 0.0);
  float rim = smoothstep(0.6, 0.66, fres) * smoothstep(-0.1, 0.35, ndl);
  col += uRim * rim * 0.22;

  // Packed-sand grain, fixed in world space so it does not swim.
  if (uGrain > 0.0) {
    float g = hash(floor(vW * 1100.0));
    col *= 1.0 - uGrain * (step(0.78, g) * 0.11 - step(g, 0.08) * 0.06);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** `grain` overrides the shared grain uniform, so skin can stay smooth while hair is sandy. */
export function createToonMaterial(look: LookUniforms, grain?: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...look, uGrain: grain ?? look.uGrain },
    vertexShader: toonVertex,
    fragmentShader: toonFragment,
  });
}

const outlineVertex = /* glsl */ `
uniform float uWidth;
uniform vec2 uResolution;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * viewMatrix * w;
  vec3 nW = normalize(mat3(modelMatrix) * normal);
  vec2 dir = (projectionMatrix * viewMatrix * vec4(nW, 0.0)).xy;
  float l = length(dir);
  dir = l > 1e-5 ? dir / l : vec2(0.0);
  clip.xy += dir * uWidth * clip.w * 2.0 / uResolution; // constant width in pixels
  gl_Position = clip;
}`;

const outlineFragment = /* glsl */ `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

export interface OutlineUniforms {
  uWidth: { value: number };
  uResolution: { value: Vector2 };
  uColor: { value: Color };
}

export function createOutlineUniforms(): OutlineUniforms {
  return { uWidth: { value: 2.5 }, uResolution: { value: new Vector2(1, 1) }, uColor: { value: new Color(0.1, 0.07, 0.16) } };
}

/** Inverted-hull outline: back faces pushed out along normals. No extra full-screen pass. */
export function createOutlineMaterial(u: OutlineUniforms): ShaderMaterial {
  return new ShaderMaterial({ uniforms: { ...u }, vertexShader: outlineVertex, fragmentShader: outlineFragment, side: BackSide });
}

const bgVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}`;

const bgFragment = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec2 uResolution;
varying vec2 vUv;
void main() {
  vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
  // Soft halftone dots toward the bottom, for a little street-poster texture.
  vec2 cellPx = gl_FragCoord.xy / (12.0 * max(1.0, uResolution.y / 900.0));
  float r = length(fract(cellPx) - 0.5);
  float dots = (1.0 - smoothstep(0.18, 0.22, r)) * (1.0 - smoothstep(0.0, 0.55, vUv.y));
  col = mix(col, col * 0.93, dots);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Full-screen gradient drawn behind everything (one triangle). */
export function createBackground(resolution: { value: Vector2 }): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const m = new ShaderMaterial({
    uniforms: { uTop: { value: new Color(0x9fd8ff) }, uBottom: { value: new Color(0xfff0d2) }, uResolution: resolution },
    vertexShader: bgVertex,
    fragmentShader: bgFragment,
    depthWrite: false,
  });
  const mesh = new Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
