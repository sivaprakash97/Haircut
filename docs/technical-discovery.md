# Haircut Playground — Technical Discovery & Architecture Recommendation

Status: **Revision 2, approved.** Hair is "hair clay", sandcastle-style. Milestones 1 and 2 are built; see [`m1-report.md`](m1-report.md) and [`m2-report.md`](m2-report.md).
Date: 2026-10-15

Revision history
- **R1:** recommended a "lock field": hair as 1,500–3,000 guide curves meshed as tubes. Shelved, because it needs 0.2–0.7 M hair triangles, which is too heavy for mid-range laptops, and because it doesn't feel like clay or sand. It is summarized in §2.2.
- **R2 (this document):** hair is a sculptable volume of "clay" that behaves like a sandcastle or kinetic sand. Adds a loading-time and page-weight budget.

---

## 0. TL;DR

- **Stack (approved):** TypeScript + Vite + three.js r186 (WebGL 2). One change is recommended: **Preact instead of React** for the UI. It has the same API and is 5 KB instead of 58 KB compressed (measured).
- **Hair representation: "hair clay".** Hair is a block of virtual clay or sand stored in a 3D grid around the head, at 2.5–4 mm per cell. Every tool adds, removes, moves or paints that material. A fast meshing algorithm (Surface Nets) turns the grid into a smooth surface, and only the small pieces near the brush are rebuilt.
- **Sandcastle / kinetic-sand behaviour** comes from one per-cell "hold" value:
  - **Default (packed):** material holds sculpted shapes like a sandcastle or clay. Carving and cutting leave crisp edges and shed a few crumbs.
  - **Low hold:** overhangs that are too thin or stick out too far crumble and slump.
  - **Cutting through a lock:** the cut-off piece breaks away and falls.
- **Lightweight by design:**
  - **GPU:** 45k–125k triangles for the hair, and the scene only redraws when something changes.
  - **CPU:** 1.2–2.9 ms per brush touch, measured.
  - **First download:** about **200–250 KB compressed** in total. Nothing large is downloaded: the starter head and hairstyles are generated on the device.
- **Main trade-off:** nothing thinner than about two grid cells (~6 mm) can exist. You get chunky, sculpted, claymation-style hair, not fine strands. That matches the Jet Set Radio / clay brief, but the look test in M1 must confirm it.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Language / build | TypeScript + Vite | Code splitting and hashed, long-cached assets out of the box. |
| Rendering | three.js r186, `WebGLRenderer` (WebGL 2) | Partial GPU buffer and texture uploads (`addUpdateRange`) suit rebuilding only the bricks a brush touched. |
| Hair engine | Custom TypeScript, no framework, runs in a **Web Worker** | The grid, meshing, settling and flood fill run off the main thread, so the UI never stutters. The same code runs in Node for tests and benchmarks. |
| UI | **Preact** + signals/hooks, as a DOM overlay | Same API as React for AI coding tools: 5 KB vs 58 KB. |
| Camera | three's `OrbitControls` | Mouse and touch. |
| Spatial helpers | three-mesh-bvh, **loaded only when importing a custom head** | ~12 KB extra. Not needed for the built-in head. |
| Persistence | IndexedDB + `CompressionStream('gzip')` | Autosave and `.haircut` files. |
| Sharing | `canvas.toBlob` → Web Share API, falling back to download | |
| Tests | Vitest (engine invariants, fuzzing), Playwright (screenshots, bundle-size budget) | |
| Hosting | Static host with Brotli + immutable caching (Cloudflare Pages / Netlify / Vercel / GitHub Pages) | No backend. |

Engine and platform alternatives (Babylon.js, PlayCanvas, Unity, Godot, Unreal, Rust/WASM) are unchanged from R1 (§2.1). The weight comparison strengthens the case: Godot's default web export was measured at ~42 MB uncompressed, and Unity Web also ships a multi-megabyte runtime before any content. The recommended web stack's first load is ~0.2 MB.

---

## 2. Alternatives considered

