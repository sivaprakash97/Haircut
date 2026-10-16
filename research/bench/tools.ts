// Per-frame worker cost of each tool at a given cell size: the tool operation plus
// re-meshing the bricks it changed. Run: npx esbuild research/bench/tools.ts --bundle
// --platform=node --format=esm --outfile=/tmp/x.mjs && node /tmp/x.mjs 0.003
import { buildField } from '../../src/engine/build';
import { removeDetached } from '../../src/engine/detach';
import { Editor } from '../../src/engine/edit';
import { Field } from '../../src/engine/grid';
import { HEAD_BOUNDS, headSDF, sampleHead } from '../../src/engine/head';
import { raycast } from '../../src/engine/pick';
import { HAIR_BOUNDS, PRESETS } from '../../src/engine/presets';
import { meshBricks } from '../../src/engine/surfaceNets';
import { type Vec3, cutSlice, extrude, grow, paintHold, slump, smudge } from '../../src/engine/tools';

const cell = Number(process.argv[2] ?? 0.003);
const r = 0.02; // 2 cm brush
const head = new Field(HEAD_BOUNDS, cell);
buildField(head, sampleHead, 1.2);
const hd = (x: number, y: number, z: number) => head.sampleWorld(x, y, z);
const fresh = () => {
  const f = new Field(HAIR_BOUNDS, cell);
  buildField(f, PRESETS.quiff.sample, PRESETS.quiff.lipschitz);
  return new Editor(f);
};
const remesh = (ed: Editor) => {
  const d = ed.takeDirty();
  return d === 'all' ? meshBricks(ed.field) : meshBricks(ed.field, d, { ao: 1.25, occluder: headSDF, includeEmpty: true });
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function frames(name: string, n: number, step: (ed: Editor, i: number) => void, end?: (ed: Editor) => void) {
  const ed = fresh();
  ed.begin();
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    step(ed, i);
    remesh(ed);
    times.push(performance.now() - t);
  }
  let endMs = 0;
  if (end) {
    const t = performance.now();
    end(ed);
    endMs = performance.now() - t;
  } else {
    const t = performance.now();
    ed.commit();
    remesh(ed);
    endMs = performance.now() - t;
  }
  const t = performance.now();
  ed.undo();
  remesh(ed);
  const undoMs = performance.now() - t;
  console.log(`${name.padEnd(9)} per frame median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms | stroke end ${endMs.toFixed(1)} ms | undo ${undoMs.toFixed(1)} ms`);
}

const side = raycast(fresh().field, head, [0.6, 0.11, 0.02, -1, 0, 0])!;
const top = raycast(fresh().field, head, [0, 0.5, 0.02, 0, -1, 0])!;
const along = (i: number): Vec3 => [side.p[0], side.p[1], side.p[2] + i * 0.002];

frames('grow', 60, (ed) => grow(ed, hd, top.p, top.n, r, 0.0008, 0x1234));
frames('comb', 60, (ed, i) => smudge(ed, hd, along(i), [0, 0, 0.002], r, 0.7));
frames('gel', 60, (ed) => paintHold(ed, top.p, r, 12));
frames('dryer', 60, (ed) => { paintHold(ed, top.p, r, -12); slump(ed, hd, top.p, r, 1 / 60); });
frames('extrude', 60, (ed, i) => {
  const b: Vec3 = [top.p[0], top.p[1] + 0.01 + i * 0.0015, top.p[2] + i * 0.0008];
  extrude(ed, hd, [{ a: top.p, n: top.n, color: 0x1234, b }], r);
});
const O: Vec3 = [0, 0.11, 0.6];
const dir = (x: number): Vec3 => { const d = [x - O[0], 0.11 - O[1], 0.0 - O[2]], l = Math.hypot(...d); return [d[0] / l, d[1] / l, d[2] / l]; };
frames('scissors', 30, (ed, i) => cutSlice(ed, O, dir(-0.08 + i * 0.0055), dir(-0.08 + (i + 1) * 0.0055), 0.5, 0.57),
  (ed) => { const t = performance.now(); removeDetached(ed, hd); const detach = performance.now() - t; ed.commit(); remesh(ed); console.log(`          (detach flood fill + debris mesh ${detach.toFixed(1)} ms)`); });
