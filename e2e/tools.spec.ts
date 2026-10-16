import { type Page, expect, test } from '@playwright/test';

// Drives the styling tools with real mouse input. The character faces the
// camera (?yaw=0) and gestures are aimed at points on the head (head-space
// metres) converted to screen positions by the page.

test.use({ viewport: { width: 1000, height: 800 } });

async function open(page: Page, query = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`/?quality=light&yaw=0${query}`);
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  await page.getByRole('button', { name: 'Hide controls' }).click();
  await settle(page);
  page.on('close', () => expect(errors).toEqual([]));
}

const hair = (page: Page) => page.evaluate(() => window.__haircut!.hair());
const history = (page: Page) => page.evaluate(() => window.__haircut!.state().history);
const at = (page: Page, x: number, y: number, z: number) => page.evaluate(([x, y, z]) => window.__haircut!.screen(x, y, z), [x, y, z]);

/** Waits until the hair has stopped moving and nothing is falling. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__haircut!.hair().asleep && window.__haircut!.hair().falling === 0, undefined, { timeout: 120_000 });
}

async function drag(page: Page, pts: number[][], opts: { holdMs?: number; button?: 'left' | 'right' } = {}): Promise<void> {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down({ button: opts.button ?? 'left' });
  for (const [x, y] of pts.slice(1)) {
    await page.mouse.move(x, y, { steps: 6 });
    await page.waitForTimeout(60);
  }
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  await page.mouse.up({ button: opts.button ?? 'left' });
}

/** Head-space gesture: the points are aimed at on the hair or skin. */
async function gesture(page: Page, pts: number[][], opts: { holdMs?: number } = {}): Promise<void> {
  const screen = [];
  for (const p of pts) screen.push(await at(page, p[0], p[1], p[2]));
  await drag(page, screen, opts);
}

test('every tool changes the hair, and undo restores it exactly', async ({ page }) => {
  await open(page);
  const start = await hair(page);
  const steps: Array<[string, number[][], number?]> = [
    ['Scissors', [[-0.1, 0.035, 0.12], [0, 0.035, 0.12], [0.1, 0.035, 0.12]]],
    ['Clippers', [[0.05, 0.085, 0.07], [0.055, 0.06, 0.07]], 300],
    ['Comb', [[0, 0.075, 0.115], [0, 0.12, 0.06], [0, 0.135, 0]]],
    ['Grow', [[0.085, -0.01, 0.06], [0.086, -0.012, 0.06]], 800],
    ['Extrude', [[0.03, 0.11, 0.05], [0.04, 0.16, 0.05], [0.05, 0.2, 0.05]]],
    ['Gel', [[0.06, 0.04, 0.09], [0.062, 0.035, 0.09]], 400],
    ['Dryer', [[0, -0.08, 0.1], [0.004, -0.08, 0.1]], 600],
  ];
  let prev = start.checksum;
  for (const [i, [label, pts, holdMs]] of steps.entries()) {
    await page.locator('.tool', { hasText: label }).click();
    await gesture(page, pts, { holdMs });
    await page.waitForFunction((n) => window.__haircut!.state().history.undo === n, i + 1, { timeout: 30_000 });
    const now = await hair(page);
    expect(now.checksum, `${label} should change the hair`).not.toBe(prev);
    prev = now.checksum;
  }
  await settle(page);

  for (let i = steps.length; i > 0; i--) await page.keyboard.press('Control+z');
  expect((await hair(page)).checksum).toBe(start.checksum);
  expect(await history(page)).toEqual({ undo: 0, redo: steps.length });

  // Redo brings the last state back; reset returns to the start and is itself undoable.
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect((await hair(page)).checksum).not.toBe(start.checksum);
  await page.getByRole('button', { name: /^Reset/ }).click();
  expect((await hair(page)).checksum).toBe(start.checksum);
  expect((await history(page)).undo).toBe(2);
});

test('scissors snip the fringe and the cut ends fall away', async ({ page }, info) => {
  await open(page, '&tool=scissors');
  const before = await hair(page);
  await gesture(page, [[-0.1, 0.035, 0.12], [-0.03, 0.035, 0.12], [0.03, 0.035, 0.12], [0.1, 0.035, 0.12]]);
  const after = await hair(page);
  expect(after.length).toBeLessThan(before.length - 0.3); // metres of hair cut off
  expect(after.falling).toBeGreaterThan(5);
  await page.screenshot({ path: info.outputPath('falling.png') });
  await settle(page);
  await page.screenshot({ path: info.outputPath('fringe-cut.png') });
});

test('extrude pulls a spike out of the crown and it stays', async ({ page }, info) => {
  await open(page, '&tool=extrude');
  const before = await hair(page);
  const [x, y] = await at(page, 0.02, 0.11, 0.05);
  await drag(page, [[x, y], [x, y - 60], [x + 5, y - 140]]);
  await settle(page);
  const after = await hair(page);
  expect(after.length).toBeGreaterThan(before.length); // the pulled locks grew to reach
  await page.screenshot({ path: info.outputPath('spike.png') });
});

test('pressing on empty space or right-dragging turns the chair instead of editing', async ({ page }) => {
  await open(page, '&tool=comb');
  const start = await hair(page);
  const draws = await page.evaluate(() => window.__haircut!.draws());
  await drag(page, [[120, 600], [260, 560], [320, 540]]); // starts on the background
  const [x, y] = await at(page, 0.06, 0.06, 0.09);
  await drag(page, [[x, y], [x + 150, y]], { button: 'right' }); // over the hair, right button
  await page.waitForFunction(() => window.__haircut!.state().frame?.frameMs === 0, undefined, { timeout: 120_000 });
  expect(await page.evaluate(() => window.__haircut!.draws())).toBeGreaterThan(draws + 5);
  expect((await hair(page)).checksum).toBe(start.checksum);
  expect(await history(page)).toEqual({ undo: 0, redo: 0 });
});

test('number keys pick tools, brackets change the brush size, M mirrors', async ({ page }) => {
  await open(page);
  await page.keyboard.press('4');
  await expect(page.locator('.tool.on')).toContainText('Comb');
  const size = () => page.evaluate(() => window.__haircut!.state().radiusCm);
  const before = await size();
  await page.keyboard.press(']');
  expect(await size()).toBeGreaterThan(before);
  await page.keyboard.press('m');
  expect(await page.evaluate(() => window.__haircut!.state().mirror)).toBe(true);
  await page.keyboard.press('3');
  await expect(page.locator('.tool.on')).toContainText('Clippers');
  await expect(page.getByText('Guard', { exact: true })).toBeVisible();
  await page.keyboard.press('1');
  await expect(page.locator('.tool.on')).toContainText('Rotate');
});