### 2.1 Engines / platforms

| Option | Verdict | Reasoning |
|---|---|---|
| Babylon.js 9.x | Runner-up | Excellent and batteries-included, but three.js has the larger example base and smaller pieces to pick from. The hair engine is renderer-agnostic, so this choice is reversible. |
| PlayCanvas 2.x | Rejected | Editor-centric workflow; no advantage for procedural meshes. |
| Unity 6 Web | Rejected (browser-first) | Mobile browsers are now supported, but managed C# threads aren't supported on Web, and the runtime download and startup are heavy. |
| Godot 4.5 Web | Rejected | WebGL 2 only, no C# on Web, ~42 MB default export (uncompressed). |
| Unreal + Pixel Streaming | Rejected | A GPU server per user. |
| Rust/WASM | Not needed | The JS benchmarks below are fast enough. A WASM hot path could be added later. |

### 2.2 Hair representations

| Representation | Verdict | Reasoning |
|---|---|---|
| **Hair clay (volume + Surface Nets)** | **Recommended** | Clay/sand-like by nature. Any cut, add or smudge stays valid geometry. Light on the GPU. See §3. |
| Lock field (R1: guide curves + tubes) | Shelved | Strand-like control (combing direction, beads on strands), but 0.2–0.7 M hair triangles, more moving parts, and it isn't the clay feel you want. The CPU benchmark is kept in `research/bench/lock-field.mjs`. |
| Hair mesh + CSG slicing | Rejected | three-bvh-csg requires watertight, non-self-intersecting input; slicing repeatedly is slow and fragile. |
| Ray-marching the volume directly on the GPU (no mesh) | Rejected for now | Avoids meshing, but costs dozens of texture reads per pixel every frame. That is the wrong trade for integrated laptop GPUs at high-DPI resolutions. Meshing moves the cost to edit time and only touches small areas. |
| Shell texturing | Kept only for stubble and razor patterns on the scalp | |

---

## 3. Hair clay: how it works

### 3.1 Data

A grid covers the head and the space hair can occupy (about 32 × 40 × 32 cm). Each cell stores:

| Channel | Size | Meaning |
|---|---|---|
| `shape` | 1 byte (quantized signed distance) | How far the cell is inside or outside the clay. The surface is where this crosses zero. |
| `color` | 2 bytes (RGB565) | Dye. |
| `style` | 1 byte | Hair type: straight, wavy, curly, afro or spiky, plus intensity. |
| `hold` | 1 byte | How firmly the material keeps its shape. Low = dry sand that crumbles and slumps. High (default) = packed sandcastle/clay that holds spikes and overhangs. |
| `flow` | 2 bytes, optional | The direction the material was last combed. Drives groove and wave detail. |

At 3 mm cells that's about 1.6 M cells, or **~8–11 MB in memory**. Plus:
- **Head distance field:** a precomputed `head` distance grid, so hair never enters the head and tools can measure distance from the scalp.
- **Scalp texture:** a high-resolution 2D texture (octahedral projection) for stubble and crisp razor patterns, which are finer than the 3D grid.

Quality presets set the cell size and are picked automatically by a quick device probe:

| Preset | Cell size | Hair triangles | Use |
|---|---|---|---|
| Light | 4 mm | ~45–50 k | Older or low-power laptops, phones |
| Standard | 3 mm | ~80–90 k | Mid-range laptops |
| High | 2.5 mm | ~115–125 k | Strong laptops and desktops |

### 3.2 From grid to screen

```
brush edits cells in a small box
  -> mark the 8×8×8 "bricks" it touched as dirty
  -> worker re-runs Surface Nets on dirty bricks only (positions, normals, colours)
  -> main thread copies those bricks' vertices into one pooled GPU buffer (addUpdateRange)
  -> one draw call for all hair
```

Surface Nets yields a smooth, crack-free surface. Brick borders match exactly because both sides read the same cells.

