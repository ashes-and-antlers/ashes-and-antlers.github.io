import { expect, test } from '@playwright/test';

/**
 * Planet detail page (M1): the overview table links each known planet to a
 * dedicated ledger page that shows a procedurally generated portrait (fetched
 * from the API as PNG with the bearer token) plus the full planet detail.
 */
test('navigates from the overview to a planet ledger with a generated portrait', async ({
  page,
}) => {
  await page.goto('/game.html?seed=424242');
  await expect(page.getByTestId('commander-name')).not.toHaveText('');

  // Each row shows a small generated thumbnail portrait.
  const thumb = page.locator('img.planet-thumb').first();
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  // The home planet row links to the planet page.
  const link = page.locator('a.planet-link').first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^planet\.html\?seed=424242&planet=planet/);

  await link.click();
  await expect(page).toHaveURL(/planet\.html\?seed=424242&planet=planet/);

  // The ledger loads from the overview data.
  await expect(page.getByTestId('planet-coordinate')).toHaveText(/^\d+:\d+:\d+:\d+$/);
  await expect(page.getByTestId('planet-population')).not.toHaveText('');
  await expect(page.getByTestId('planet-faction')).toHaveText('hearth');

  // Resources render as glanceable per-resource tiles (stored + net).
  await expect(page.getByTestId('resource-stored-metal')).not.toHaveText('');
  await expect(page.getByTestId('resource-net-metal')).toHaveText(/^[+-]?\d+ \/ tick$/);

  // The pre-rendered portrait arrives as a real image.
  const portrait = page.getByTestId('planet-image');
  await expect(portrait).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const naturalWidth = await portrait.evaluate((el) => (el as HTMLImageElement).naturalWidth);
        return naturalWidth;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Back to the overview works.
  await page.getByTestId('planet-back').click();
  await expect(page).toHaveURL(/game\.html\?seed=424242/);
  await expect(page.getByTestId('commander-name')).not.toHaveText('');
});

test('shows a distinct unknown-planet state for a planet that does not exist', async ({ page }) => {
  await page.goto('/planet.html?seed=424242&planet=planet:9:9:9:9');
  // The planet detail endpoint 404s; the page shows the unknown-planet card
  // (not the offline card) with a path back to the overview.
  await expect(page.getByTestId('planet-not-found')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('planet-not-found')).toContainText('Unknown planet');
});
