import { expect, test } from '@playwright/test';

/**
 * Dev-server (StrictMode) smoke test for the map's interaction loop.
 *
 * The other map specs run against the production build, where React
 * StrictMode's double effect-invocation is a no-op. In dev, StrictMode
 * mounts → unmounts → remounts effects on boot, which once left the paint
 * scheduler permanently dead: the map painted a single frame and then every
 * control (wheel, drag, zoom/Home/Fit buttons) silently stopped repainting
 * — no errors, no re-render, just a frozen chart. This spec runs against the
 * Vite dev server so that wiring is exercised with StrictMode active.
 */
const DEV_ORIGIN = 'http://localhost:5174';

test('map controls keep repainting under StrictMode (dev server)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${DEV_ORIGIN}/map.html?seed=424242`);
  const svg = page.getByTestId('galaxy-map');
  await expect(svg).toBeVisible({ timeout: 30_000 });

  // The canvas painted once on boot — the StrictMode remount must not leave
  // it blank.
  const painted = await page.getByTestId('map-sky').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 32) {
      if (data[i + 3] > 0 && (data[i] !== 10 || data[i + 1] !== 14 || data[i + 2] !== 20)) {
        count += 1;
      }
    }
    return count;
  });
  expect(painted).toBeGreaterThan(20);

  const viewBox = () => svg.getAttribute('viewBox');

  // Zoom button repaints the chart.
  const initial = await viewBox();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(viewBox).not.toBe(initial);

  // Dragging pans once the chart is zoomed past its fitted bounds.
  const frame = page.getByTestId('map-frame');
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const panned = await viewBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 80, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(viewBox).not.toBe(panned);

  // Wheel zoom repaints.
  const wheeled = await viewBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(viewBox).not.toBe(wheeled);

  // Fit recenters so the home galaxy is guaranteed on screen, then drilling
  // into it must repaint the galaxy level — not just swap the DOM.
  await page.getByRole('button', { name: 'Fit' }).click();
  const fitted = await viewBox();
  await page.locator('[data-testid="map-galaxy"][data-home="true"] .map-galaxy-disc').click();
  await expect(page.locator('.map-sector-cell')).toHaveCount(8);
  await expect.poll(viewBox).not.toBe(fitted);

  expect(errors).toEqual([]);
});
