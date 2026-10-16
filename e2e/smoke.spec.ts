import { expect, test } from '@playwright/test';

// Loads the playground, checks it reaches "ready" without errors, and saves
// screenshots for visual review (headless Chromium uses software WebGL, so
// this checks correctness, not speed).

test('renders the overgrown hair and beard, and stops drawing once it settles', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?quality=light&tool=view');
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  const state = await page.evaluate(() => window.__haircut!.state());
  expect(state.phase).toBe('ready');
  expect(state.locks).toBeGreaterThan(400);
  expect(state.frame?.hairTriangles ?? 0).toBeGreaterThan(50_000);
  await page.waitForTimeout(500); // loader fade-out
  await page.screenshot({ path: info.outputPath('front.png') });

  // Spin the chair by dragging; the hair swings, then comes to rest.
  const box = (await page.locator('#scene').boundingBox())!;
  await page.mouse.move(box.width * 0.75, box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.width * 0.75 + 260, box.height * 0.58, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('spinning.png') });
  await page.waitForFunction(() => window.__haircut!.hair().asleep && window.__haircut!.state().frame?.frameMs === 0, undefined, { timeout: 120_000 });
  await page.screenshot({ path: info.outputPath('side.png') });
  const draws = await page.evaluate(() => window.__haircut!.draws());
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__haircut!.draws())).toBe(draws); // idle: nothing drawn

  expect(errors).toEqual([]);
});

test('quality and look controls work', async ({ page }) => {
  await page.goto('/?quality=light');
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  const before = await page.evaluate(() => window.__haircut!.hair().checksum);
  await page.getByRole('button', { name: 'Depth shading' }).click();
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await page.waitForFunction(() => window.__haircut!.state().building === false);
  await expect(page.getByRole('button', { name: 'Depth shading' })).toHaveAttribute('aria-pressed', 'false');
  // Changing quality redraws the head but keeps the hair as it is.
  expect(await page.evaluate(() => window.__haircut!.hair().checksum)).toBe(before);

  await page.getByRole('button', { name: 'Run speed test' }).click();
  await expect(page.getByText(/fps average/)).toBeVisible({ timeout: 120_000 });
  expect(await page.evaluate(() => window.__haircut!.state().bench?.frames ?? 0)).toBeGreaterThan(0);
});

test('fits a phone screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?quality=light');
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForTimeout(600); // loader fade-out
  await page.screenshot({ path: info.outputPath('phone.png') });
  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.getByRole('button', { name: 'Run speed test' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('phone-controls.png') });
});

test('draws at most one frame per display frame while turning', async ({ page }) => {
  await page.goto('/?quality=light&tool=view');
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.__haircut!.state().frame?.frameMs === 0, undefined, { timeout: 120_000 });
  const before = await page.evaluate(() => {
    const w = window as unknown as { __ticks: number; __stop: boolean };
    w.__ticks = 0;
    w.__stop = false;
    const tick = () => { w.__ticks++; if (!w.__stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return window.__haircut!.draws();
  });
  await page.mouse.move(900, 500);
  await page.mouse.down();
  await page.mouse.move(1100, 480, { steps: 15 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__haircut!.state().frame?.frameMs === 0, undefined, { timeout: 120_000 });
  const { ticks, after } = await page.evaluate(() => {
    const w = window as unknown as { __ticks: number; __stop: boolean };
    w.__stop = true;
    return { ticks: w.__ticks, after: window.__haircut!.draws() };
  });
  expect(after - before).toBeGreaterThan(3);
  expect(after - before).toBeLessThanOrEqual(ticks + 3);
});
