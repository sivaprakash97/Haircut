// Throwaway feasibility benchmark for the "hair clay" volume representation.
// Not app code. Signed distance field on a dense grid, bricked Surface Nets meshing,
// brush dabs with local re-meshing, detached-chunk flood fill, and a sand "settle" pass.
// Units: metres. Head = ellipsoid at origin.

const argv = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const VS = +(argv.vs ?? 0.003);           // voxel size
const B = +(argv.brick ?? 16);             // brick size in cells
const X0 = -0.16, Y0 = -0.17, Z0 = -0.16;  // grid origin
const NX = Math.ceil(0.32 / VS) + 1, NY = Math.ceil(0.40 / VS) + 1, NZ = Math.ceil(0.32 / VS) + 1;
const N = NX * NY * NZ;
const field = new Float32Array(N);
const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3], EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
const CV = new Float32Array(8), Q = new Int32Array(4);
const CELLS = [[0,0,0, 0,-1,0, 0,-1,-1, 0,0,-1], [0,0,0, 0,0,-1, -1,0,-1, -1,0,0], [0,0,0, -1,0,0, -1,-1,0, 0,-1,0]];
        // hair SDF (negative = inside hair)
const at = (i, j, k) => i + NX * (j + NY * k);

// ---------- SDF helpers ----------
const ell = (x, y, z, rx, ry, rz) => { const k0 = Math.hypot(x / rx, y / ry, z / rz), k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz)); return k0 * (k0 - 1) / (k1 || 1e-9); };
const cap = (x, y, z, ax, ay, az, bx, by, bz, r) => { const px = x - ax, py = y - ay, pz = z - az, dx = bx - ax, dy = by - ay, dz = bz - az; const h = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz))); return Math.hypot(px - dx * h, py - dy * h, pz - dz * h) - r; };
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const head = (x, y, z) => ell(x, y, z, 0.078, 0.1, 0.092);

// initial hairstyle: helmet + quiff + 5 spikes + beard, minus head
function hairSDF(x, y, z) {
  let d = ell(x, y - 0.012, z + 0.004, 0.1, 0.118, 0.112);
  d = Math.max(d, -(y + 0.015) + 0.0 * x);                     // keep upper part
  d = smin(d, ell(x, y - 0.1, z - 0.06, 0.06, 0.04, 0.05), 0.03); // quiff
  for (let s = 0; s < 5; s++) { const a = -0.9 + s * 0.45; d = smin(d, cap(x, y, z, Math.sin(a) * 0.05, 0.09, -0.02 + Math.cos(a) * 0.02, Math.sin(a) * 0.12, 0.17, -0.08 + Math.cos(a) * 0.03, 0.012), 0.02); }
  const beard = Math.max(ell(x, y + 0.075, z - 0.035, 0.07, 0.06, 0.065), -(-(y + 0.04)));
  d = smin(d, beard, 0.01);
  return Math.max(d, -head(x, y, z) - 0.002);
}

