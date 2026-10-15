# Milestone 1 report: minimal hair-clay scene

Status: **built, needs your on-device check.**

## What's in it

- A procedural placeholder bust (head, shoulders, jacket) and three starter hairstyles: **Quiff** (with full beard), **Spikes**, **Afro**.
- The hair is a hair-clay volume. A Web Worker builds a distance grid near the surface only and meshes it with Surface Nets in 8×8×8 bricks, which is the same unit later edits will re-mesh.
- Toon shading with baked "clay crevice" ambient occlusion, optional sand grain on the hair, and ink outlines (inverted hull, no extra full-screen pass).
- Laptop-friendly rendering:
  - Draws only when something changes (no idle GPU use).
  - Lowers resolution while you rotate if frames are slow, then draws a sharp frame when you stop.
  - Picks a quality tier from your graphics chip.
- **Run speed test**: a 4-second turntable that reports average fps and the slowest 5% of frames. **Copy results** puts a summary on the clipboard to paste back to me.

## Measured here (cloud container, software GPU)

| | Light (4 mm) | Standard (3 mm) | High (2.5 mm) |
|---|---|---|---|
| Hair triangles | 33–44 k | 58–78 k | 84–113 k |
| Head + shoulders triangles | ~30 k | ~50 k | ~70 k |
| Worker build (shape + mesh + head), Node | 0.25–0.38 s | 0.38–0.53 s | 0.55–0.71 s |
| Page ready (headless Chromium, software GPU) | — | ~0.75–0.85 s | ~0.9–1.2 s |

- **First download: 124 KB compressed** in total (three.js + Preact + app 118 KB, hair worker 5 KB, page 2 KB). The budget is 300 KB, and CI fails if it's exceeded.
- Draw calls: 57–97 (hair is grouped into chunks of 4×4×4 bricks).
- The software GPU here can't say anything about frame rate on real hardware. That's what the speed test on your laptops is for.

## Please check on both laptops

| Laptop | Expected auto tier | What to try |
|---|---|---|
| MacBook Air M5 | High | Run the speed test. Expect a solid 60 fps. |
| ASUS FX505GE | Standard (Chrome usually runs on the Intel UHD 630, not the GTX 1050 Ti) | Run the speed test on Standard and on Light. Then rotate by hand and check that it feels smooth. |

**Exit criteria**
- [ ] Loads and is usable within ~2 s on both laptops
- [ ] Speed test ≥ 55 fps average at the auto tier on both laptops
- [ ] You like the look, or tell me what to change: shading, outline weight, grain, colours, the placeholder head

## Known limitations (by design for M1)

- No editing tools yet. Dragging only rotates the camera. Tools arrive in M2.
- The head is a stand-in until a custom model is imported in M7.
- The hair has no strand or groove detail yet. Flow-aligned grooves come with the comb tool.
