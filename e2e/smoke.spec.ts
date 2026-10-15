import { expect, test } from '@playwright/test';

// Loads each hairstyle, checks the page reaches "ready" without errors, and saves
// screenshots for visual review (headless Chromium uses software WebGL, so this
// checks correctness, not speed).

for (const preset of ['quiff', 'spikes', 'afro']) {
  test(`renders the ${preset} hairstyle`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?preset=${preset}&quality=light`);
    await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
    const state = await page.evaluate(() => window.__haircut!.state());
    expect(state.phase).toBe('ready');
    expect(state.frame?.triangles ?? 0).toBeGreaterThan(20_000);

    await page.waitForTimeout(500); // loader fade-out
    await page.screenshot({ path: info.outputPath(`${preset}-front.png`) });

    // Rotate to a three-quarter back view by dragging.
    const box = (await page.locator('#scene').boundingBox())!;
    await page.mouse.move(box.width * 0.6, box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.width * 0.6 + 260, box.height * 0.45, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200); // damping settles; final crisp frame
    await page.screenshot({ path: info.outputPath(`${preset}-side.png`) });

    expect(errors).toEqual([]);
  });
}

test('quality and look controls work', async ({ page }) => {
  await page.goto('/?preset=quiff&quality=light');
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  await page.getByRole('button', { name: 'Sand grain' }).click();
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await page.waitForFunction(() => window.__haircut!.state().building === false);
  await expect(page.getByRole('button', { name: 'Sand grain' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Run speed test' }).click();
  await expect(page.getByText(/fps average/)).toBeVisible({ timeout: 120_000 });
  expect(await page.evaluate(() => window.__haircut!.state().bench?.frames ?? 0)).toBeGreaterThan(0);
});

test('fits a phone screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?preset=spikes&quality=light');
  await page.waitForFunction(() => window.__haircut?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForTimeout(600); // loader fade-out
  await page.screenshot({ path: info.outputPath('phone.png') });
  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.getByRole('button', { name: 'Run speed test' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('phone-controls.png') });
});
