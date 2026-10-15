// Throwaway feasibility benchmark for the "lock field" hair representation.
// Not app code. Measures CPU cost of the operations a brush stroke triggers.
// Units: metres. Head = sphere r=0.1 at origin, roots on upper cap.

const argv = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const N = +(argv.N ?? 3000);      // locks
const P = +(argv.P ?? 12);        // spine (guide) points per lock
const E = +(argv.E ?? 24);        // evaluated samples per lock (after curl etc.)
const S = +(argv.S ?? 5);         // tube sides
const R = 0.1;

// ---------- state (SoA, fixed capacity) ----------
const spine = new Float32Array(N * P * 3);
const len = new Float32Array(N);
const curlR = new Float32Array(N), curlF = new Float32Array(N), thick = new Float32Array(N);
const evalPts = new Float32Array(N * E * 3);
const pos = new Float32Array(N * E * S * 3);
const nrm = new Float32Array(N * E * S * 3);

// static index buffer: topology never changes, only vertex positions do
const index = new Uint32Array(N * (E - 1) * S * 6);
{
  let k = 0;
  for (let l = 0; l < N; l++) {
    const base = l * E * S;
    for (let i = 0; i < E - 1; i++) for (let j = 0; j < S; j++) {
      const a = base + i * S + j, b = base + i * S + (j + 1) % S;
      const c = a + S, d = b + S;
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
}

function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rand = rnd(42);

// roots: fibonacci points on upper cap, spine droops outward+down (cheap stand-in for a pose solve)
for (let l = 0; l < N; l++) {
  const t = (l + 0.5) / N, y = 1 - t * 0.9, r = Math.sqrt(1 - y * y), phi = l * 2.399963;
  const nx = r * Math.cos(phi), ny = y, nz = r * Math.sin(phi);
  const L = 0.08 + rand() * 0.07; len[l] = L;
  curlR[l] = 0.006; curlF[l] = 40; thick[l] = 0.006;
  for (let i = 0; i < P; i++) {
    const s = (i / (P - 1)) * L;
    const o = (l * P + i) * 3;
    spine[o] = nx * (R + s * 0.6); spine[o + 1] = ny * R + s * (0.6 * ny - 0.5); spine[o + 2] = nz * (R + s * 0.6);
  }
}

// ---------- evaluation: spine -> evaluated points with procedural curl ----------
const tmp = new Float32Array(E * 3);
function evalLock(l) {
  // resample spine at E samples (linear), then offset by curl in a parallel-transport frame
  const so = l * P * 3, eo = l * E * 3;
  for (let i = 0; i < E; i++) {
    const u = (i / (E - 1)) * (P - 1), i0 = Math.min(P - 2, Math.floor(u)), f = u - i0;
    const a = so + i0 * 3, b = a + 3;
    tmp[i * 3] = spine[a] + (spine[b] - spine[a]) * f;
    tmp[i * 3 + 1] = spine[a + 1] + (spine[b + 1] - spine[a + 1]) * f;
    tmp[i * 3 + 2] = spine[a + 2] + (spine[b + 2] - spine[a + 2]) * f;
  }
  let tx = tmp[3] - tmp[0], ty = tmp[4] - tmp[1], tz = tmp[5] - tmp[2];
  let tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  // initial normal: any perpendicular
  let nx = -tz, ny = 0, nz = tx; let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-6) { nx = 1; ny = 0; nz = 0; nl = 1; } nx /= nl; ny /= nl; nz /= nl;
  const cr = curlR[l], cf = curlF[l], L = len[l];
  for (let i = 0; i < E; i++) {
    if (i > 0 && i < E - 1) {
      let ux = tmp[i * 3 + 3] - tmp[i * 3 - 3], uy = tmp[i * 3 + 4] - tmp[i * 3 - 2], uz = tmp[i * 3 + 5] - tmp[i * 3 - 1];
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      // transport normal: remove component along new tangent
      const d = nx * ux + ny * uy + nz * uz; nx -= d * ux; ny -= d * uy; nz -= d * uz;
      const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m; tx = ux; ty = uy; tz = uz;
    }
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const s = (i / (E - 1)) * L, th = s * cf, ramp = Math.min(1, s / 0.01) * cr;
    const c = Math.cos(th) * ramp, sn = Math.sin(th) * ramp;
    evalPts[eo + i * 3] = tmp[i * 3] + nx * c + bx * sn;
    evalPts[eo + i * 3 + 1] = tmp[i * 3 + 1] + ny * c + by * sn;
    evalPts[eo + i * 3 + 2] = tmp[i * 3 + 2] + nz * c + bz * sn;
  }
}

// ---------- meshing: evaluated points -> tapered tube, fixed vertex count ----------
function meshLock(l) {
  const eo = l * E * 3, vo = l * E * S * 3;
  let nx = 0, ny = 1, nz = 0;
  for (let i = 0; i < E; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(E - 1, i + 1);
    let tx = evalPts[eo + i1 * 3] - evalPts[eo + i0 * 3], ty = evalPts[eo + i1 * 3 + 1] - evalPts[eo + i0 * 3 + 1], tz = evalPts[eo + i1 * 3 + 2] - evalPts[eo + i0 * 3 + 2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const d = nx * tx + ny * ty + nz * tz; nx -= d * tx; ny -= d * ty; nz -= d * tz;
    let m = Math.hypot(nx, ny, nz); if (m < 1e-6) { nx = -tz; ny = 0; nz = tx; m = Math.hypot(nx, ny, nz) || 1; } nx /= m; ny /= m; nz /= m;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const rad = thick[l] * (1 - 0.85 * (i / (E - 1)));
    for (let j = 0; j < S; j++) {
      const a = (j / S) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const ox = nx * c + bx * s, oy = ny * c + by * s, oz = nz * c + bz * s;
      const v = vo + (i * S + j) * 3;
      pos[v] = evalPts[eo + i * 3] + ox * rad; pos[v + 1] = evalPts[eo + i * 3 + 1] + oy * rad; pos[v + 2] = evalPts[eo + i * 3 + 2] + oz * rad;
      nrm[v] = ox; nrm[v + 1] = oy; nrm[v + 2] = oz;
    }
  }
}

// ---------- brush ops ----------
const touched = new Int32Array(N); let nTouched = 0;
function brushQuery(cx, cy, cz, r) {
  nTouched = 0; const r2 = r * r;
  for (let l = 0; l < N; l++) {
    const eo = l * E * 3;
    for (let i = 0; i < E; i++) {
      const dx = evalPts[eo + i * 3] - cx, dy = evalPts[eo + i * 3 + 1] - cy, dz = evalPts[eo + i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz < r2) { touched[nTouched++] = l; break; }
    }
  }
}
function cutTouched(cx, cy, cz, r) {
  const r2 = r * r;
  for (let k = 0; k < nTouched; k++) {
    const l = touched[k], eo = l * E * 3;
    let first = E;
    for (let i = 0; i < E; i++) {
      const dx = evalPts[eo + i * 3] - cx, dy = evalPts[eo + i * 3 + 1] - cy, dz = evalPts[eo + i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz < r2) { first = i; break; }
    }
    const keep = first / (E - 1); // fraction of arc length kept (curl preserves spine param)
    if (keep >= 1) continue;
    // resample spine to the shorter length: same P points, so topology is unchanged
    const so = l * P * 3, old = spine.slice(so, so + P * 3);
    for (let i = 0; i < P; i++) {
      const u = (i / (P - 1)) * keep * (P - 1), i0 = Math.min(P - 2, Math.floor(u)), f = u - i0;
      for (let c = 0; c < 3; c++) spine[so + i * 3 + c] = old[i0 * 3 + c] + (old[i0 * 3 + 3 + c] - old[i0 * 3 + c]) * f;
    }
    len[l] *= keep;
    evalLock(l); meshLock(l);
  }
}
function snapshotTouched() {
  // undo record: copy-on-touch of spine + scalar params for touched locks
  const ids = touched.slice(0, nTouched);
  const sp = new Float32Array(nTouched * P * 3), sc = new Float32Array(nTouched * 4);
  for (let k = 0; k < nTouched; k++) {
    const l = ids[k];
    sp.set(spine.subarray(l * P * 3, (l + 1) * P * 3), k * P * 3);
    sc[k * 4] = len[l]; sc[k * 4 + 1] = curlR[l]; sc[k * 4 + 2] = curlF[l]; sc[k * 4 + 3] = thick[l];
  }
  return sp.byteLength + sc.byteLength + ids.byteLength;
}

// ---------- timing ----------
function time(fn, reps) {
  const ts = [];
  for (let r = 0; r < reps; r++) { const t0 = performance.now(); fn(r); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b); return ts[Math.floor(ts.length / 2)];
}
const tEval = time(() => { for (let l = 0; l < N; l++) evalLock(l); }, 15);
const tMesh = time(() => { for (let l = 0; l < N; l++) meshLock(l); }, 15);
const centres = []; for (let i = 0; i < 64; i++) { const a = rand() * 6.28, y = 0.3 + rand() * 0.6, rr = Math.sqrt(1 - y * y); centres.push([rr * Math.cos(a) * 0.13, y * 0.11, rr * Math.sin(a) * 0.13]); }
const tQuery = time(r => { const c = centres[r % 64]; brushQuery(c[0], c[1], c[2], 0.03); }, 64);
let touchedAvg = 0, undoBytes = 0;
const tCut = time(r => { const c = centres[r % 64]; brushQuery(c[0], c[1], c[2], 0.03); touchedAvg += nTouched; undoBytes += snapshotTouched(); cutTouched(c[0], c[1], c[2], 0.03); }, 64);

const verts = N * E * S, tris = N * (E - 1) * S * 2;
console.log(JSON.stringify({
  N, P, E, S, verts, tris,
  gpuBytesPosNrm: (pos.byteLength + nrm.byteLength), indexBytes: index.byteLength,
  ms_evalAll: +tEval.toFixed(2), ms_meshAll: +tMesh.toFixed(2),
  ms_brushQuery: +tQuery.toFixed(3), ms_queryCutEvalMeshStroke: +tCut.toFixed(3),
  avgLocksTouchedPerDab_r3cm: Math.round(touchedAvg / 64), avgUndoBytesPerDab: Math.round(undoBytes / 64),
}));
