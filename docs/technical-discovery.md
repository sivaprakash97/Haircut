# Haircut Playground — Technical Discovery & Architecture Recommendation

Status: **proposal, awaiting approval.** No application code has been written.
Date: 2026-10-15

---

## 0. TL;DR

- **Stack:** TypeScript + Vite, **three.js r186 (`WebGLRenderer`, WebGL 2 baseline)**, three-mesh-bvh, a custom framework-free hair engine, and a thin React UI layer. Deploy as a static site. No game engine.
- **Hair representation:** a **"lock field"**. Hair is ~1,500–3,000 chunky locks, each a guide curve rooted on the scalp. Style layers (curl, wave, frizz, puff) are evaluated procedurally on top of each guide, and a high-resolution **scalp field texture** handles stubble and razor patterns. The meshes are derived: every edit changes curve data or parameters, and the tube meshes are regenerated from that data with a fixed vertex count per lock.
- **Why:** cutting, combing, growing, dyeing and changing hair type are all 1D operations on curves, or parameter changes. They can't produce holes or non-manifold geometry, because no one ever edits the mesh. At worst the result looks ugly, and an ugly result can still be undone. In a CPU benchmark I ran, one brush dab costs **0.3–1.7 ms** (cut, re-evaluate and re-mesh the locks it touches).
- **Biggest risks:** (1) whether chunky locks read as a cohesive clay mass or as "noodles"; (2) the GPU cost of 0.2–0.7 M hair triangles plus an outline pass on mid-range phones; (3) how sculpted guides combine with procedural types (combing curly hair, cutting an afro).
- **Next step:** M1 is a minimal scene that also runs the look test and the device performance test. M2 is the hardest interaction: scissors, comb, grow/extrude and curl brushes, with undo, all changing the same data.

---

## 1. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language / build | **TypeScript + Vite** | Fast iteration. Typed-array-heavy code benefits from types. AI coding tools are strongest here. |
| Rendering | **three.js r186, `WebGLRenderer` (WebGL 2)** | Most proven path on every target browser. Partial GPU buffer uploads (`BufferAttribute.addUpdateRange`) and partial texture uploads (`Texture.addUpdateRange`, which r186 implements in the WebGL texture path) are exactly what brush editing needs. Toon materials, outline effects, `MeshSurfaceSampler` and `DecalGeometry` all ship in core/addons. |
| Later option | three.js `WebGPURenderer` + TSL | Has an automatic WebGL 2 fallback (`forceWebGL` in r186 source). Only adopt it if a GPU-compute need appears. The hair engine is renderer-agnostic, so switching later costs materials only. |
| Spatial queries | **three-mesh-bvh 0.9.x** | `closestPointToPoint`, `shapecast`, `refit`, SDF generation and a sculpting example. Used for head collision, pointer picking on the head, and root placement. |
| Hair engine | **Custom TS module, no framework** | Structure-of-arrays typed arrays, fixed capacity. Runs headless in Node for tests and benchmarks. |
| Camera | `camera-controls` (3.x) or three's `OrbitControls` | Damped orbit with touch gestures. |
| FX | Custom particles, or `three.quarks` (0.17) | For the flamethrower, debris and dropped accessories. |
| UI | **React (DOM overlay) + a small store (e.g. Zustand)**. Tweakpane for dev panels in the POC. | Talks to the engine through a command API. Not React Three Fiber; see §2.3. |
| Persistence | IndexedDB (`idb-keyval`) + `CompressionStream('gzip')` | Autosave, plus `.haircut` file import/export. |
| Sharing | `canvas.toBlob` → Web Share API (files), falling back to download | `navigator.canShare({files})` feature detection. |
| Tests | **Vitest** (engine invariants, property-based fuzzing with `fast-check`) + **Playwright** screenshot smoke tests | Catches broken-geometry regressions in AI-written geometry code. |
| Hosting | Any static host (Cloudflare Pages / Netlify / Vercel / GitHub Pages) | No backend for the MVP. A host that can set COOP/COEP headers keeps `SharedArrayBuffer` workers possible later. |

Total runtime dependency weight is roughly three.js plus small libraries: a few hundred KB of gzipped JS, plus the head model.

---

## 2. Alternatives considered

### 2.1 Engines / platforms

