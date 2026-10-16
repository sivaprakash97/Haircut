# Haircut Playground

A browser-based 3D hair sandbox. The hair is sculptable "clay": a volume you can cut, comb, grow, dye and reshape. It's rendered in a chunky, cel-shaded, Jet Set Radio–inspired style.

Status: **Milestone 2.** Drag tools across the hair to cut, comb, grow, extrude, gel and dry it, with undo, redo and reset. Design and plan: [`docs/technical-discovery.md`](docs/technical-discovery.md). Progress reports: [`docs/m1-report.md`](docs/m1-report.md), [`docs/m2-report.md`](docs/m2-report.md).

## Using it

| Key | Tool | |
|---|---|---|
| 1 | Rotate | Turn the head (also: right-drag, or drag on empty space with any tool) |
| 2 | Scissors | Swipe across hair; loose pieces fall away |
| 3 | Comb | Push the clay along your stroke |
| 4 | Grow | Build hair up, even on bare scalp |
| 5 | Extrude | Press and pull out a spike |
| 6 | Gel | Hair holds its shape and shines |
| 7 | Dryer | Hair loosens, sags and goes matte |

`[` `]` brush size · `M` mirror left/right · Ctrl/⌘+Z undo · Shift+Ctrl/⌘+Z redo

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

URL options, handy for sharing a setup:
- `?preset=quiff|spikes|afro`
- `&quality=light|standard|high`
- `&tool=view|scissors|comb|grow|extrude|gel|dryer`
- `&mirror=1`, `&outline=0`, `&ao=0`, `&grain=1`

## Checks

```sh
npm run check      # typecheck + unit tests + production build + download-size budget
npm run e2e        # browser smoke tests with screenshots (Playwright, headless Chromium)
```

`npm run size` fails the build if the first-load download exceeds **300 KB** (Brotli). It is currently ~135 KB.

## How it works

| Part | Where |
|---|---|
| Hair and head volumes: a grid of distances, built near the surface only | `src/engine/grid.ts`, `src/engine/build.ts` |
| Starter hairstyles and the placeholder head, described as smooth shapes | `src/engine/presets.ts`, `src/engine/head.ts`, `src/engine/sdf.ts` |
| Surface Nets meshing per 8×8×8 brick, with baked ambient occlusion | `src/engine/surfaceNets.ts` |
| Editing: stroke transactions, undo/redo/reset, dirty-brick tracking | `src/engine/edit.ts` |
| Tools (scissors slice, comb, grow, extrude, gel, dryer), picking, cut-off pieces | `src/engine/tools.ts`, `src/engine/pick.ts`, `src/engine/detach.ts` |
| Web Worker that owns the hair and applies strokes off the main thread | `src/engine/worker.ts` |
| Pointer input: tool vs. rotate, one stroke update per frame | `src/app/brush.ts`, `src/app/engine.ts` |
| Renderer: incremental hair chunks, toon shading (gel gloss, dry grain), outlines, falling pieces, brush cursor, speed test | `src/render/` |
| UI (Preact) | `src/ui/` |

The engine (`src/engine/`) has no three.js or DOM dependencies, so it runs the same way in the worker and in the unit tests (`tests/`).
