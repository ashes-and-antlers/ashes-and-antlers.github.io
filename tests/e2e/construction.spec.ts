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

  // Resume: a builder walks over, works, and finishes the stockpile exactly once.
  await page.getByTestId('speed-1').click();
  await expect(page.getByTestId('alert-banner')).toContainText('finished a stockpile', {
    timeout: 15_000,
  });
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
