import { expect, test } from '@playwright/test';

/**
 * Galaxy map (world-4): the map page is a three-level star chart. The chart
 * shows every galaxy as a disc with its sectors dotted along the spiral
 * arms; opening a galaxy frames its sector cells; opening a sector frames
 * its systems and worlds (8 systems × 6 planets = 48 per sector). The home
 * world is crowned at every level and each world links to its ledger.
 */
test('navigates the chart → galaxy → sector hierarchy and opens a ledger', async ({ page }) => {
  await page.goto('/map.html?seed=424242');

  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 15_000 });

  // Header counts confirm the 8-galaxy world.
  await expect(page.getByTestId('map-galaxy-count')).toHaveText('8');
  await expect(page.getByTestId('map-planet-count')).toHaveText('3,072');
  await expect(page.getByTestId('map-sector-count')).toHaveText('64');

  // Chart level: every galaxy is a disc with sector dots on its spiral arms.
  await expect(page.locator('.map-galaxy-disc')).toHaveCount(8);
  await expect(page.locator('.map-sector-dot')).toHaveCount(64);
  await expect(page.getByTestId('map-home-galaxy')).toBeVisible();

  // Drill into the home galaxy: its sector cells appear, home sector ringed.
  await page.locator('[data-testid="map-galaxy"][data-home="true"] .map-galaxy-disc').click();
  await expect(page.locator('.map-sector-cell')).toHaveCount(8);
  await expect(page.getByTestId('map-home-sector')).toBeVisible();

  // Drill into the home sector: 48 worlds (8 systems × 6 planets), home
  // planet crowned + known.
  await page.locator('[data-testid="map-sector"][data-home="true"] .map-sector-cell-bg').click();
  await expect(page.locator('circle.map-planet')).toHaveCount(48);
  await expect(page.getByTestId('map-home')).toBeVisible();
  await expect(page.getByTestId('map-known')).toHaveCount(1);

  // The breadcrumb reflects where we are.
  await expect(page.getByTestId('map-crumb-sector')).toHaveText(/Sector \d+:\d+/);

  // Open the home planet's ledger.
  await page.getByTestId('map-known').locator('circle.map-planet').click();
  await expect(page).toHaveURL(/planet\.html\?seed=424242&planet=planet/);
});

/**
 * The map is culled per level: at the chart level no planet dots are
 * rendered (only discs and sector dots), so panning never pays the 3,072-DOM
 * cost of the old single-view map.
 */
test('chart level does not render individual planets', async ({ page }) => {
  await page.goto('/map.html?seed=424242');
  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('circle.map-planet')).toHaveCount(0);
});

/**
 * Dragging pans the map without breaking click-through: the frame is the
 * drag surface, planet dots remain clickable after a drag settles.
 */
test('dragging pans the chart and clicks still land on targets', async ({ page }) => {
  await page.goto('/map.html?seed=424242');
  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 15_000 });
  const frame = page.getByTestId('map-frame');
  const before = await svg.getAttribute('viewBox');

  // Pan by dragging across the frame.
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 80, {
      steps: 8,
    });
    await page.mouse.up();
  }

  // The viewBox moved (the chart panned) — not left at the fitted start.
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(before);

  // Drill-in still works after a drag: Home opens the home sector viewport
  // (the sector view, not the chart).
  await page.getByTestId('map-focus-home').click();
  await expect(page.locator('.map-sector-view')).toBeVisible();
  await expect(page.locator('circle.map-planet')).toHaveCount(48);
});
