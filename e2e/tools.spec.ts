import { type Page, expect, test } from '@playwright/test';

// Drives the sculpting tools with real mouse input. Positions are for a 1000×800
// viewport with the default camera (head centred, quiff above it).

test.use({ viewport: { width: 1000, height: 800 } });

async function open(page: Page, query = 'preset=quiff&quality=light'): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  await page.getByRole('button', { name: 'Hide controls' }).click();
  page.on('close', () => expect(errors).toEqual([]));
}

const field = (page: Page) => page.evaluate(() => window.__haircut!.field());
const historyCount = (page: Page) => page.evaluate(() => window.__haircut!.state().history);

async function drag(page: Page, pts: [number, number][], opts: { holdMs?: number; button?: 'left' | 'right' } = {}): Promise<void> {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down({ button: opts.button ?? 'left' });
  for (const [x, y] of pts.slice(1)) {
    await page.mouse.move(x, y, { steps: 6 });
    await page.waitForTimeout(60);
  }
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  await page.mouse.up({ button: opts.button ?? 'left' });
}

/** Waits until the last stroke has been applied (the worker replies after 'end'). */
async function settled(page: Page, undo: number): Promise<void> {
  await page.waitForFunction((n) => window.__haircut!.state().history.undo === n, undo, { timeout: 60_000 });
}

test('every tool changes the hair, and undo restores it exactly', async ({ page }) => {
  await open(page);
  const start = await field(page);
  const steps: Array<[string, () => Promise<void>]> = [
    ['Scissors', () => drag(page, [[300, 150], [500, 165], [720, 175]])],
    ['Extrude', () => drag(page, [[600, 330], [700, 300], [790, 260]])],
    ['Grow', () => drag(page, [[470, 330], [480, 330]], { holdMs: 800 })],
    ['Comb', () => drag(page, [[600, 260], [610, 300], [615, 340]])],
    ['Gel', () => drag(page, [[560, 260], [570, 270]], { holdMs: 400 })],
    ['Dryer', () => drag(page, [[700, 300], [720, 290], [700, 300]], { holdMs: 600 })],
  ];
  let prev = start.checksum;
  for (const [i, [label, act]] of steps.entries()) {
    await page.locator('.tool', { hasText: label }).click();
    await act();
    await settled(page, i + 1);
    const now = await field(page);
    expect(now.checksum, `${label} should change the hair`).not.toBe(prev);
    prev = now.checksum;
  }

  for (let i = steps.length; i > 0; i--) {
    await page.keyboard.press('Control+z');
    await settled(page, i - 1);
  }
  expect((await field(page)).checksum).toBe(start.checksum);
  expect(await historyCount(page)).toEqual({ undo: 0, redo: steps.length });

  // Redo brings the last state back; reset returns to the start and is itself undoable.
  await page.getByRole('button', { name: /^Redo/ }).click();
  await settled(page, 1);
  expect((await field(page)).checksum).not.toBe(start.checksum);
  await page.getByRole('button', { name: /^Reset/ }).click();
  await settled(page, 2);
  expect((await field(page)).checksum).toBe(start.checksum);
});

test('scissors take a piece off and it falls away', async ({ page }) => {
  await open(page, 'preset=quiff&quality=light&tool=scissors');
  const before = await field(page);
  const trisBefore = await page.evaluate(() => window.__haircut!.state().frame!.hairTriangles);
  await drag(page, [[300, 150], [500, 165], [720, 175]]);
  await settled(page, 1);
  const after = await field(page);
  expect(after.insideCells).toBeLessThan(before.insideCells - 1000); // the top of the quiff is gone
  await page.waitForFunction((t) => window.__haircut!.state().frame!.hairTriangles !== t, trisBefore);
});

test('pressing on empty space or right-dragging rotates instead of editing', async ({ page }) => {
  await open(page, 'preset=quiff&quality=light&tool=comb');
  const start = await field(page);
  const draws = await page.evaluate(() => window.__haircut!.draws());
  await drag(page, [[120, 600], [260, 560], [320, 540]]); // starts on the background
  await drag(page, [[500, 300], [650, 300]], { button: 'right' }); // over the hair, right button
  await page.waitForFunction(() => window.__haircut!.state().frame?.frameMs === 0, undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__haircut!.draws())).toBeGreaterThan(draws + 5);
  expect((await field(page)).checksum).toBe(start.checksum);
  expect(await historyCount(page)).toEqual({ undo: 0, redo: 0 });
});

test('number keys pick tools and brackets change the brush size', async ({ page }) => {
  await open(page);
  await page.keyboard.press('3');
  await expect(page.locator('.tool.on')).toContainText('Comb');
  const size = () => page.evaluate(() => window.__haircut!.state().radiusCm);
  const before = await size();
  await page.keyboard.press(']');
  expect(await size()).toBeGreaterThan(before);
  await page.keyboard.press('1');
  await expect(page.locator('.tool.on')).toContainText('Rotate');
});