// ---------- bricked Surface Nets ----------
const BX = Math.ceil((NX - 1) / B), BY = Math.ceil((NY - 1) / B), BZ = Math.ceil((NZ - 1) / B);
const brickTris = new Int32Array(BX * BY * BZ);
const cellVert = new Int32Array((B + 1) ** 3);
let outPos = new Float32Array(1 << 16), outNrm = new Float32Array(1 << 16), outIdx = new Uint32Array(1 << 17);
function meshBrick(bx, by, bz) {
  const si = bx * B, sj = by * B, sk = bz * B;
  const ei = Math.min(si + B, NX - 1), ej = Math.min(sj + B, NY - 1), ek = Math.min(sk + B, NZ - 1);
  const ci0 = Math.max(si - 1, 0), cj0 = Math.max(sj - 1, 0), ck0 = Math.max(sk - 1, 0);
  const W = B + 1;
  let nv = 0, ni = 0;
  for (let k = ck0; k < ek; k++) for (let j = cj0; j < ej; j++) for (let i = ci0; i < ei; i++) {
    const c = (i - ci0) + W * ((j - cj0) + W * (k - ck0));
    cellVert[c] = -1;
    // 8 corners
    let mask = 0; const v = CV;
    for (let n = 0; n < 8; n++) { const f = field[at(i + (n & 1), j + ((n >> 1) & 1), k + ((n >> 2) & 1))]; v[n] = f; if (f < 0) mask |= 1 << n; }
    if (mask === 0 || mask === 255) continue;
    // average of edge crossings
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (let e = 0; e < 12; e++) { const a = EA[e], b = EB[e];
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += (a & 1) + (((b & 1) - (a & 1)) * t); sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t); sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t); cnt++;
    }
    const px = X0 + (i + sx / cnt) * VS, py = Y0 + (j + sy / cnt) * VS, pz = Z0 + (k + sz / cnt) * VS;
    if (nv * 3 + 3 > outPos.length) { const g = new Float32Array(outPos.length * 2); g.set(outPos); outPos = g; const h = new Float32Array(outNrm.length * 2); h.set(outNrm); outNrm = h; }
    outPos[nv * 3] = px; outPos[nv * 3 + 1] = py; outPos[nv * 3 + 2] = pz;
    // normal from field gradient (central difference at cell corner)
    const gx = field[at(i + 1, j, k)] - field[at(i, j, k)] + field[at(i + 1, j + 1, k + 1)] - field[at(i, j + 1, k + 1)];
    const gy = field[at(i, j + 1, k)] - field[at(i, j, k)] + field[at(i + 1, j + 1, k + 1)] - field[at(i + 1, j, k + 1)];
    const gz = field[at(i, j, k + 1)] - field[at(i, j, k)] + field[at(i + 1, j + 1, k + 1)] - field[at(i + 1, j + 1, k)];
    const gl = Math.hypot(gx, gy, gz) || 1; outNrm[nv * 3] = gx / gl; outNrm[nv * 3 + 1] = gy / gl; outNrm[nv * 3 + 2] = gz / gl;
    cellVert[c] = nv++;
  }
  // quads for edges whose base corner lies in this brick
  for (let k = sk; k < ek; k++) for (let j = sj; j < ej; j++) for (let i = si; i < ei; i++) {
    const f0 = field[at(i, j, k)];
    for (let axis = 0; axis < 3; axis++) {
      const i1 = i + (axis === 0), j1 = j + (axis === 1), k1 = k + (axis === 2);
      if (i1 >= NX || j1 >= NY || k1 >= NZ) continue;
      const f1 = field[at(i1, j1, k1)];
      if ((f0 < 0) === (f1 < 0)) continue;
      // the 4 cells sharing this edge
      const cells = CELLS[axis]; const q = Q; let qn = 0;
      for (let m = 0; m < 4; m++) { const di = cells[m * 3], dj = cells[m * 3 + 1], dk = cells[m * 3 + 2];
        const ci = i + di, cj = j + dj, ck = k + dk;
        if (ci < ci0 || cj < cj0 || ck < ck0) { qn = -9; break; }
        const vi = cellVert[(ci - ci0) + W * ((cj - cj0) + W * (ck - ck0))];
        if (vi < 0) { qn = -9; break; }
        q[qn++] = vi;
      }
      if (qn !== 4) continue;
      if (ni + 6 > outIdx.length) { const g = new Uint32Array(outIdx.length * 2); g.set(outIdx); outIdx = g; }
      if (f0 < 0) { outIdx[ni++] = q[0]; outIdx[ni++] = q[1]; outIdx[ni++] = q[2]; outIdx[ni++] = q[0]; outIdx[ni++] = q[2]; outIdx[ni++] = q[3]; }
      else { outIdx[ni++] = q[0]; outIdx[ni++] = q[2]; outIdx[ni++] = q[1]; outIdx[ni++] = q[0]; outIdx[ni++] = q[3]; outIdx[ni++] = q[2]; }
    }
  }
  return ni / 3;
}

function meshBricksIn(i0, j0, k0, i1, j1, k1) {
  let tris = 0, bricks = 0;
  const b0x = Math.max(0, Math.floor((i0 - 1) / B)), b0y = Math.max(0, Math.floor((j0 - 1) / B)), b0z = Math.max(0, Math.floor((k0 - 1) / B));
  const b1x = Math.min(BX - 1, Math.floor((i1 + 1) / B)), b1y = Math.min(BY - 1, Math.floor((j1 + 1) / B)), b1z = Math.min(BZ - 1, Math.floor((k1 + 1) / B));
  for (let bz = b0z; bz <= b1z; bz++) for (let by = b0y; by <= b1y; by++) for (let bx = b0x; bx <= b1x; bx++) { const t = meshBrick(bx, by, bz); brickTris[bx + BX * (by + BY * bz)] = t; tris += t; bricks++; }
  return { tris, bricks };
}

// ---------- brush: subtract / add sphere ----------
function dab(cx, cy, cz, r, add) {
  const i0 = Math.max(0, Math.floor((cx - r - X0) / VS) - 1), i1 = Math.min(NX - 1, Math.ceil((cx + r - X0) / VS) + 1);
  const j0 = Math.max(0, Math.floor((cy - r - Y0) / VS) - 1), j1 = Math.min(NY - 1, Math.ceil((cy + r - Y0) / VS) + 1);
  const k0 = Math.max(0, Math.floor((cz - r - Z0) / VS) - 1), k1 = Math.min(NZ - 1, Math.ceil((cz + r - Z0) / VS) + 1);
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = X0 + i * VS, y = Y0 + j * VS, z = Z0 + k * VS;
    const s = Math.hypot(x - cx, y - cy, z - cz) - r, o = at(i, j, k);
    field[o] = add ? Math.max(smin(field[o], s, 0.006), -head(x, y, z) - 0.002) : Math.max(field[o], -s);
  }
  return meshBricksIn(i0, j0, k0, i1, j1, k1);
}

