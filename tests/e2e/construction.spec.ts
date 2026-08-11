import { expect, test } from '@playwright/test';
import { tileScreen, workerReady } from './helpers';

test('places a stockpile blueprint and builders construct it', async ({ page }) => {
  await workerReady(page);

  // Freeze the world so the site stays a blueprint while we inspect it.
  await page.getByTestId('speed-0').click();

  // Seed 1337: the Hearth command center is at tile (30,70) and tile (19,59)
  // (footprint center) lands a legal stockpile anchor at (18,58).
  const spot = await tileScreen(page, 19, 59);

  // Enter placement mode and place the stockpile on Hearth land.
  await page.getByTestId('build-stockpile').click();
  await expect(page.getByTestId('build-stockpile')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(spot.x, spot.y);

  // The placement command is applied while paused, so the site is inspectable.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('build-stockpile')).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId('inspector-title')).toContainText('blueprint', {
    timeout: 5_000,
  });
  // M2: the site needs 8 wood — the inspector shows the material cost.
  await expect(page.getByTestId('inspector-content')).toContainText('wood');

  // Resume at 8×: gatherers harvest wood, haul it home, the site funds, and a
  // builder finishes the stockpile exactly once.
  await page.getByTestId('speed-8').click();
  await expect(page.getByTestId('alert-banner')).toContainText('finished a stockpile', {
    timeout: 30_000,
  });
});

test('places a sawpit blueprint and the inspector shows its work-building detail', async ({
  page,
}) => {
  await workerReady(page);

  await page.getByTestId('speed-0').click();

  // Seed 1337: tile (22,59) (footprint center) lands a legal sawpit anchor
  // at (21,58), just east of the stockpile spot.
  const spot = await tileScreen(page, 22, 59);
  await page.getByTestId('build-sawpit').click();
  await expect(page.getByTestId('build-sawpit')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(spot.x, spot.y);

  await page.keyboard.press('Escape');
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId('inspector-title')).toContainText('Sawpit', {
    timeout: 5_000,
  });
  // M2: the sawpit costs 6 wood.
  await expect(page.getByTestId('inspector-content')).toContainText('wood');
});

test('a placement outside claimed land is rejected with a status message', async ({ page }) => {
  await workerReady(page);

  await page.getByTestId('build-hut').click();
  // Tile (151,31) is open grass far from both factions' claim radius.
  const spot = await tileScreen(page, 151, 31);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId('status')).toContainText('cannot build', {
    timeout: 5_000,
  });
});
