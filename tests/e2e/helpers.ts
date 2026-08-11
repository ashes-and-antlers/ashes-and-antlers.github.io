import { expect, type Page } from '@playwright/test';

/** Wait until the worker has booted and published the first snapshot. */
export async function workerReady(page: Page): Promise<void> {
  await page.goto('/game.html?seed=1337');
  await expect(page.getByTestId('status')).toContainText('worker ready', {
    timeout: 15_000,
  });
}

/**
 * Screen coordinates of a tile center, derived from the live canvas rect with
 * the same math as MapView.fitView (zoom to fit with 0.9 margin, centered).
 * The HUD treats the clicked tile as the footprint center (anchor = center-1).
 */
export async function tileScreen(
  page: Page,
  tileX: number,
  tileY: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([tx, ty]) => {
      const canvas = document.querySelector('#map-host canvas') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const W = 160 * 16;
      const H = 160 * 16;
      const zoom = Math.min((rect.width * 0.9) / W, (rect.height * 0.9) / H);
      const ox = (rect.width - W * zoom) / 2;
      const oy = (rect.height - H * zoom) / 2;
      return { x: ox + (tx * 16 + 8) * zoom, y: oy + (ty * 16 + 8) * zoom };
    },
    [tileX, tileY] as const,
  );
}