Small surface detail adds no geometry cost. It comes from the shader and a slight vertex displacement driven by `style` and `flow`:
- grooves combed along the hair direction
- ridges for wavy hair
- lumps for curly or afro hair

### 3.3 Sandcastle / clay behaviour

- **Holds by default:** packed material keeps whatever shape you sculpt, like a sandcastle. Nothing slumps unless it is unsupported.
- **Crumble:** carving and cutting shed a few cheap grain particles at the cut edge, so cuts feel like slicing packed sand.
- **Settle:** after each stroke, overhangs near the brush that are too thin, or stick out too far for their `hold` value, crumble and slide down until they rest on the scalp or on other material (angle of repose). This takes ~1–3 ms in the local area.
- **Detach and fall:** when a stroke ends, a flood fill finds any clay that is no longer connected to the scalp, for example a ponytail cut at its base. That piece is removed from the grid and drops as a falling chunk effect. This takes ~10–40 ms once per stroke, in the worker.
- **Fluid-but-solid feel:** the comb and smudge tools carry material along the drag, then lightly smooth it, like surface tension. Material flows, but it keeps its volume and holds its new shape.
- **Hold tools:** "hair gel / spray" raises `hold` so tall spikes and overhangs survive. A "hair dryer" lowers it, so the area loosens, crumbles and fluffs out. This makes the sandcastle/clay spectrum a playful mechanic instead of a hidden setting.
- **Look:** an optional subtle sand-grain texture in the toon shader. Whether it stays on is decided in the M1 look test.

### 3.4 Tools

| Tool | What it does to the clay |
|---|---|
| **Scissors** | Carves a thin cut along the drag. Anything below the cut that's no longer attached to the scalp falls off. |
| **Trimmer** | Removes all material farther than the guard length from the scalp under the clipper, using the head distance grid. Gives an even buzz. |
| **Razor** | Guard length 0, plus painting crisp patterns into the scalp texture (finer than the grid). |
| **Comb** | Smudges material along the drag, records the `flow` direction (visible grooves), then lightly smooths. |
| **Hair dye** | Paints `color`. Modes: brush, streak, root→tip gradient (by distance from scalp), fill region. |
| **Hair grower** | Adds material outward from the scalp under the brush. The new material inherits the region's `style`, so growing curly hair grows curly. |
| **Extrude** | Pulls a tapered tongue of clay from the surface toward the pointer to make spikes, locks and tails. |
| **Curl** | Paints `style` = curly with increasing intensity. Larger intensities also bulge the volume. |
| **Flamethrower** | Erodes material with noise, chars the colour, makes it crispy (hold up), and spawns embers and smoke particles. |

### 3.5 Hair-type transformations (local, geometric)

Select a region (paint or lasso). The type then changes both the volume and the live detail:

| Type | Volume change | Live surface detail |
|---|---|---|
| Straight | smooth + relax | fine grooves along `flow` |
| Wavy | slight relax | sinusoidal ridges along `flow` |
| Curly | slight puff | round lumps (cellular noise) |
| Afro | **puff**: expand the volume outward from the scalp | larger, softer lumps |
| Spiky | **stamp tapered spikes** along surface normals at evenly spaced points | sharp ridges |

Because `style` lives in the cells, later edits respect it. Cutting an afro leaves afro texture on the new surface, and growing a spiky region grows spikes.

### 3.6 Accessories

Accessories are separate small meshes with an **anchor** on the clay or on the head:

- **Surface anchor** (clips, bows, stickers): a point plus normal on the clay surface. When the comb moves material, anchors inside the brush move with it. After each edit, the anchor snaps back to the nearest surface. If the material under it is removed, the accessory falls off. All of this is undoable.
- **Ring anchor** (hair ties, bands, beads): a ring fitted around a lock or spike by sampling the clay's cross-section. It can **squeeze** the clay slightly, so a tie visibly pinches a ponytail. Beads are small rings that slide along a lock.
- **Headband:** a ring fitted to the head distance grid that presses into the hair under it.
- **Braids:** the braid tool follows a drawn path and stamps a chunky three-strand braid into the clay, using standard parametric braid curves. It's made of clay, so it can be cut and dyed like any other hair.
- **Stickers on skin:** decals on the static head mesh (`DecalGeometry`).

