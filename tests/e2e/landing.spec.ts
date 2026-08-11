import { expect, test } from '@playwright/test';

test('landing page centers the logo as the title and offers the enter action', async ({ page }) => {
  await page.goto('/');

  // The logo carries the wordmark: it is the h1 and its alt text is the title.
  await expect(page.getByTestId('landing-title')).toBeVisible();
  await expect(page.getByTestId('landing-title')).toHaveRole('heading');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('landing-title').getByRole('img')).toHaveAttribute(
    'alt',
    /Ashes and Antlers/i,
  );

  // The mark is dead-center in the viewport (scrollbar-agnostic: compare
  // against the layout-viewport center, which includes any classic scrollbar).
  const centerOffset = await page.evaluate(() => {
    const rect = document.querySelector('.cover-crest')!.getBoundingClientRect();
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const layoutCenter = (window.innerWidth + scrollbar) / 2;
    return Math.abs(rect.left + rect.width / 2 - layoutCenter);
  });
  expect(centerOffset).toBeLessThan(4);

  // No nav, no seed controls, no map previews — just the primary action.
  await expect(page.locator('header')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByTestId('enter-link')).toBeVisible();
});
