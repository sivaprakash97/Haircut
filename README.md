# Haircut Playground

A browser-based 3D hair sandbox. The hair is sculptable "clay": a volume you can cut, comb, grow, dye and reshape. It's rendered in a chunky, cel-shaded, Jet Set Radio–inspired style.

Status: **Milestone 1**. The scene is a procedural head with three starter hairstyles, adjustable quality and a speed test. Editing tools arrive in Milestone 2. The design and plan are in [`docs/technical-discovery.md`](docs/technical-discovery.md).

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

URL options, handy for sharing a setup:
- `?preset=quiff|spikes|afro`
- `&quality=light|standard|high`
- `&outline=0`, `&ao=0`, `&grain=1`

## Checks

```sh
npm run check      # typecheck + unit tests + production build + download-size budget
npm run e2e        # browser smoke tests with screenshots (Playwright, headless Chromium)
```

`npm run size` fails the build if the first-load download exceeds **300 KB** (Brotli). It is currently ~125 KB.

## How it works

| Part | Where |
|---|---|
| Hair and head volumes: a grid of distances, built near the surface only | `src/engine/grid.ts`, `src/engine/build.ts` |
| Starter hairstyles and the placeholder head, described as smooth shapes | `src/engine/presets.ts`, `src/engine/head.ts`, `src/engine/sdf.ts` |
| Surface Nets meshing per 8×8×8 brick, with baked ambient occlusion | `src/engine/surfaceNets.ts` |
| Web Worker that builds and meshes off the main thread | `src/engine/worker.ts` |
| Renderer: toon shading, outlines, render-on-demand, adaptive resolution, speed test | `src/render/` |
| UI (Preact) | `src/ui/` |

The engine (`src/engine/`) has no three.js or DOM dependencies, so it runs the same way in the worker and in the unit tests (`tests/`).
