import { buildField } from './build';
import { removeDetached } from './detach';
import { Editor } from './edit';
import { Field } from './grid';
import { HEAD_BOUNDS, headSDF, sampleHead } from './head';
import { type Hit, type Ray, raycast } from './pick';
import { HAIR_BOUNDS, PRESETS } from './presets';
import {
  type BuildRequest, type EditResult, type FromWorker, type HistoryRequest, type HitInfo, type MeshPayload,
  type StrokeRequest, type ToWorker, type ToolId, payloadTransfers,
} from './protocol';
import { type MeshBatch, type MeshOptions, meshBricks } from './surfaceNets';
import { type DistFn, type Pull, type Vec3, cutSlice, extrude, grow, paintHold, slump, smudge } from './tools';

// Runs off the main thread. Owns the hair volume, applies tool strokes to it,
// keeps undo history, and sends back meshes for the bricks that changed.

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** Same options for the first build and every re-mesh, so partial updates match a full rebuild. */
const HAIR_MESH: MeshOptions = { ao: 1.25, occluder: headSDF };

interface Session {
  hair: Field;
  head: Field;
  editor: Editor;
  /** Colour for hair grown on bare scalp (RGB565). */
  base: number;
  headDist: DistFn;
}

interface Stroke {
  tool: ToolId;
  prevRay: Ray | null;
  prevHit: Hit | null;
  pulls: Pull[] | null;
  /** Plane the extrude tip moves in (through the anchor, facing the camera). */
  plane: { p: Vec3; n: Vec3 } | null;
}

let session: Session | null = null;
let stroke: Stroke | null = null;

scope.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'build':
        return build(msg);
      case 'pick':
        return scope.postMessage({ type: 'picked', id: msg.id, hit: session ? info(raycast(session.hair, session.head, msg.ray)) : null }, []);
      case 'stroke':
        return onStroke(msg);
      case 'history':
        return onHistory(msg);
      case 'debug':
        return scope.postMessage({ type: 'debug', id: msg.id, ...checksum() }, []);
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) }, []);
  }
};

function build(req: BuildRequest): void {
  const preset = PRESETS[req.preset];
  stroke = null;

  let t = performance.now();
  const hair = new Field(HAIR_BOUNDS, req.cell);
  buildField(hair, preset.sample, preset.lipschitz);
  const fieldMs = performance.now() - t;

  t = performance.now();
  const hairMesh = meshBricks(hair, undefined, HAIR_MESH);
  const meshMs = performance.now() - t;

  t = performance.now();
  const head = new Field(HEAD_BOUNDS, req.cell);
  buildField(head, sampleHead, 1.2);
  // Self-occlusion only: shading from the hair would go stale as soon as the hair is edited.
  const headMesh = meshBricks(head, undefined, { ao: 1.1 });
  const headMs = performance.now() - t;

  session = { hair, head, editor: new Editor(hair), base: preset.base, headDist: (x, y, z) => head.sampleWorld(x, y, z) };
  const hairPayload = payload(hairMesh, hair), headPayload = payload(headMesh, head);
  scope.postMessage(
    {
      type: 'built', id: req.id, preset: req.preset, cell: req.cell,
      hair: hairPayload, head: headPayload,
      stats: { cells: hair.cellCount, fieldMs, meshMs, headMs },
      history: { undo: 0, redo: 0 },
    },
    [...payloadTransfers(hairPayload), ...payloadTransfers(headPayload)],
  );
}

function onStroke(msg: StrokeRequest): void {
  const t0 = performance.now();
  const s = session;
  if (!s) return reply(msg.id, t0, null, []);
  if (msg.phase === 'begin') {
    if (s.editor.inStroke) s.editor.commit();
    s.editor.begin();
    stroke = { tool: msg.tool, prevRay: null, prevHit: null, pulls: null, plane: null };
  }
  const st = stroke;
  const hit = raycast(s.hair, s.head, msg.ray);
  const debris: MeshPayload[] = [];
  if (st) {
    applyTool(s, st, msg, hit);
    if (msg.phase === 'end') {
      if (st.tool === 'scissors') {
        const piece = removeDetached(s.editor, s.headDist);
        if (piece) debris.push(payload(piece, s.hair));
      }
      s.editor.commit();
      stroke = null;
    }
  }
  reply(msg.id, t0, hit, debris);
}

const mirrorV = (v: readonly number[]): Vec3 => [-v[0], v[1], v[2]];

