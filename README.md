# Haircut Playground

A browser-based 3D salon toy. You start with an overgrown head of hair and a full beard, made of chunky cartoon locks that hang, swing and settle, and you cut, buzz, comb, grow and pull them into a style. It's cel-shaded and outlined, in a Jet Set Radio–inspired look.

Status: **Milestone 3.** Design and plan: [`docs/technical-discovery.md`](docs/technical-discovery.md) (Revision 3: hair locks). Progress reports: [`docs/m3-report.md`](docs/m3-report.md) (current), [`docs/m1-report.md`](docs/m1-report.md) and [`docs/m2-report.md`](docs/m2-report.md) (the earlier hair-clay prototype).

## Using it

| Key | Tool | |
|---|---|---|
| 1 | Rotate | Spin the chair (also: right-drag, or drag on empty space with any tool) |
| 2 | Scissors | Swipe across locks to snip them; the ends fall |
| 3 | Clippers | Buzz hair down to the guard length (0 = shave) |
| 4 | Comb | Drag hair the way you want it to lie |
| 5 | Grow | Hold to grow hair longer, also on bare scalp |
| 6 | Extrude | Grab and pull hair out; it stays (spikes, flicks) |

`[` `]` brush size · `M` mirror left/right · Ctrl/⌘+Z undo · Shift+Ctrl/⌘+Z redo

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

URL options, handy for sharing a setup:
- `?quality=light|standard|high`
- `&tool=view|scissors|clippers|comb|grow|extrude`
- `&mirror=1`, `&outline=0`, `&ao=0`
- `&yaw=0`: start facing the camera (radians)

## Checks

```sh
npm run check      # typecheck + unit tests + production build + download-size budget
npm run e2e        # browser tests with screenshots (Playwright, headless Chromium)
npx vitest run --config research/bench/vitest.config.ts --silent=false   # tool and physics timings
```

`npm run size` fails the build if the first-load download exceeds **300 KB** (Brotli). It is currently ~136 KB.

## How it works

| Part | Where |
|---|---|
| Lock data, collision body, starting hair (roots, overgrown drape) and where hair grows | `src/hair/locks.ts`, `body.ts`, `generate.ts`, `regions.ts` |
| Physics: inextensible chains with gravity, styled rest shape, hold stiffness, collisions, sleep | `src/hair/sim.ts` |
| Tools, picking, cut-off pieces, undo/redo/reset | `src/hair/session.ts`, `debris.ts`, `history.ts` |
| Head mesh and collision grid (signed distances + Surface Nets), built in two Web Workers | `src/engine/` |
| Pointer input: tool vs. spinning the chair, one stroke update per frame | `src/app/input.ts` |
| Renderer: locks as tapered tubes built on the GPU from a node texture, toon shading, outlines, turntable | `src/render/` |
| UI (Preact) | `src/ui/` |

`src/hair/` and `src/engine/` have no three.js or DOM dependencies, so the same code runs in the page, the workers and the unit tests (`tests/`).