// ---------- detached chunks: flood fill from material touching the scalp ----------
const seen = new Uint8Array(N); const stack = new Int32Array(N);
function floodFromScalp() {
  seen.fill(0); let sp = 0, reached = 0, solid = 0;
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const o = at(i, j, k); if (field[o] >= 0) continue; solid++;
    if (head(X0 + i * VS, Y0 + j * VS, Z0 + k * VS) < VS * 1.5) { seen[o] = 1; stack[sp++] = o; }
  }
  while (sp > 0) {
    const o = stack[--sp]; reached++;
    const i = o % NX, j = ((o / NX) | 0) % NY, k = (o / (NX * NY)) | 0;
    const nb = [i > 0 ? o - 1 : -1, i < NX - 1 ? o + 1 : -1, j > 0 ? o - NX : -1, j < NY - 1 ? o + NX : -1, k > 0 ? o - NX * NY : -1, k < NZ - 1 ? o + NX * NY : -1];
    for (const n of nb) if (n >= 0 && !seen[n] && field[n] < 0) { seen[n] = 1; stack[sp++] = n; }
  }
  return { solid, reached, detached: solid - reached };
}

// ---------- kinetic-sand settle: unsupported material slides down/outward in a local box ----------
function settle(cx, cy, cz, r, iters) {
  const i0 = Math.max(1, Math.floor((cx - r - X0) / VS)), i1 = Math.min(NX - 2, Math.ceil((cx + r - X0) / VS));
  const j0 = Math.max(1, Math.floor((cy - r - Y0) / VS)), j1 = Math.min(NY - 2, Math.ceil((cy + r - Y0) / VS));
  const k0 = Math.max(1, Math.floor((cz - r - Z0) / VS)), k1 = Math.min(NZ - 2, Math.ceil((cz + r - Z0) / VS));
  let moved = 0;
  for (let it = 0; it < iters; it++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
    const o = at(i, j, k); if (field[o] >= 0) continue;
    const below = o - NX; if (field[below] < 0) continue;
    if (head(X0 + i * VS, Y0 + (j - 1) * VS, Z0 + k * VS) < 0) continue; // resting on the scalp
    const t = field[o]; field[o] = field[below]; field[below] = t; moved++;
  }
  return moved;
}

// ---------- timing ----------
const med = (fn, reps) => { const ts = []; let last; for (let r = 0; r < reps; r++) { const t0 = performance.now(); last = fn(r); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return [ts[Math.floor(ts.length / 2)], last]; };

const [tBuild] = med(() => { const C = 4, R = VS * C * 0.87 + VS;
  for (let kb = 0; kb < NZ; kb += C) for (let jb = 0; jb < NY; jb += C) for (let ib = 0; ib < NX; ib += C) {
    const d = hairSDF(X0 + (ib + C / 2) * VS, Y0 + (jb + C / 2) * VS, Z0 + (kb + C / 2) * VS);
    const far = Math.abs(d) > R;
    for (let k = kb; k < Math.min(kb + C, NZ); k++) for (let j = jb; j < Math.min(jb + C, NY); j++) for (let i = ib; i < Math.min(ib + C, NX); i++)
      field[at(i, j, k)] = far ? (d > 0 ? R : -R) : hairSDF(X0 + i * VS, Y0 + j * VS, Z0 + k * VS);
  } }, 3);
const [tMeshAll, all] = med(() => meshBricksIn(0, 0, 0, NX - 1, NY - 1, NZ - 1), 3);
// dab centres on the hair surface (top/sides)
const rnd = (() => { let s = 7; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const centres = []; for (let n = 0; n < 48; n++) { const a = rnd() * 6.28, e = 0.2 + rnd() * 1.1; centres.push([Math.cos(a) * Math.cos(e) * 0.11, 0.012 + Math.sin(e) * 0.12, Math.sin(a) * Math.cos(e) * 0.11]); }
let bricksPerDab = 0;
const [tCut] = med(r => { const c = centres[r % 48]; const res = dab(c[0], c[1], c[2], 0.02, false); bricksPerDab += res.bricks; return res; }, 48);
const [tAdd] = med(r => { const c = centres[r % 48]; return dab(c[0], c[1], c[2], 0.02, true); }, 48);
const [tFlood, fl] = med(() => floodFromScalp(), 3);
const [tSettle] = med(r => { const c = centres[r % 48]; return settle(c[0], c[1], c[2], 0.03, 4); }, 16);
const final = meshBricksIn(0, 0, 0, NX - 1, NY - 1, NZ - 1);

console.log(JSON.stringify({
  voxel_mm: VS * 1000, grid: `${NX}x${NY}x${NZ}`, voxels_M: +(N / 1e6).toFixed(2),
  fieldMB_f32: +(N * 4 / 1048576).toFixed(1), fieldMB_int8: +(N / 1048576).toFixed(1),
  ms_buildInitialStyle: +tBuild.toFixed(1), ms_meshWholeHead: +tMeshAll.toFixed(1), tris_wholeHead: all.tris, tris_afterEdits: final.tris,
  ms_cutDab_r2cm_incl_remesh: +tCut.toFixed(2), ms_addDab_r2cm_incl_remesh: +tAdd.toFixed(2), bricksRemeshedPerDab: Math.round(bricksPerDab / 48),
  ms_floodFillDetached: +tFlood.toFixed(1), ms_settle4iters_r3cm: +tSettle.toFixed(2),
}));
