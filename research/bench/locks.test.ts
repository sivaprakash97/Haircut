// Per-update cost of each lock tool and of one physics step (Node, no rendering).
// Run: npx vitest run --config research/bench/vitest.config.ts --silent=false
import { it } from 'vitest';
import { buildBodyGrid } from '../../src/engine/bodyGrid';
import { Body } from '../../src/hair/body';
import { generateLocks } from '../../src/hair/generate';
import { NODES, lastNode } from '../../src/hair/locks';
import { HairSession, type Ray, type ToolId } from '../../src/hair/session';
import { STEP } from '../../src/hair/sim';

const EYE = [0, 0.05, 0.9];
const rayTo = (p: number[]): Ray => {
  const d = [p[0] - EYE[0], p[1] - EYE[1], p[2] - EYE[2]], l = Math.hypot(d[0], d[1], d[2]);
  return [EYE[0], EYE[1], EYE[2], d[0] / l, d[1] / l, d[2] / l];
};

it('lock tool and physics costs', () => {
  let t = performance.now();
  const body = new Body(buildBodyGrid());
  const bodyMs = performance.now() - t;
  t = performance.now();
  const L = generateLocks(body);
  const genMs = performance.now() - t;
  let nodes = 0;
  for (let i = 0; i < L.count; i++) nodes += lastNode(L.len[i]) + 1;
  const rows: string[] = [`body grid ${bodyMs.toFixed(0)} ms, starting hair ${genMs.toFixed(0)} ms (${L.count} locks, ${nodes} active nodes of ${L.count * NODES})`];

  const s = new HairSession(L, body);
  // Physics while the head turns (everything awake).
  const steps = 300;
  t = performance.now();
  for (let k = 0; k < steps; k++) {
    s.sim.setYaw(Math.sin(k * 0.05));
    s.step();
  }
  rows.push(`physics step (all hair moving): ${((performance.now() - t) / steps).toFixed(2)} ms`);

  t = performance.now();
  for (let k = 0; k < 200; k++) s.pick(rayTo([0.03, 0.06, 0.1]));
  rows.push(`pick (hair + skin): ${((performance.now() - t) / 200).toFixed(3)} ms`);

  const tools: [ToolId, number[][]][] = [
    ['scissors', [[-0.12, 0.0, 0.12], [0.12, 0.0, 0.12]]],
    ['clippers', [[0.04, 0.1, 0.07], [0.05, 0.08, 0.07]]],
    ['comb', [[0, 0.07, 0.115], [0, 0.135, 0.02]]],
    ['grow', [[0.06, 0.04, 0.09], [0.062, 0.04, 0.09]]],
    ['extrude', [[0.03, 0.11, 0.05], [0.05, 0.2, 0.05]]],
  ];
  for (const [tool, [a, b]] of tools) {
    const n = 30;
    let worst = 0, total = 0;
    for (let k = 0; k <= n; k++) {
      const p = [0, 1, 2].map((c) => a[c] + ((b[c] - a[c]) * k) / n);
      const t0 = performance.now();
      s.strokeStep({ phase: k === 0 ? 'begin' : k === n ? 'end' : 'move', tool, ray: rayTo(p), radius: 0.02, strength: 0.6, mirror: true, dt: STEP, guard: 0.006 });
      const ms = performance.now() - t0;
      total += ms;
      worst = Math.max(worst, ms);
      s.step();
    }
    rows.push(`${tool}: ${(total / (n + 1)).toFixed(2)} ms average, ${worst.toFixed(2)} ms worst per update (mirror on)`);
  }
  t = performance.now();
  while (s.undo());
  rows.push(`undo everything: ${(performance.now() - t).toFixed(1)} ms`);
  console.log(rows.join('\n'));
});
