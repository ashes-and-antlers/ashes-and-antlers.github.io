import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'dev-admin-token';

/**
 * Admin dashboard (M4): the operator console gate accepts the admin bearer
 * token (never baked into the client), and the overview/worlds/players
 * surfaces render live data from the e2e API (world:424242, the 2s tick
 * world). Admin routes are gated server-side, so the wrong token is rejected
 * at the gate by a real 401.
 */
test('the gate rejects a wrong token and admits the operator token', async ({ page }) => {
  await page.goto('/admin.html');

  await expect(page.getByTestId('admin-gate')).toBeVisible();
  await page.getByTestId('admin-token-input').fill('not-the-token');
  await page.getByTestId('admin-unlock').click();

  await expect(page.getByTestId('admin-unlock')).toBeVisible();
  await expect(page.getByText('that token was rejected', { ignoreCase: true })).toBeVisible();

  await page.getByTestId('admin-token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByTestId('admin-badge')).toBeVisible();
  await expect(page.getByTestId('admin-overview')).toBeVisible();
});

test('overview shows the database tables and world counts', async ({ page }) => {
  await page.goto('/admin.html');
  await page.getByTestId('admin-token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('admin-unlock').click();

  await expect(page.getByTestId('admin-db-tables')).toBeVisible();
  await expect(page.getByTestId('db-table-worlds')).toBeVisible();
  await expect(page.getByTestId('db-table-accounts')).toBeVisible();
  await expect(page.getByTestId('db-table-tick_resolutions')).toBeVisible();
  await expect(page.getByTestId('db-table-account_sessions')).toBeVisible();
});

test('the worlds tab lists the e2e world and resolves its tick', async ({ page }) => {
  await page.goto('/admin.html');
  await page.getByTestId('admin-token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('admin-unlock').click();

  await page.getByTestId('tab-worlds').click();
  await expect(page.getByTestId('world-row-world:424242')).toBeVisible({ timeout: 15_000 });

  const tick = page.getByTestId('world-row-world:424242').locator('td').nth(2);
  const before = await tick.textContent();

  // The operator's tick trigger resolves the next beat deterministically.
  await page.getByTestId('tick-world-world:424242').click();
  await expect
    .poll(async () => (await tick.textContent()) !== before, {
      timeout: 10_000,
      message: 'the tick should advance after the operator trigger',
    })
    .toBe(true);
});

test('the worlds detail panel exposes the aggregate', async ({ page }) => {
  await page.goto('/admin.html');
  await page.getByTestId('admin-token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('admin-unlock').click();

  await page.getByTestId('tab-worlds').click();
  await page.getByTestId('world-row-world:424242').getByTestId('world-detail-world:424242').click();

  await expect(page.getByTestId('world-detail-world:424242')).toBeVisible();
  // The aggregate peek renders the seeded commander, fleets, and history.
  await expect(page.getByText('player:424242', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('world-detail-tick')).toBeVisible();
  await expect(page.getByText(/Resolution history/)).toBeVisible();
  await page.getByTestId('world-detail-back').click();
  await expect(page.getByTestId('admin-worlds')).toBeVisible();
});

test('the players tab lists the seeded commander', async ({ page }) => {
  await page.goto('/admin.html');
  await page.getByTestId('admin-token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('admin-unlock').click();

  await page.getByTestId('tab-players').click();
  await expect(page.getByTestId('admin-players')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('player-row-player:424242')).toBeVisible();
});
