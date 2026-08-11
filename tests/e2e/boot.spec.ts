import { expect, test } from '@playwright/test';
import { tileScreen, workerReady } from './helpers';

const HASH_RE = /^[0-9a-f]{8}$/;

test('boots, renders the world, and shows a terrain hash', async ({ page }) => {
  await workerReady(page);

  await expect(page.locator('#map-host canvas')).toBeVisible();
  await expect(page.getByTestId('seed')).toHaveText('seed 1337');
  await expect(page.getByTestId('hash')).not.toHaveText('—');

  const hash = await page.getByTestId('hash').textContent();
  expect(hash).toMatch(HASH_RE);
});

test('same seed produces the same terrain hash across reloads', async ({ page }) => {
  await workerReady(page);
  const first = await page.getByTestId('hash').textContent();
  expect(first).toMatch(HASH_RE);

  await page.reload();
  await expect(page.getByTestId('status')).toContainText('worker ready', {
    timeout: 15_000,
  });
  const second = await page.getByTestId('hash').textContent();

  expect(second).toBe(first);
});

test('pause freezes the tick counter and speed buttons resume it', async ({ page }) => {
  await workerReady(page);

  // Let the sim run past a few ticks first.
  await expect
    .poll(async () => Number(await page.getByTestId('tick').textContent()), {
      timeout: 10_000,
    })
    .toBeGreaterThan(5);

  await page.getByTestId('speed-0').click();
  // Let the paused-state snapshot land so the readout reflects the true tick.
  await page.waitForTimeout(600);
  const frozen = Number(await page.getByTestId('tick').textContent());
  await page.waitForTimeout(800);
  expect(Number(await page.getByTestId('tick').textContent())).toBe(frozen);

  await page.getByTestId('speed-2').click();
  await expect
    .poll(async () => Number(await page.getByTestId('tick').textContent()), {
      timeout: 10_000,
    })
    .toBeGreaterThan(frozen + 4);
});

test('debug grid toggles', async ({ page }) => {
  await workerReady(page);

  const toggle = page.getByTestId('grid-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('ownership overlay toggles', async ({ page }) => {
  await workerReady(page);

  const toggle = page.getByTestId('ownership-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('clicking the map opens the inspector with tile info', async ({ page }) => {
  await workerReady(page);
  await page.waitForTimeout(400);

  // Tile (150,30) is open grass far from both factions and their buildings.
  const spot = await tileScreen(page, 150, 30);
  await page.mouse.click(spot.x, spot.y);

  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('inspector-title')).toHaveText('Tile');
  await expect(page.getByTestId('inspector-content')).toContainText('terrain');
});