### 3.7 Undo / redo / reset / save

- **Undo:** each stroke saves the before and after copies of every 8×8×8 brick it touched, compressed. Undo and redo swap them back exactly. Accessory changes save JSON before/after. History is capped by memory (e.g. 64 MB), not by step count.
- **Reset:** restores the starting hairstyle as one undoable step.
- **Saving:** the grid is mostly empty space and compresses very well. It is saved to IndexedDB automatically and can be exported or imported as a `.haircut` file.

### 3.8 Custom head

The custom head is a glTF/GLB file with a bald head. At import, a worker computes the head distance grid (with three-mesh-bvh, loaded only then). You paint the hair regions in-app, and starting hairstyles are generated on top of them.

---

## 4. Evidence (measured)

All numbers come from a single 2.1 GHz Xeon vCPU running Node 22, using medians. Scripts are in `research/bench/` (run with `node research/bench/hair-clay.mjs vs=0.003 brick=8`). A mid-range laptop CPU should be similar to this, and recent ones faster. This is an assumption to verify in M1.

### 4.1 Hair clay (8³ bricks, brush radius 2 cm)

| Cell | Cells | Hair triangles | Generate starting style | Mesh whole head (load) | **Cut touch** | **Add touch** | Detached-chunk check (per stroke) | Sand settle |
|---|---|---|---|---|---|---|---|---|
| 4 mm | 0.66 M | 45–49 k | 99 ms | 40 ms | **1.2 ms** | **1.5 ms** | 10 ms | 0.7 ms |
| 3 mm | 1.57 M | 79–87 k | 169 ms | 95 ms | **1.6 ms** | **2.0 ms** | 21 ms | 1.5 ms |
| 2.5 mm | 2.68 M | 113–125 k | 273 ms | 162 ms | **2.4 ms** | **2.9 ms** | 37 ms | 0.6 ms |

- These costs are paid **only while editing**, in a worker. Orbiting the camera costs only GPU time for the ~50–125 k triangles.
- With 16³ bricks a touch costs 2.4–4.8 ms (more cells re-meshed), so 8³ bricks are the choice.
- In my first, naive version, generating the starting style over the whole grid took 0.4–3.4 s. Skipping empty space (narrow band) cut that to 0.1–0.27 s.

### 4.2 Download weight (esbuild, minified, Brotli)

| Piece | Compressed |
|---|---|
| three.js (core features used + OrbitControls + GLTFLoader + Meshopt decoder) | **136 KB** |
| three-mesh-bvh (extra on top of three; lazy, custom-head import only) | 12 KB |
| React 19 + ReactDOM | 58 KB |
| **Preact + hooks** | **5 KB** |
| App code (estimate) | 40–80 KB |
| Built-in head and starting hairstyles | ~0 (generated on device) |
| **Estimated first load** | **≈ 200–250 KB** |

### 4.3 Comparison with R1

| | Lock field (R1) | Hair clay (R2) |
|---|---|---|
| Hair triangles | 228 k–690 k | 45 k–125 k |
| CPU per brush touch | 0.3–0.75 ms | 1.2–2.9 ms (in a worker) |
| Feel | strands, combing | clay/sand, fluid-but-solid |
| Finest feature | ~5 mm locks | ~2 cells (5–8 mm) |
| Moving parts | curves, frames, constraints, pose solve, style layers | grid + meshing + a few stamp/smudge operations |

---

## 5. Loading time and page weight plan

### 5.1 Fast first load