| Option | Verdict | Reasoning |
|---|---|---|
| **Babylon.js 9.x** (9.31, Oct 2026) | **Strong runner-up** | Mature, batteries-included (WebGPU + WebGL 2, inspector, node materials, 9.0 added clustered lighting and a node particle editor). The hair system would be custom either way. three.js wins narrowly on the specific pieces needed here: three-mesh-bvh's closest-point/SDF/sculpt tooling, `MeshSurfaceSampler`, `DecalGeometry`, toon outline nodes, and a larger body of examples for AI tools to draw on. The engine core is renderer-agnostic, so this decision is reversible. |
| **PlayCanvas 2.x** | Rejected | Good engine, but its workflow is editor-centric and its ecosystem for geometry processing is smaller. No advantage for custom procedural meshes. |
| **Unity 6 (Web)** | Rejected for browser-first; revisit for native apps | Unity 6 officially supports Android/iOS browsers. WebGPU arrived experimentally in 6.1 (a secondary source reports production status in 6.6; I haven't verified this). Against it: managed C# threads aren't supported on Web (Unity 6 manual), the engine download and startup are much heavier than a JS bundle, iterating through the Editor GUI and scene YAML is harder for AI coding tools, and HTML UI and sharing are more awkward. Pick Unity if native app stores become the priority. |
| **Godot 4.5 (Web)** | Rejected | Web export is WebGL 2 / Compatibility renderer only. **C# can't be exported to Web in Godot 4** (official docs). The default web export was measured at ~42 MB uncompressed. Per-frame vertex regeneration in GDScript would be slower than JIT-compiled JS, and the fix (a C++ GDExtension built to WASM) adds build complexity. |
| **Unreal + Pixel Streaming** | Rejected | Needs a GPU server per concurrent user. Cost and latency don't fit a casual web toy. |
| **Rust/WASM (Bevy or custom)** | Rejected as the primary platform | Fast, but slower to iterate, with immature tooling and a smaller AI corpus. The benchmark (§5) shows JS is fast enough for the hair core. A WASM hot path stays possible later. |

### 2.2 Hair representations

| Representation | Verdict | Reasoning |
|---|---|---|
| **A. Hair mesh + mesh sculpting + CSG slicing** (SculptGL-style dynamic topology; three-bvh-csg / manifold-3d for cuts) | Rejected | three-bvh-csg's README: *"All brush geometry must be two-manifold — or water tight with no triangle interpenetration"*. A mass of overlapping hair is the opposite of that. Once a mesh is sliced, it has no notion of strands, so regrowing, curling, combing or attaching a bead to it is ill-defined. SculptGL's dynamic topology also discards UVs, which would lose dye. |
| **B. Voxel / SDF volume** (Dreams/Womp/Clayxels-style, surface nets or marching cubes) | Rejected as primary; kept as a fallback **rendering** idea | Arbitrary cut and add operations never break it, and it looks naturally clay-like. Womp proves SDF modeling ships in browsers. But a volume has **no strand direction**, so comb, curl, braid, beads and streak dye can't be expressed. Thin spikes and curls need high resolution, which means memory and remesh cost on mobile, and "hair type" becomes surface noise rather than structure. |
| **C. Shell texturing / height field only** | Adopted **only for the short-hair/scalp layer** | Cheap and robust for stubble, fades and razor patterns. Can't represent long hair, spikes, braids or curls. |
| **D. Hair cards (alpha-textured strips)** | Rejected | A realism technique. Alpha sorting fights cel shading, and editing card textures is not a geometric change. |
| **E. Lock field: guide curves + procedural style layers + derived meshes, plus a scalp field** | **Recommended** | See §3. Precedents: Blender's curves sculpt mode (since 3.3) runs Comb (preserves segment lengths), Snake Hook, Grow/Shrink, Puff, Density, Add/Delete, Pinch, Smooth and Slide on one curve representation, and Blender's procedural hair node groups add curl, frizz and clump on top of guides. Toca Hair Salon 4 shows cut/shave/grow/dye/curl/straighten as a consumer mobile experience (its implementation isn't public). |

### 2.3 Other choices

- **React Three Fiber:** not used for the engine. The scene is one viewport whose cost lies in imperative typed-array edits, so a declarative reconciler adds indirection and no benefit. React stays in the DOM UI only.
- **Physics engine (Rapier):** not needed for hair. Static pose solves plus follow-the-leader constraints are enough. Could be added later for falling debris and dropped accessories, though simple Verlet particles will probably do.
- **Web Workers:** not needed initially (sub-millisecond dabs). The engine's typed-array design lets it move to a worker later if profiling demands it.

---

## 3. Proposed architecture

### 3.1 Hair data model ("HairDocument")

All state lives in fixed-capacity structure-of-arrays typed arrays. Lock IDs are stable for life, and capacity is never reallocated during a session.

```
Root slots (capacity = max density, pre-scattered blue-noise over hair regions, sorted in Morton order)
  rootTri[i], rootBary[i]      -> where on the head mesh the lock grows
  region[i]                    -> scalp | beard | brows | ...
  active[i]                    -> dormant slots = "no hair here yet" (grower activates them)
  seed[i]                      -> per-lock random seed (deterministic procedural layers)

Guide spine (sculpted shape), fixed segment length h (~8 mm), up to M segments (~48 => ~38 cm)
  spine[i][0..M]               -> points; activeSegments derived from length
  length[i]                    -> current arc length (cut/grow change this)

Style parameters (procedural layers, per lock)
  curlRadius, curlFreq, waveAmp, waveFreq, frizz, stiffness, puff,
  thickness, flatten, taper, tipStyle (blunt | tapered | singed)

Colour tape (dye), stored by ABSOLUTE distance from root, e.g. every 5 mm
  color[i][k]                  -> cuts truncate it, growth extends it with the root colour
                                  ("grown-out roots" for free)

Scalp field (2D textures in an octahedral projection around the head centre, ~1024²)
  stubbleLength, shaveMask(razor), skinTint
```

Two design decisions do most of the work:

1. **Meshes are a pure function of this data.** Each lock always has the same number of evaluated samples (E ≈ 20–32) and cross-section sides (S ≈ 4–6), so the **index buffer is built once and never changes**. A shaved lock collapses to zero length, and a grown lock spreads the same samples over a longer curve. No edit allocates memory, changes topology or invalidates IDs.
2. **Edits change data, never vertices.** Undo/redo, save/load and multiplayer-style sync later all operate on small typed records.

The octahedral scalp projection maps directions from the head centre to a 2D texture. It is **independent of the model's UVs**, which matters for swapping in a scanned head with poor UVs. At 1024² it gives roughly 0.4 mm texels over the scalp, which is plenty for crisp razor lines.

### 3.2 Per-lock evaluation pipeline (only for "dirty" locks)

```
spine (sculpted)
  -> constraints        hair-tie / bundle pinch, headband hold-down
  -> style layers       wave / curl / coil in a parallel-transport frame along absolute arc length s;
                        frizz noise (seeded); puff bias
  -> collision          push out of head SDF / BVH closest point
  -> E samples          positions, frames, colour from tape
  -> mesh               tapered, optionally flattened tube; tip style
  -> GPU                write the lock's vertex range; addUpdateRange
```

Locks are stored in Morton (spatial) order, so the locks one brush touches tend to be contiguous and the GPU gets a few upload ranges rather than hundreds.

Style layers are parameterized by absolute arc length from the root. Cutting a curly lock therefore keeps the curls that remain exactly where they were, and growing it continues the curl pattern.

### 3.3 Tools: what each one changes

| Tool | Acts on | Data change |
|---|---|---|
| **Scissors** | Locks whose *evaluated* geometry intersects the blade capsule along the drag | `length` := arc length of the first hit sample (sub-segment precise); tip blunt |
| **Trimmer** | Locks whose **roots** lie under the clipper footprint (scalp space, like real clippers) | `length` := min(length, guard length); writes `stubbleLength` |
| **Razor** | Scalp `shaveMask` texture at ~0.4 mm, plus locks rooted inside it | Paints the mask; rooted locks → length 0; skin shows the pattern |
| **Comb** | Spine points within the brush | Displace along the drag with falloff → follow-the-leader length restore → head push-out → light smoothing |
| **Dye** | Colour tape samples within the brush | Modes: paint, streak (whole lock), gradient (root→tip ramp over the selection), stencil (project an image) |
| **Hair grower** | Locks and dormant root slots under the brush | `length` += rate·dt, extended along the tip direction and shaped by type; activates slots; thickness up to a limit |
| **Extrude** | Locks near the pointer | Snake-hook: tip points follow the pointer and the lock grows while being pulled; stiffness up (spikes, locks) |
| **Curl** | Style parameters under the brush | curlRadius/curlFreq += with falloff (gradual) |
| **Flamethrower** | Locks inside a cone | Random length loss; char colour near the new tip; frizz up; singed tip style; particles, smoke and falling embers |

Every row is either a 1D curve operation (truncate, extend, move points while preserving segment lengths) or a parameter change. That is why the representation can't produce broken geometry.

Comb follows Müller et al., *Fast Simulation of Inextensible Hair and Fur* (2012), the follow-the-leader method: inextensible strands in one iteration, handling thousands of strands in real time. Blender's Comb brush uses the same contract ("moves points, preserving segment lengths").

### 3.4 Localized hair-type transformations

A type is a preset of style parameters plus a **pose rule** for the spine:

| Type | Style layer | Spine pose rule |
|---|---|---|
| Straight | none | drape: gravity vs stiffness solve against the head |
| Wavy | planar sine, low frequency | drape, shortened slightly by the waves |
| Curly | helical ringlets (radius ~5–8 mm) | drape with more stiffness, so curls spring |
| Afro | tight coil + frizz + thicker + higher density | **puff**: spine pushed radially outward from the head |
| Spiky | none; sharp taper, flattened | aligned to the surface normal or comb direction, high stiffness |

Applying a type works like this: select a region (paint on the scalp, or lasso), then blend those locks' parameters toward the preset with a falloff at the region edge, then re-run the pose rule, then animate the transition over about 300 ms. Re-evaluating 3,000 locks measured ~9 ms, so animating a whole-head change is affordable.

The pose solve is a static, edit-time relaxation (gravity + stiffness + follow-the-leader + collision, a few iterations per lock), not continuous simulation. An optional vertex-shader sway adds "life" at no CPU cost.

**Afro caveat:** convincing tight coils need more samples per lock than straight hair (about 6 samples per turn). The plan is to render afro as clumpy, bumpy masses rather than resolved coils, which also fits the stylized look. The sample budget per type is an explicit experiment (§7, E3).

### 3.5 Accessories and attachment

Every accessory is an entity with an **anchor**, resolved after hair evaluation each time the hair under it changes:

| Anchor type | Definition | Used by |
|---|---|---|
| `LockAnchor` | `{lockId, s (absolute arc length), twist, offset}`, placed using the lock's evaluated frame at s | Beads (dragging slides along s), clips, bows, small hair stickers |
| `BundleAnchor` | `{lockIds[], s}` at the centroid of those locks at s; **also adds a pinch constraint** to them | Hair bands, ponytail ties, braid ends |
| `SurfaceAnchor` | `{triangle, barycentric, normal offset, rotation}` on the static head mesh | Stickers and decals on skin (three's `DecalGeometry`), headband base |
| `RingAnchor` | Parametric ring projected onto the head surface + offset; **adds a hold-down constraint** to locks that cross it | Headbands |

- Accessories follow the hair because their anchor references lock data, not mesh vertices.
- If a cut removes the anchor point (`s > length`), the accessory **detaches and falls**. That's fun, undoable, and cheap.
- **Braids** are a group entity: the selected locks are absorbed into a braid spine, rendered as three interleaved sub-strands from sinusoidal mid-line equations (as in arXiv 2506.23072 and the Pixar cornrows paper; Unity's Wig braid tool is also driven by one curve). The braid is lock-like itself, so scissors, dye and comb still apply. Unbraiding restores the stored member locks. This is the largest single accessory feature and is scheduled after the core tools.

### 3.6 Undo / redo / reset / save

- **Transactions per stroke.** The first time a stroke touches a lock, the engine copies that lock's record (spine, scalars, colour tape) into `before`. At stroke end it records `after` for the same IDs. Undo writes `before`, redo writes `after`. Scalp textures use 64×64 copy-on-write tiles. Accessory changes store JSON before/after.
- **No replay.** Procedural layers are deterministic through per-lock seeds, so snapshots are exact and undo is bitwise-reversible. This is testable.
- **Budget:** measured ~12–24 KB per dab at 3,000–6,000 locks. History is capped by bytes (e.g. 64 MB), not by step count.
- **Reset** is a transaction back to the initial document, so it is undoable too.
- **Save:** a versioned binary (header + typed-array sections + accessories JSON), gzipped with the native `CompressionStream`. Autosaves to IndexedDB and exports/imports as a `.haircut` file. Shareable links would need object storage later and aren't in the MVP.

### 3.7 Rendering the "clay / Jet Set Radio" look

- All locks render in **one draw call**: one merged geometry with a static index and dynamic position/normal/colour attributes.
- **Toon shading:** a 2–3 band ramp, vertex colours from the dye tape, and a soft rim light. **Normals are blended toward a smooth "mass normal"** (from the head centre or an envelope), so neighbouring locks shade as one sculpted volume rather than separate tubes. This is a standard stylized-hair trick.
- **Outlines:** one screen-space edge pass on depth and normals, optionally with lock-ID edges for the ink lines between chunks. This is cheaper than inverted hulls at this triangle count. r186 also ships `OutlineEffect` (inverted hull) and TSL `ToonOutlinePassNode`/`SobelOperatorNode` if needed.
- **Cross-section:** 4–5 sides, slightly flattened, for chunky faceted locks. This choice sets both the look and the triangle budget, so it is part of experiment E1.
- **Scalp:** the head shader reads the scalp field for stubble tint and crisp razor patterns. Optional shell layers for buzz-cut fuzz can come later.
- **Fallback look (if E1 fails):** wrap the locks in a smooth-union "clay skin" (voxelized SDF of lock capsules, surfaced locally with surface nets in a worker). The editing model stays the same and only the rendering changes. This is expensive, and would only be done if the cheaper look fails.

### 3.8 Replaceable character ("bring your own head")

Character contract:
- glTF 2.0 `.glb`, metres, Y-up, facing +Z, head roughly centred; ~10–40k triangles.
- The model must be **bald**, because hair is generated rather than modelled. Hair regions come from a vertex-colour or texture mask, or are painted in-app with a *region painter* tool (preferred, since it removes the authoring burden).
- Optional anchor empties (ears, nose bridge, crown) help fit headbands and glasses.
- On load: build the BVH, bake a coarse head SDF (64³), scatter root slots over the regions, and choose a head centre for the octahedral scalp projection.
- Getting a model of yourself is art work, not code: a phone photogrammetry scan (e.g. Polycam, RealityScan, Scaniverse) or an image-to-3D tool, then a Blender pass to remove scanned hair, sculpt a clean scalp, decimate and stylize.

### 3.9 Existing libraries vs custom code

| Existing (use as-is) | Custom (the actual product) |
|---|---|
| three.js renderer, glTF/KTX2/Meshopt loaders, toon/outline building blocks, `MeshSurfaceSampler`, `DecalGeometry` | HairDocument data model and capacity management |
| three-mesh-bvh: picking, closest point, SDF bake | Brush engine (stroke sampling, falloff, symmetry) |
| camera-controls / OrbitControls | Lock evaluation: style layers, pose solve, follow-the-leader, collision |
| three.quarks (optional) for FX | Lock mesher with fixed topology, Morton-ordered GPU range uploads |
| React + Zustand, Tweakpane | The nine tools, hair-type presets and transitions |
| idb-keyval, CompressionStream, Web Share API | Scalp field painting (octahedral textures, tile undo) |
| Vitest, fast-check, Playwright | Accessory anchors, constraints, braid generator |
| | Transactions / undo, file format |
| | Toon "mass normal" shader tweaks, edge-outline pass tuning |

---

## 4. Can one representation do cut, reshape, grow, recolour and change type?

**Yes, with the lock field, subject to known limits.**

| Operation | Representation change | Can it break geometry? |
|---|---|---|
| Cut / trim / burn | Truncate the spine and colour tape | No: fewer samples spread over a shorter curve, same topology |
| Comb / reshape | Move points under a fixed-segment-length constraint | No; worst case is penetration, fixed by push-out |
| Grow / extrude | Extend the spine, activate dormant slots | No: capacity is pre-allocated |
| Recolour | Write the colour tape | No geometry change |
| Change type | Change parameters + re-pose | No; worst case is odd shapes, and it's undoable |

**Limits, stated plainly:**
- **Cutting granularity is the lock.** Lock spacing is about 5–7 mm, so a sharp pattern carved *into long hair* will look stepped. Precise shaved designs work at texture resolution (0.4 mm) *on the scalp*, which is how real hair designs look anyway (lines in a fade).
- **Locks interpenetrate one another.** This is cheap to ignore in a cel style, but some sculpted shapes will show it.
- **Tight coils cost samples** (§3.4).
- **Combining sculpting with procedural layers** (combing curly hair, cutting an afro, extruding from a braid) needs clear rules, and some results may surprise users. This is experiment E3.

---

## 5. Evidence: CPU benchmark of the lock representation

I wrote a throwaway Node benchmark (not app code) that implements the actual hot path: spine → curl in a parallel-transport frame → tapered tube mesh with fixed topology, brush query, scissor cut + re-evaluate + re-mesh, and undo snapshot. It ran single-threaded on a 2.1 GHz Xeon vCPU (Node 22), median of repeated runs, with a brush radius of 3 cm.

| Locks × samples × sides | Hair verts / tris | Re-evaluate all | Re-mesh all | **One cut dab (query + cut + eval + mesh)** | Locks per dab | Undo bytes per dab |
|---|---|---|---|---|---|---|
| 1,500 × 20 × 4 | 120 k / 228 k | 3.9 ms | 5.4 ms | **0.32 ms** | 38 | 6 KB |
| 3,000 × 24 × 5 | 360 k / 690 k | 9.1 ms | 15.9 ms | **0.75 ms** | 77 | 13 KB |
| 6,000 × 24 × 6 | 864 k / 1.66 M | 19.8 ms | 35.2 ms | **1.69 ms** | 146 | 24 KB |
| 10,000 × 32 × 6 | 1.9 M / 3.7 M | 48.6 ms | 79.5 ms | **3.97 ms** | 261 | 43 KB |

How to read this:
- **The CPU is not the bottleneck.** Even assuming a phone is 3–5× slower (an assumption, not yet measured), a dab at 3,000 locks costs about 2–4 ms, inside a 16 ms frame. Whole-head type changes (25 ms on this machine) are fine as a one-off or spread across an animation.
- **The GPU is the open question.** These configurations produce 0.2–1.7 M hair triangles. A headless container can't measure that meaningfully; it needs real phones (E2).
- Each dab uploads ~220 KB of vertex data at 3,000 locks, which is fine. Memory: position + normal + index ≈ 17 MB at 3,000 locks. Instanced rendering (one lock template, vertices fetched from a texture) can cut that later if needed.

---

## 6. Biggest technical risks (ranked)

| # | Risk | Likelihood | Impact | Mitigation | Resolved by |
|---|---|---|---|---|---|
| 1 | **Look:** locks read as noodles or spaghetti, not a sculpted clay mass | Medium | High | Flattened 4–5-sided locks, mass-normal blending, ink outlines, high overlap. Fallback: clay-skin rendering (§3.7) | **E1** |
| 2 | **Mobile GPU:** 0.2–0.7 M tris + outline pass + overdraw too slow on mid-range phones | Medium | High | Device-tiered lock counts with blue-noise LOD (one document, a subset rendered thicker on phones), DPR cap, half-resolution outline pass | **E2** |
| 3 | **Edit coherence:** sculpted spines × procedural styles × constraints give surprising results (comb curly, extrude afro, cut braid) | Medium | Medium | Explicit layering rules; style evaluated in the spine frame by absolute arc length; property tests | **E3** in M2/M4 |
| 4 | **Cut fidelity:** lock-level granularity disappoints for fine scissor work | Medium | Medium | Sub-segment-precise cut points; denser locks in the fringe/edge region; razor via the scalp texture | **E4** |
| 5 | Collision and interpenetration (head, lock–lock, headband) | High | Low–Med | Head SDF push-out; hold-down constraints; cel style hides most of it | M2 tests |
| 6 | Braids and accessories surviving edits (cut through a tie, re-typing braided hair) | Medium | Medium | Anchors reference data; detach-and-fall semantics; braids scheduled late | M5 |
| 7 | Touch UX: orbit vs. brush conflicts, finger precision | High | Medium | One finger = tool, two fingers = orbit/zoom, brush cursor offset, symmetry mode | M2 on device |
| 8 | AI-written geometry code subtly wrong (NaNs, drift, irreversible undo) | High | Medium | Headless engine + invariant/property tests + screenshot tests from M1 onward | Continuous |
| 9 | Custom head pipeline (scan cleanup, bald scalp, region masks) | Medium | Low (art, not code) | Contract (§3.8) + in-app region painter | M7 |
| 10 | Scope (9 tools, 5 types, 5 accessory kinds, photo mode) | High | High | Milestones with exit criteria; no full UI until the editing core is proven | Plan |

Non-risks (checked): WebGL 2 availability, partial buffer updates, BVH queries at interactive rates, file sharing on mobile (with a download fallback), static hosting.

---

## 7. Smallest experiments that resolve the big unknowns

| ID | Question | Experiment | Size | Decision it drives |
|---|---|---|---|---|
| **E1** | Do chunky locks read as stylized clay hair? | Static head with ~2,000 locks. Grid of 3 cross-sections (round 6 / chunky 4 / flat ribbon) × mass-normal on/off × outline on/off; screenshots | 1–2 days | Lock style; whether the clay-skin fallback is needed |
| **E2** | How many locks can each device tier afford? | Same scene with a lock-count slider (500–6,000) and an FPS/frame-time HUD, plus a synthetic brush that re-meshes 100 locks per frame. Run on your phone(s), a mid-range Android and an integrated-GPU laptop | 1 day + device time | Lock budget per tier; outline resolution |
| **E3** | Do layered edits stay coherent? | In M2: scissors + comb + curl, plus a fuzz test of 10k random operation sequences checking invariants (no NaN, lengths ≥ 0, segment lengths preserved, roots fixed, no deep head penetration, undo is bitwise-exact) and visual review of tricky sequences | Part of M2 | Layering rules; per-type sample budgets |
| **E4** | Is lock-granular cutting satisfying? | In M2: scissors at small radius on a fringe; compare 1.5k vs 3k locks and blunt vs tapered tips | Part of M2 | Lock density near edges; tip styles |

---

## 8. Proof-of-concept plan

Each milestone ends with a short demo and an explicit go/no-go. The full UI is deliberately not built until M2 passes.

**M1 — Minimal 3D scene (≈ 3–5 days, includes E1 + E2)**
- Vite + TS + three.js project, Vitest, one Playwright screenshot smoke test, static preview deploy.
- Placeholder stylized bald head (CC0 or simple procedural), orbit camera (mouse + touch), toon shading + outline pass.
- Root scattering over a scalp/beard mask, a static lock field rendered as one draw call, frame-time HUD, lock-count and style toggles.
- **Exit:** chosen lock style approved from screenshots; frame-rate targets met at a chosen lock count on desktop and on your phone (60 fps desktop, ≥ 30 fps, ideally 60, on phone).

**M2 — The hardest interaction: drag a tool and genuinely change the hair (≈ 1–2 weeks)**
- Brush engine (ray onto head/hair, stroke spacing, falloff, radius/strength parameters).
- Four tools that change the data in fundamentally different ways:
  - **Scissors:** truncate
  - **Comb:** move with constraints
  - **Extrude/Grow:** lengthen and pull
  - **Curl:** change style parameters
- Stroke transactions with undo/redo/reset.
- Invariant and property tests (E3), cut-fidelity review (E4).
- **Exit:** each tool produces a visibly different and *persistent* geometric change, and the tools combine sensibly. A dab costs < 4 ms on your phone. The fuzz suite passes, and undo is exact.

**M3 — Scalp layer and the remaining cut-type tools:** trimmer, razor (octahedral mask, crisp patterns), dye with the colour tape (survives cuts), flamethrower (cut + char + particles).

**M4 — Hair types:** region selection, the five presets with animated transitions, beard mode.

**M5 — Accessories:** anchor system; beads, clips/bows, stickers/decals, hair ties/bands; then headbands; then the braid tool.

**M6 — Photo mode and persistence:** hidden UI, camera/light/background presets, high-resolution capture, Web Share/download, IndexedDB autosave, `.haircut` import/export.

**M7 — Bring-your-own-head:** glTF contract validation, region painter, root regeneration; import your own scanned head.

**M8 — Product UI and polish:** tool palette, parameter panels, mobile ergonomics, PWA, performance tiers.

---

## 9. Proven vs. assumed

**Proven (documented, shipped, or measured here):**
- WebGL 2 rendering with partial buffer/texture uploads in three.js r186 (verified in source).
- `WebGPURenderer`'s WebGL 2 fallback exists (r186 source).
- BVH closest-point, shapecast and refit queries at interactive rates (three-mesh-bvh docs: "500 rays against an 80,000 polygon model at 60fps").
- Curve-based hair sculpt toolsets (Blender 3.3+) and real-time inextensible strands (Müller et al. 2012).
- Consumer hair-salon feature sets on mobile (Toca Hair Salon 4).
- Browser SDF modeling (Womp) and browser mesh sculpting (SculptGL).
- Parametric braid models.
- File sharing through the Web Share API with feature detection.
- **CPU cost of the lock pipeline (measured, §5).**

**Assumptions still to test:**
- GPU frame time on phones (E2).
- The look (E1).
- Per-type sample budgets for curls/afro (E3).
- Coherence of layered edits (E3).
- Whether lock-granular cutting feels good (E4).
- Touch ergonomics.
- How well arbitrary scanned heads fit the contract.
- WebGPU availability: Chrome/Edge desktop, Chrome Android 121+ (Android 12+, Qualcomm/ARM GPUs), Safari 26, and Firefox 141 on Windows / 145 on Apple Silicon macOS are confirmed. Firefox on Linux and Android was "in progress" as of Nov 2025, and I couldn't confirm its 2026 status. This is why the plan uses a WebGL 2 baseline.

---

## 10. Sources

- three.js r186 package source (npm `three@0.186.1`): `BufferAttribute.addUpdateRange`, `Texture.addUpdateRange` (consumed in `WebGLTextures`), `WebGPURenderer` `forceWebGL`/WebGL backend, `MeshSurfaceSampler`, `DecalGeometry`, `OutlineEffect`, `ToonOutlinePassNode`, `SobelOperatorNode`.
- three.js WebGPURenderer manual: https://threejs.org/manual/en/webgpurenderer
- WebGPU migration notes (third-party, early 2026): https://www.utsubo.com/blog/webgpu-threejs-migration-guide
- WebGPU browser support (web.dev, Nov 2025): https://web.dev/blog/webgpu-supported-major-browsers
- Firefox 141 WebGPU on Windows: https://simonwillison.net/2025/Jul/16/webgpu-firefox
- gpuweb implementation status: https://github.com/gpuweb/gpuweb/wiki/implementation-status
- three-mesh-bvh: https://github.com/gkjohnson/three-mesh-bvh (npm 0.9.16 source: `MeshBVH.closestPointToPoint`)
- three-bvh-csg README two-manifold requirement (npm `three-bvh-csg@0.0.18`): https://github.com/gkjohnson/three-bvh-csg
- Babylon.js 9.0 coverage: https://www.windowsmode.com/babylon-js-9-0-released-build-immersive-3d-web-apps/
- Unity 6 web runtime (mobile browser support): https://unity.com/blog/engine-platform/web-runtime-updates-enhance-browser-experience
- Unity 6 Web technical overview (managed threads unsupported): https://docs.unity3d.com/6/Documentation/Manual/webgl-technical-overview.html
- Unity 6.6 WebGPU report (secondary, unverified): https://app.cinevva.com/news/2026-09-01-unity-6-6-webgpu-production
- Godot 4.5 web export docs: https://docs.godotengine.org/en/4.5/tutorials/export/exporting_for_web.html
- Godot web build size measurement: https://popcar.bearblog.dev/how-to-minify-godots-build-size/
- Blender 3.3 hair system / curves sculpt tools: https://wiki.blender.org/release_notes/3.3/nodes_physics/ and https://docs.blender.org/manual/en/latest/sculpt_paint/curves_sculpting/index.html
- Müller, Kim, Chentanez, *Fast Simulation of Inextensible Hair and Fur* (VRIPHYS 2012): https://diglib.eg.org/items/11db9962-07b8-46a1-ab46-ecc9ee05086d
- Toca Hair Salon 4 (parents' guide / feature overview): https://www.commonsensemedia.org/app-reviews/toca-hair-salon-4
- Womp SDF "goop" modeling in the browser: https://80.lv/articles/womp-creating-goopy-3d-models-in-your-browser/
- SculptGL: https://experiments.withgoogle.com/sculptgl
- Braid modeling: https://arxiv.org/pdf/2506.23072v1, https://graphics.pixar.com/library/Cornrows/paper.pdf, https://docs.unity3d.com/wig-docs/manual/braids.html
- Shell-based fur rendering: https://www.uni-weimar.de/en/media/chairs/computer-science-department/computer-graphics/publications/making-grass-and-fur-move/
- Web Share API, sharing files: https://web.dev/articles/files/share-files
