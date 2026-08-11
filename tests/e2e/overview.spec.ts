import { expect, test } from '@playwright/test';

/**
 * M0 overview boot: the game page derives its world id from the seed, talks
 * to the API, and shows the authoritative tick, the next-tick countdown, the
 * world hash, and the player's home planet coordinate. The API webServer is
 * started with TICK_DURATION_MS=2000, so the tick advances live during the
 * test.
 */
test('command overview boots and shows the authoritative tick', async ({ page }) => {
  await page.goto('/game.html?seed=1337');

  // World identity from the seed.
  await expect(page.getByTestId('world-id')).toHaveText('world:1337');
  await expect(page.getByTestId('game-seed')).toHaveText('1337');

  // Home planet coordinate (galaxy:sector:system:planet) + world hash.
  await expect(page.getByTestId('home-coordinate')).toHaveText(/^\d+:\d+:\d+:\d+$/);
  await expect(page.getByTestId('world-hash')).not.toHaveText('');

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
