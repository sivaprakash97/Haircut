# Milestone 3 report: real locks you can cut, comb and style

Status: **built and tested; needs your hands-on check.** This replaces the hair clay from M1–M2 (design: [Revision 3](technical-discovery.md#r3-hair-locks-current)).

## What changed, and why

After M2 you said the scissors, comb, gel and dryer didn't behave like their real counterparts. You also said the preset hairstyles weren't what you wanted. Only Grow and Extrude felt right, and you ended up growing hair rather than styling it. Based on your answers, the hair is now:

- **One overgrown head of hair and a full beard to start from.** It's shaggy and shoulder-length at the back, with a fringe over the eyes and a thick beard. There are no preset hairstyles; the hairstyle picker is gone.
- **Chunky cartoon locks.** About 360 tapered locks on the scalp and 230 in the beard, each with an ink outline, in the Jet Set Radio / anime style.
- **Gravity and gentle sway.** Long hair hangs. When you spin the chair, it swings and fans out, then settles. Gel locks a shape in place; the dryer blows hair around.

## The tools

Keys 1–8. Any press that isn't on hair or skin spins the chair, and so does a right-drag.

| Tool | What it does |
|---|---|
| **Rotate** (1) | Drag to spin the chair (flick it and watch the hair swing); drag up/down to look from above or below. Scroll or pinch to zoom. |
| **Scissors** (2) | Swipe across locks to snip them where the blade crosses. The ends fall, slide off the shoulders and disappear. Cut ends are flat; natural tips are pointed. Hair hidden behind the head is never cut. |
| **Clippers** (3) | Rub over the head. Hair the clippers touch is cut there, and everything rooted under them is buzzed to the **Guard** length (0 = shave, up to 3 cm). |
| **Comb** (4) | Drag through hair and it follows the comb, sliding through the teeth until the tip slips out. Combed hair stays where you put it (a light set), e.g. sweep the fringe back. |
| **Grow** (5) | Hold over hair, or over bare or buzzed scalp, to grow it longer. Cut ends grow back into natural tips. |
| **Extrude** (6) | Grab hair and pull it out: it grows to reach your pointer, tapers into a point, and is gelled when you let go so it stays (spikes, flicks, wings). |
| **Gel** (7) | Brush on: hair freezes in its current shape and gets a wet shine. |
| **Dryer** (8) | Hold to blow air where you point. Hair flutters and is pushed away; held long enough, it sets the way it was blown. It also loosens gel. |

**Brush bar:** Size (`[` `]`), Strength, Guard (clippers), and **Mirror** (`M`), which applies every stroke to both sides. **Undo / Redo / Reset** are at the top right (Ctrl/⌘+Z, Shift+Ctrl/⌘+Z).

Changing quality no longer resets your hair; only the head is redrawn.

## How it works (short version)

- **Locks:** each lock is a chain of up to 21 points rooted just under the skin, so a lock can reach about 32 cm (beard about 18 cm).
- **Physics:** each lock keeps its length and is pulled down by gravity. It is also pulled gently back toward its styled shape: firmly at the root, so hair lifts off the scalp, and softly at the tip, so it swings. Gel makes the pull strong.
- **Collisions:** locks stay outside the head and shoulders, and locks rooted higher sit further out, which gives volume. Hair doesn't collide with other hair.
- **Drawing:** all locks are drawn in a single draw call, plus one for outlines. The graphics card builds the tapered tubes from a small texture of lock points, so a moving frame uploads only about 0.25 MB.
- **Idle:** when everything is still, the page stops drawing.
- **Tools and undo:**
  - Tools run on the page directly; each takes well under a millisecond (table below).
  - A stroke saves the style of each lock it touches: shape, length, gel, cut ends and colour.
  - Undo and redo restore those values exactly.

## Evidence

**Unit tests (22, Node):**
- **Starting hair:**
  - It is identical on every load and mirror-symmetric.
  - All roots are on the skin and the hair is outside the head.
  - It is long at the back (over 22 cm), with a fringe over 7 cm and a beard over 6 cm.
- **Physics:**
  - Hair settles and goes to sleep, wakes and swings when the head turns, and settles again.
  - Under hard spinning, no lock penetrates the head and segment lengths stay within 15%.
  - Gelled hair holds a shape that loose hair can't.
- **Each tool:**
  - Scissors cut the fringe, pieces fall and cut ends are blunt, while hair behind the head is untouched.
  - Clippers buzz to the guard length on both sides with Mirror.
  - The comb lifts the fringe by more than 4 cm and it stays there.
  - Grow regrows a shaved patch, with natural tips.
  - Extrude pulls hair out above the head, growing and gelling it.
  - Gel stiffens hair; the dryer moves hair, stops when released, and loosens gel.
- **History:** after 21 random strokes with every tool, undoing everything restores the exact starting checksum. Redo replays exactly, and Reset is undoable.

**Browser tests (9, headless Chromium):**
- Every tool changes the hair, and undoing all seven restores the exact start. Redo and Reset work.
- A scissors swipe across the fringe removes over 30 cm of hair in total, and the pieces fall.
- Extrude grows hair.
- Pressing on empty space or right-dragging spins the chair and never edits.
- Keyboard shortcuts work.
- The page stops drawing once the hair settles. The test checks that nothing is drawn for a full second; it caught a bug where the page kept redrawing invisibly while idle, now fixed.
- At most one frame is drawn per display frame while turning.
- The phone layout fits all 8 tools, and quality changes keep your hair.

**Costs** (single 2.1 GHz vCPU, Node; `research/bench/locks.test.ts`):

| | |
|---|---|
| Physics step, all hair moving | 0.71 ms |
| Picking what's under the pointer | 0.15 ms |
| Scissors / Clippers / Comb / Grow / Extrude / Gel / Dryer, average per frame (Mirror on) | 0.94 / 0.62 / 0.28 / 0.32 / 0.20 / 0.15 / 0.56 ms |
| Undo everything | 2.3 ms |

**Hair triangles** (589 locks, fill + outline): Light about 260k, Standard about 590k, High about 790k. Many of them are zero-area triangles past the tips of shorter locks, which the graphics card skips cheaply.

**Loading** (headless Chromium in this container, served locally): ready in **0.50–0.62 s**. The starting hair (about 0.23 s) and the head (about 0.3 s) are built side by side in two workers.

**Download:** 136 KB compressed in total, up 1 KB from M2 (budget 300 KB).

## Known limits

- **Locks don't collide with each other.** Layered offsets keep the outer hair above the inner hair, but a comb or the dryer can push one lock through another.
- **Hair you comb up without gel droops a little.** That is deliberate (hair needs product to stand up), but you may prefer stronger combing; it's one number to tune.
- **The ASUS FX505GE check is still pending.** Triangle counts are higher than with the clay. Light should be comfortable on its GTX 1050, and the speed test would confirm it.
- **Dye, curl, braids and accessories** are not in this milestone.

## Please try

1. Open the site, flick the chair with Rotate, and watch the hair swing and settle.
2. **Scissors:** swipe across the fringe just above the eyes. Then turn the head and trim the back to shoulder length.
3. **Clippers:** buzz the sides with Mirror on (`M`), then try Guard 0 to shave.
4. **Comb** the fringe up and back from the hairline. Then **Gel** it, spin the chair, and check it holds.
5. **Extrude** a few spikes on the crown, and **Grow** a buzzed patch back.
6. **Dryer:** blow at the beard and the long hair.
7. Tell me what feels wrong: how the comb grabs, how strong gravity is, lock thickness, how many locks, colours.
