import { expect, test } from '@playwright/test';

/**
 * Galaxy map (world-3): the map page fetches the galaxy projection and
 * renders every planet at its deterministic position — 8 galaxies × 8
 * sectors × 8 systems × 6 planets = 3,072 worlds — with the home world
 * crowned and each dot linking to its planet ledger.
 */
test('renders the galaxy map with all worlds positioned', async ({ page }) => {
  await page.goto('/map.html?seed=424242');

  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 15_000 });

  // Header counts confirm the 8-galaxy world.
  await expect(page.getByTestId('map-galaxy-count')).toHaveText('8');
  await expect(page.getByTestId('map-planet-count')).toHaveText('3,072');

  // Every planet is a positioned dot on the map.
  await expect(page.locator('circle.map-planet')).toHaveCount(3072);

  // The home planet is crowned and is the only known (owned) world.
  await expect(page.getByTestId('map-home')).toBeVisible();
  await expect(page.getByTestId('map-known')).toHaveCount(1);

  // Zoom to the home world (dots separate), then open its ledger.
  await page.getByTestId('map-focus-home').click();
  await page.getByTestId('map-known').locator('circle.map-planet').click();
  await expect(page).toHaveURL(/planet\.html\?seed=424242&planet=planet/);
});
