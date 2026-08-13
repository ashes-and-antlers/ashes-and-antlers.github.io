import { expect, test } from '@playwright/test';

/**
 * Galaxy map (world-6): the map page is a three-level star chart. The chart
 * paints every galaxy as a seeded spiral on one canvas; opening a galaxy
 * exposes its sector hit targets; opening a sector frames its systems and
 * worlds (8 systems × 6 planets = 48 per sector). The home world is crowned
 * at every level and each world links to its ledger.
 */
test('navigates the chart → galaxy → sector hierarchy and opens a ledger', async ({ page }) => {
  await page.goto('/map.html?seed=424242');

  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 15_000 });

  // The single canvas owns the dense sky and chart paint; the DOM remains a
  // lightweight hit layer rather than thousands of SVG nodes.
  const sky = page.getByTestId('map-sky');
  await expect(sky).toBeVisible();
  const canvasInfo = await sky.evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { width: 0, height: 0, paintedPixels: 0 };
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let paintedPixels = 0;
    for (let i = 0; i < data.length; i += 4 * 32) {
      if (data[i + 3] > 0 && (data[i] !== 10 || data[i + 1] !== 14 || data[i + 2] !== 20)) {
        paintedPixels += 1;
      }
    }
    return { width: canvas.width, height: canvas.height, paintedPixels };
  });
  expect(canvasInfo.width).toBeGreaterThan(500);
  expect(canvasInfo.height).toBeGreaterThan(300);
  expect(canvasInfo.paintedPixels).toBeGreaterThan(20);

  // World-composition stats (below the chart) confirm the 8-galaxy world; the
  // header itself shows the shared commander/tick readout like every page.
  await expect(page.getByTestId('map-galaxy-count')).toHaveText('8');
  await expect(page.getByTestId('map-planet-count')).toHaveText('3,072');
  await expect(page.getByTestId('map-sector-count')).toHaveText('64');

  // Chart level: eight galaxy hit targets sit over the canvas-painted spiral
  // systems; individual worlds are intentionally not mounted at this level.
  await expect(page.locator('.map-galaxy-disc')).toHaveCount(8);
  await expect(page.locator('.map-planet')).toHaveCount(0);
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

  // The galaxy crumb is a live link from the sector view: it returns to the
  // galaxy level without re-drilling through the chart.
  await page.getByTestId('map-crumb-galaxy').click();
  await expect(page.locator('.map-sector-cell')).toHaveCount(8);
  await expect(page.getByTestId('map-crumb-sector')).toHaveCount(0);
  await expect(page.getByTestId('map-crumb-galaxy')).toHaveText(/Galaxy \d+/);

  // Back into the home sector to follow the ledger link.
  await page.locator('[data-testid="map-sector"][data-home="true"] .map-sector-cell-bg').click();
  await expect(page.locator('circle.map-planet')).toHaveCount(48);

  // Open the home planet's ledger.
  await page.getByTestId('map-known').locator('circle.map-planet').click();
  await expect(page).toHaveURL(/planet\.html\?seed=424242&planet=planet/);
});

/**
 * The map is culled per level: at the chart level no planet dots are
 * mounted (only eight galaxy hit targets), so panning never pays the
 * 3,072-DOM cost of the old single-view map.
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

  // Panning is meaningful once the chart is zoomed beyond its fitted bounds.
  await page.getByRole('button', { name: 'Zoom in' }).click();
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
  await expect(page.getByTestId('map-crumb-sector')).toBeVisible();
  await expect(page.locator('circle.map-planet')).toHaveCount(48);
});

test('wheel zoom and zoom controls change the map viewport', async ({ page }) => {
  await page.goto('/map.html?seed=424242');
  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 15_000 });
  const frame = page.getByTestId('map-frame');
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const beforeWheel = await svg.getAttribute('viewBox');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforeWheel);

  const beforeButton = await svg.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforeButton);
});
