# Milestone 2 report: dragging tools that genuinely change the hair

Status: **built and tested; needs your hands-on check.**

## What you can do now

Pick a tool from the bar at the bottom (keys **1–7**), then drag on the hair:

| Tool | What it does to the hair clay |
|---|---|
| **Rotate** (1) | Turns the head. Selected when the page opens, so a first drag never edits by accident. |
| **Scissors** (2) | Swipe across hair, even starting outside it. The blade cuts through all the hair along the swipe and stops at the scalp. Anything no longer attached to the scalp **breaks off and tumbles away**. |
| **Comb** (3) | Drag along the hair to push the clay with your stroke. |
| **Grow** (4) | Hold or drag to build hair up, also on bare scalp. |
| **Extrude** (5) | Press on hair and pull outward to draw out a spike, previewed live as you drag. Pulled spikes come out gelled. |
| **Gel** (6) | Hair holds its shape and gets a glossy, wet-look highlight. |
| **Dryer** (7) | Hair loosens: it sags (more the further it is from the scalp), crumbles a little, and goes matte and grainy like dry sand. |

- **Brush bar:** Size (0.8–5 cm, or `[` `]`), Strength, and **Mirror** (`M`), which applies every stroke to both sides of the face.
- **Undo / Redo / Reset:** top right, or Ctrl/⌘+Z and Shift+Ctrl/⌘+Z. Reset is undoable too.
- **Rotating while a tool is selected:** right-drag, or drag on empty space. Scroll or pinch to zoom.
- **The mouth** is now a crisp line, as asked after M1.

## How it works

- **Strokes:** every stroke is processed off the main thread, in the worker that owns the hair grid. The page sends at most one stroke update per frame, always the latest pointer position, so the camera and UI stay at 60 fps however heavy an edit is.
- **Undo:** each stroke copies an 8×8×8 block of cells the first time it touches it. Undo and redo restore exact bytes, and history is capped by memory (64 MB), not step count.
- **Mesh updates:** only the blocks a stroke changed are re-meshed, and the page updates only the affected render chunks, reusing GPU buffers.
- **Scissors:** cuts are thin slices between successive view rays. Fast swipes are split into thin pieces so each gets the right depth. When you release, a flood fill from the scalp finds any loose piece; it's removed (undoably) and animated falling away.

## Evidence

**Unit tests (19, Node).** The editing guarantees:
- **Exact undo:** after 40 random strokes across all six tools, undoing everything restores the starting bytes, and redo replays them exactly.
- **Partial rebuilds match:** after 30 strokes with undos mixed in, re-meshing only the changed blocks equals a full rebuild, block for block.
- **No broken geometry:** after 40 random edits the surface has no holes (every edge has its twin) and never goes inside the head.
- **Each tool:** scissors cut off a spike and undo restores it; grow works on bare scalp; comb moves material forward; the extrude preview replaces itself; dried material sags while gelled material holds.

**Browser tests (10, headless Chromium):**
- Every tool changes the hair, measured by a checksum of the hair grid. Undoing all six restores the exact starting checksum, and redo and reset work.
- A scissors swipe above the head removes the top of the quiff (over 1,000 cells of material).
- Pressing on empty space or right-dragging rotates the view and never edits.
- Keyboard shortcuts work.
- The M1 checks still pass: three hairstyles, the phone layout, and no runaway render loops.

**Background-thread cost per frame** (single 2.1 GHz vCPU, Node; 2 cm brush, quiff; tool operation plus re-meshing):

| Tool | Light (4 mm) | Standard (3 mm) | High (2.5 mm) |
|---|---|---|---|
| Grow | 4.7 ms | 4.2 ms | 5.3 ms |
| Comb | 3.4 ms | 6.0 ms | 5.3 ms |
| Gel | 3.9 ms | 3.2 ms | 3.6 ms |
| Dryer | 4.8 ms | 4.3 ms | 7.5 ms |
| Extrude (live preview) | 13 ms | 19 ms | 24 ms |
| Scissors (per swipe step) | 9.7 ms | 7.9 ms | 10.6 ms |
| Scissors release (find and remove loose pieces) | 42 ms | 70 ms | 78 ms |
| Undo | 8–61 ms | 13–36 ms | 12–37 ms |

These times are spent off the main thread. Most tools update the hair at 60 times a second or close to it. Extrude updates 40–75 times a second, and the one-off scissors release takes under 0.1 s.

**Download:** 134.8 KB compressed in total, up 10 KB from M1 (budget 300 KB).

## Known limits and next steps

- **Extrude is the heaviest tool,** because it re-stamps the whole spike each frame. Fine on laptops; it could be optimized later.
- **Two-finger gestures on touch screens:** a second finger ends the current stroke rather than turning into a pinch mid-stroke. Lift and pinch again.
- **The hair has no strand or groove detail yet.** Flow-aligned grooves are planned with the comb and hair-type work (M3–M4).
- **ASUS FX505GE check is still pending** from M1. The speed test plus a few strokes on it would confirm the low end.

## Please try

1. Open the site, pick **Scissors**, and swipe across the top of the quiff from one side to the other. The top should fall away.
2. **Extrude** a few spikes, **Gel** one, **Dry** another, and compare how they look and behave.
3. Try **Mirror** with Grow or Extrude for symmetrical styles.
4. Undo all the way back, or press Reset.
5. Tell me what feels wrong: tool speeds, sizes, how the scissors cut, how the clay moves.