function applyTool(s: Session, st: Stroke, msg: StrokeRequest, hit: Hit | null): void {
  const ed = s.editor, head = s.headDist;
  const r = msg.radius, strength = msg.strength;
  const dt = Math.min(Math.max(msg.dt, 0.001), 0.05);
  // Mirror unless the brush already straddles the centre line.
  const mirrored = (p: readonly number[]) => msg.mirror && Math.abs(p[0]) > r * 0.35;

  switch (st.tool) {
    case 'grow': {
      if (!hit) break;
      const col = colorAt(s, hit), amount = 0.05 * strength * dt;
      grow(ed, head, hit.p, hit.n, r, amount, col);
      if (mirrored(hit.p)) grow(ed, head, mirrorV(hit.p), mirrorV(hit.n), r, amount, col);
      break;
    }
    case 'comb': {
      if (hit && hit.surface === 'hair' && st.prevHit) {
        const p = st.prevHit.p;
        const delta: Vec3 = [hit.p[0] - p[0], hit.p[1] - p[1], hit.p[2] - p[2]];
        // Ignore jumps across gaps (e.g. sliding off one lock onto another).
        if (Math.hypot(...delta) < r * 1.5) {
          smudge(ed, head, p, delta, r, strength);
          if (mirrored(p)) smudge(ed, head, mirrorV(p), mirrorV(delta), r, strength);
        }
      }
      if (hit) st.prevHit = hit;
      break;
    }
    case 'gel':
    case 'dryer': {
      if (!hit || hit.surface !== 'hair') break;
      const delta = (st.tool === 'gel' ? 1 : -1) * 255 * 3 * strength * dt;
      const centres: Vec3[] = [hit.p];
      if (mirrored(hit.p)) centres.push(mirrorV(hit.p));
      for (const c of centres) {
        paintHold(ed, c, r, delta);
        if (st.tool === 'dryer') slump(ed, head, c, r, dt);
      }
      break;
    }
    case 'extrude': {
      if (msg.phase === 'begin') {
        if (!hit) break;
        const col = colorAt(s, hit);
        st.pulls = [{ a: hit.p, n: hit.n, color: col, b: hit.p }];
        if (mirrored(hit.p)) st.pulls.push({ a: mirrorV(hit.p), n: mirrorV(hit.n), color: col, b: mirrorV(hit.p) });
        st.plane = { p: hit.p, n: [msg.ray[3], msg.ray[4], msg.ray[5]] };
        break;
      }
      if (!st.pulls || !st.plane) break;
      const tip = intersectPlane(msg.ray, st.plane.p, st.plane.n);
      if (!tip) break;
      st.pulls[0].b = tip;
      if (st.pulls[1]) st.pulls[1].b = mirrorV(tip);
      extrude(ed, head, st.pulls, r);
      break;
    }
    case 'scissors': {
      const prev = st.prevRay;
      if (!prev) {
        st.prevRay = msg.ray;
        st.prevHit = hit;
        break;
      }
      const d0: Vec3 = [prev[3], prev[4], prev[5]], d1: Vec3 = [msg.ray[3], msg.ray[4], msg.ray[5]];
      const angle = Math.hypot(d1[0] - d0[0], d1[1] - d0[1], d1[2] - d0[2]);
      if (angle * 0.5 < 0.0008) break; // wait until the blade has moved far enough to make a clean slice
      // A fast swipe covers a wide wedge; slice it in thin pieces so each gets its own depth range.
      const n = Math.max(1, Math.ceil(angle / 0.005));
      let pr: Ray = prev, ph = st.prevHit;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const dx = d0[0] + (d1[0] - d0[0]) * t, dy = d0[1] + (d1[1] - d0[1]) * t, dz = d0[2] + (d1[2] - d0[2]) * t;
        const l = Math.hypot(dx, dy, dz);
        const rk: Ray = k === n ? msg.ray : [msg.ray[0], msg.ray[1], msg.ray[2], dx / l, dy / l, dz / l];
        const hk = k === n ? hit : raycast(s.hair, s.head, rk);
        cutBetween(s, pr, ph, rk, hk, msg.mirror);
        pr = rk;
        ph = hk;
      }
      st.prevRay = msg.ray;
      st.prevHit = hit;
      break;
    }
  }
}

/**
 * One scissor slice between two view rays. Like real scissors it cuts through
 * all the hair along the rays, but stops at the scalp.
 */
function cutBetween(s: Session, r0: Ray, h0: Hit | null, r1: Ray, h1: Hit | null, mirror: boolean): void {
  if (!h0 && !h1) return; // swiping through empty space
  const tn = Math.min(h0?.t ?? Infinity, h1?.t ?? Infinity) - 0.012;
  const tf = Math.max(h0 ? hairExit(s, r0, h0.t) : 0, h1 ? hairExit(s, r1, h1.t) : 0) + 0.008;
  const o: Vec3 = [r1[0], r1[1], r1[2]];
  const d0: Vec3 = [r0[3], r0[4], r0[5]], d1: Vec3 = [r1[3], r1[4], r1[5]];
  cutSlice(s.editor, o, d0, d1, tn, tf);
  if (mirror) cutSlice(s.editor, mirrorV(o), mirrorV(d0), mirrorV(d1), tn, tf);
}

