import { expect, test } from '@playwright/test';

/**
 * M0 overview boot: the game page derives its world id from the seed, talks
 * to the API, and shows the authoritative tick, the next-tick countdown, and
 * the player's home planet coordinate. The API webServer is started with
 * TICK_DURATION_MS=2000, so the tick advances live during the test.
 */
test('command overview boots and shows the authoritative tick', async ({ page }) => {
  await page.goto('/game.html?seed=424242');

  // World identity from the seed (424242 is the dedicated e2e seed — it must
  // not collide with the dev world 1337 in the shared Postgres database).
  await expect(page.getByTestId('world-id')).toHaveText('world:424242');
  await expect(page.getByTestId('game-seed')).toHaveText('424242');

  // Home planet coordinate (galaxy:sector:system:planet).
  await expect(page.getByTestId('home-coordinate')).toHaveText(/^\d+:\d+:\d+:\d+$/);

  // Player surface only: engine internals (world hash, resolution record,
  // status chips) must not render.
  await expect(page.getByTestId('world-hash')).toHaveCount(0);

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
  await expect(page.getByTestId('world-id')).toHaveText('world:424242');
});