1. **Instant first paint.** The HTML shell has inline CSS and an SVG loading illustration, so there is no blank screen while JS loads.
2. **Small critical path (~200–250 KB compressed).** three.js, Preact and the engine with its default tools load first. The flamethrower FX, braid tool, photo mode, export, accessories and custom-head import are **loaded on demand** (dynamic `import()`), then prefetched while the browser is idle.
3. **Generate instead of download.** The built-in head and starting hairstyles are a few hundred bytes of description each. The worker builds them while the UI appears (~0.1–0.3 s measured).
4. **Compact assets.** Use glTF with Meshopt compression (small JS decoder) rather than heavier WASM decoders. The toon look needs almost no textures: a tiny colour ramp, vertex colours and maybe one small WebP. Use system fonts or one subset WOFF2.
5. **Caching.** Hashed filenames with long cache lifetimes, Brotli at the host, and a service worker (PWA), so repeat visits load from disk and the app works offline.
6. **Enforced budget.** A CI check fails the build if the initial JS exceeds **300 KB compressed** (with headroom).

### 5.2 Light at runtime

1. **Render on demand.** Draw only when the camera moves, an edit happens or an effect is playing. When idle, the GPU sits near zero: no fan noise, no battery drain.
2. **Low triangle count, one draw call** for the hair (pooled buffer), ~20–30 k triangles for the head, no real-time shadows (toon ramp plus fake ambient occlusion).
3. **Resolution scaling.** Cap pixel density at 1.5×. Drop to 1× while orbiting or brushing if a frame takes over ~16 ms, then render a crisp full-resolution frame when the motion stops.
4. **Cheapest outline that looks right.** Measure both an inverted-hull outline (doubles the triangles, no extra full-screen pass) and an edge-detection pass, then keep the cheaper one on integrated GPUs.
5. **Heavy work off the main thread.** Meshing, settle and flood fill run in a worker, and each frame merges all of its brush touches into one update.
6. **Bounded memory.** ~10–30 MB for the volume, plus an undo history capped by size.

### 5.3 Target hardware (to confirm)

"Mid-range laptop" baseline:
- 4-core CPU from 2020 or later
- integrated GPU (Intel Iris Xe / UHD 620 class, or AMD Radeon Vega class)
- 8 GB RAM
- current Chrome, Edge, Safari or Firefox

Targets:
- Standard preset at 60 fps while orbiting.
- Interactive within 2 s of opening the page on a typical broadband connection.

---

## 6. Risks (hair clay)

| # | Risk | Likelihood | Impact | Mitigation | Resolved by |
|---|---|---|---|---|---|
| 1 | **Look:** reads as a melted helmet rather than stylized hair | Medium | High | Flow-aligned grooves, chunky shapes from extrude/spike stamps, toon bands and outlines, coloured lumps | M1 look test |
| 2 | **Detail limit:** nothing thinner than ~2 cells; thin locks or strand-level beads aren't possible | Certain | Medium | Accept chunky style; High preset at 2.5 mm; beads and ties fit chunky locks | M1/M2 review |
| 3 | **Smudge drift:** repeated combing slowly gains or loses volume, or blurs detail | Medium | Medium | Local re-distancing, a volume-preserving smudge, adjustable smoothing | M2 tests |
| 4 | **Latency with big brushes:** cost grows with brush volume | Medium | Low | Worker, one update per frame, brush-size cap, Light preset | M2 |
| 5 | **Accessories drifting** on a changing surface | Medium | Low | Move anchors with edits, snap them to the surface, detach-and-fall rule | M5 |
| 6 | **Sandcastle feel needs tuning** (too crumbly or too stiff) | High | Low | Gel and hair-dryer tools expose it as gameplay; presets | M2 |
| 7 | **Integrated-GPU fill rate** at high-DPI resolutions with outlines | Low–Med | Medium | Resolution scaling, cheapest outline, render on demand | M1 perf check |
| 8 | AI-written geometry code subtly wrong | High | Medium | Headless engine + invariant/fuzz tests + screenshot tests | Continuous |

---

## 7. Proof-of-concept plan