function onHistory(msg: HistoryRequest): void {
  const t0 = performance.now();
  const s = session;
  if (s) {
    if (s.editor.inStroke) {
      s.editor.commit();
      stroke = null;
    }
    if (msg.action === 'undo') s.editor.undo();
    else if (msg.action === 'redo') s.editor.redo();
    else s.editor.reset();
  }
  reply(msg.id, t0, null, []);
}

/** Re-meshes whatever changed and sends it back with the hit and history state. */
function reply(id: number, t0: number, hit: Hit | null, debris: MeshPayload[]): void {
  const s = session;
  let hair: MeshPayload | null = null, replaceAll = false;
  if (s) {
    const dirty = s.editor.takeDirty();
    if (dirty === 'all') {
      hair = payload(meshBricks(s.hair, undefined, HAIR_MESH), s.hair);
      replaceAll = true;
    } else if (dirty.length) {
      hair = payload(meshBricks(s.hair, dirty, { ...HAIR_MESH, includeEmpty: true }), s.hair);
    }
  }
  const result: EditResult = {
    type: 'edited', id, hair, replaceAll, hit: info(hit), debris,
    history: { undo: s?.editor.undoCount ?? 0, redo: s?.editor.redoCount ?? 0 },
    ms: performance.now() - t0,
  };
  const transfers = [...(hair ? payloadTransfers(hair) : []), ...debris.flatMap(payloadTransfers)];
  scope.postMessage(result, transfers);
}

/** Material colour just under a hit (or the hairstyle's base colour on bare scalp). */
function colorAt(s: Session, hit: Hit): number {
  const f = s.hair;
  if (hit.surface === 'hair') {
    for (const depth of [1.2, 2.5, 4]) {
      const x = hit.p[0] - hit.n[0] * depth * f.cell, y = hit.p[1] - hit.n[1] * depth * f.cell, z = hit.p[2] - hit.n[2] * depth * f.cell;
      const i = Math.round((x - f.ox) / f.cell), j = Math.round((y - f.oy) / f.cell), k = Math.round((z - f.oz) / f.cell);
      if (i < 0 || j < 0 || k < 0 || i >= f.nx || j >= f.ny || k >= f.nz) continue;
      const o = f.idx(i, j, k);
      if (f.shape[o] < 0) return f.color[o];
    }
  }
  return s.base;
}

/** How far along `ray` (from depth t0) there is still hair before the ray reaches the head. */
function hairExit(s: Session, ray: Ray, t0: number): number {
  const step = s.hair.cell * 0.5;
  let last = t0;
  for (let t = t0; t < t0 + 0.35; t += step) {
    const x = ray[0] + ray[3] * t, y = ray[1] + ray[4] * t, z = ray[2] + ray[5] * t;
    if (s.head.sampleWorld(x, y, z) < 0) break;
    if (s.hair.sampleWorld(x, y, z) < 0) last = t;
  }
  return last;
}

function intersectPlane(ray: Ray, p: Vec3, n: Vec3): Vec3 | null {
  const denom = ray[3] * n[0] + ray[4] * n[1] + ray[5] * n[2];
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((p[0] - ray[0]) * n[0] + (p[1] - ray[1]) * n[1] + (p[2] - ray[2]) * n[2]) / denom;
  return t > 0 ? [ray[0] + ray[3] * t, ray[1] + ray[4] * t, ray[2] + ray[5] * t] : null;
}

function info(hit: Hit | null): HitInfo | null {
  return hit ? { p: hit.p, n: hit.n, surface: hit.surface } : null;
}

function payload(batch: MeshBatch, f: Field): MeshPayload {
  return { ...batch, brickDims: [f.bx, f.by, f.bz] };
}

function checksum(): { checksum: number; insideCells: number } {
  const f = session?.hair;
  if (!f) return { checksum: 0, insideCells: 0 };
  let h = 2166136261, inside = 0;
  for (let i = 0; i < f.shape.length; i++) {
    h = Math.imul(h ^ (f.shape[i] & 255), 16777619);
    h = Math.imul(h ^ f.color[i], 16777619);
    h = Math.imul(h ^ f.hold[i], 16777619);
    if (f.shape[i] < 0) inside++;
  }
  return { checksum: h >>> 0, insideCells: inside };
}
