import { expect, test } from '@playwright/test';

/**
 * M0 overview boot: the game page derives its world id from the seed, talks
 * to the API, and shows the authoritative tick, the next-tick countdown, and
 * a crown pip marking the player's home planet in the known-planets list.
 * The API webServer is started with TICK_DURATION_MS=2000, so the tick
 * advances live during the test.
 */
test('command overview boots and shows the authoritative tick', async ({ page }) => {
  await page.goto('/game.html?seed=424242');

  // Player surface only: the commander identity and the home world render;
  // engine internals (world id, seed, hash, resolution record) must not.
  await expect(page.getByTestId('commander-name')).not.toHaveText('');
  await expect(page.getByTestId('world-id')).toHaveCount(0);
  await expect(page.getByTestId('game-seed')).toHaveCount(0);
  await expect(page.getByTestId('world-hash')).toHaveCount(0);

  // The home planet is marked with a crown pip in the known-planets list.
  await expect(page.getByTestId('home-planet-marker')).toHaveCount(1);

  // Every section carries an inline explainer.
  await expect(page.getByTestId('section-help-orders')).toBeVisible();
  await expect(page.getByTestId('section-help-planets')).toBeVisible();

  // The tick counter is a number and advances as the scheduler resolves.
  const tick = page.getByTestId('overview-tick');
  await expect(tick).not.toHaveText('');
  const first = await tick.textContent();
  await expect
    .poll(async () => (await tick.textContent()) !== first, {
      timeout: 15_000,
      message: 'tick should advance within the poll window',
    })
    .toBe(true);

  // Countdown is present and formatted mm:ss.
  await expect(page.getByTestId('next-tick-countdown')).toHaveText(/^\d{2}:\d{2}$/);
});

/**
 * The header action opens the navigable galaxy map, seed preserved.
 */
test('navigates to the galaxy map from the header', async ({ page }) => {
  await page.goto('/game.html?seed=424242');
  await expect(page.getByTestId('map-link')).toBeVisible();
  await page.getByTestId('map-link').click();
  await expect(page).toHaveURL(/map\.html\?seed=424242/);
  await expect(page.getByTestId('galaxy-map')).toBeVisible({ timeout: 15_000 });
});

/**
 * The footer links to a standalone glossary — the archive's vocabulary in
 * one place — and the back link returns to the overview, seed preserved.
 */
test('opens the glossary from the footer and returns', async ({ page }) => {
  await page.goto('/game.html?seed=424242');
  await expect(page.getByTestId('glossary-link')).toBeVisible();
  await page.getByTestId('glossary-link').click();
  await expect(page).toHaveURL(/glossary\.html\?seed=424242/);

  // The core terms are defined in one place.
  await expect(page.getByTestId('glossary-term-tick')).toBeVisible();
  await expect(page.getByTestId('glossary-term-abundance')).toBeVisible();
  await expect(page.getByTestId('glossary-term-upkeep')).toBeVisible();
  await expect(page.getByTestId('glossary-term-storage-cap')).toBeVisible();

  // The back link returns to the overview.
  await page.getByTestId('glossary-back').click();
  await expect(page).toHaveURL(/game\.html\?seed=424242/);
});

/**
 * Engine-unreachable path: the deployed Pages build is static (no backend),
 * so the overview must stop hammering the dead endpoint, show a clear offline
 * card, and recover via the retry button once the engine is reachable again.
 */
test('shows the offline card, stops polling, and recovers on retry', async ({ page }) => {
  let apiRequests = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/')) apiRequests += 1;
  });

  // Simulate a static deploy: every API request fails at the network layer.
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.goto('/game.html?seed=424242');

  // Three consecutive failures flip the page into the offline state.
  await expect(page.getByTestId('overview-offline')).toBeVisible({ timeout: 15_000 });

  // Polling stops: after the offline card appears, no further API requests.
  await page.waitForTimeout(3_500);
  const requestsAtOffline = apiRequests;
  await page.waitForTimeout(3_500);
  expect(apiRequests).toBe(requestsAtOffline);

  // Retry with the engine back: the overview boots normally.
  await page.unroute('**/api/**');
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('overview-tick')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('home-planet-marker')).toBeVisible();
});