**M1 — Minimal scene you can open on your own laptop (≈ 3–5 days)**
- Vite + TS + three.js + Preact skeleton, CI with the bundle-size budget, preview deployment link.
- Procedural toon head, starting hairstyle generated in a worker, Surface Nets meshing, toon shading + outline, orbit camera, render on demand, quality presets, frame-time HUD.
- **Exit:**
  - First load ≤ 300 KB compressed and interactive in < 2 s on your laptop.
  - 60 fps orbit at the Standard preset.
  - You approve the look from the live preview.

**M2 — The hardest interaction: drag a tool and genuinely change the hair (≈ 1–2 weeks)**
- Brush engine: picking by stepping a ray through the grid, stroke spacing, size and strength.
- Four tools that change the clay in clearly different ways:
  - **Scissors:** cut, with detached pieces falling.
  - **Comb/smudge:** material flows along the drag.
  - **Extrude/grow:** adds material and pulls spikes.
  - **Gel / hair dryer:** packed ↔ crumbly hold behaviour.
- Undo, redo and reset with brick snapshots; invariant and fuzz tests.
- **Exit:**
  - No dropped frames while brushing on your laptop.
  - Every tool makes a visible, persistent change.
  - Undo restores the state exactly.

**Later milestones**
- **M3:** trimmer, razor (scalp texture), dye, flamethrower.
- **M4:** hair types (style field, puff and spike stamps), beard.
- **M5:** accessories (surface and ring anchors, ties, beads, clips/bows, stickers, headband, braid stamp).
- **M6:** photo mode, export/share, save/load.
- **M7:** custom head import.
- **M8:** product UI polish, PWA, mobile tuning.

---

## 8. Proven vs. assumed

**Proven or measured:**
- Surface Nets / signed-distance sculpting (an established technique; SDF modeling ships in the browser in Womp).
- CPU costs in §4.1 and download sizes in §4.2 (measured here).
- three.js partial buffer and texture uploads (verified in r186 source).
- Falling-sand style settling (a well-known cellular-automaton technique).

**Assumed, to test in M1/M2:**
- The look at 2.5–4 mm cells.
- Integrated-GPU frame times with outlines at high-DPI.
- Your laptop's CPU speed relative to the benchmark machine.
- How well the smudge tool conserves volume.
- How the sand behaviour feels.

---

## 9. Sources

- three.js r186 package source (npm `three@0.186.1`): `BufferAttribute.addUpdateRange`, `Texture.addUpdateRange`, `WebGPURenderer` WebGL 2 fallback, `DecalGeometry`, `OutlineEffect`.
- Bundle sizes: measured with esbuild 0.28 from npm `three@0.186.1`, `react@19.3.1`, `react-dom@19.3.1`, `preact@11.0.1`, `three-mesh-bvh@0.9.16`.
- WebGPU browser support (web.dev): https://web.dev/blog/webgpu-supported-major-browsers
- three-mesh-bvh: https://github.com/gkjohnson/three-mesh-bvh
- three-bvh-csg (two-manifold requirement): https://github.com/gkjohnson/three-bvh-csg
- Babylon.js 9.0 coverage: https://www.windowsmode.com/babylon-js-9-0-released-build-immersive-3d-web-apps/
- Unity 6 web runtime: https://unity.com/blog/engine-platform/web-runtime-updates-enhance-browser-experience
- Unity 6 Web technical overview: https://docs.unity3d.com/6/Documentation/Manual/webgl-technical-overview.html
- Godot 4.5 web export: https://docs.godotengine.org/en/4.5/tutorials/export/exporting_for_web.html
- Godot web build size: https://popcar.bearblog.dev/how-to-minify-godots-build-size/
- Womp SDF modeling in the browser: https://80.lv/articles/womp-creating-goopy-3d-models-in-your-browser/
- Braid modeling: https://arxiv.org/pdf/2506.23072v1, https://graphics.pixar.com/library/Cornrows/paper.pdf
- Web Share API (files): https://web.dev/articles/files/share-files
- Blender curves sculpting (R1 reference): https://docs.blender.org/manual/en/latest/sculpt_paint/curves_sculpting/index.html
