import { expect, test } from '@playwright/test';
import { workerReady } from './helpers';

test('the stockpile policy panel sets reserves and reflects them', async ({ page }) => {
  await workerReady(page);

  // Defaults: food reserve from faction identity, materials start at 0.
  await expect(page.getByTestId('reserve-food')).toHaveText('50', { timeout: 5_000 });
  await expect(page.getByTestId('reserve-wood')).toHaveText('0');

  // Pause, then raise the Hearth wood reserve; the paused publish reflects it.
  await page.getByTestId('speed-0').click();
  await page.getByTestId('reserve-wood-inc').click();
  await expect(page.getByTestId('reserve-wood')).toHaveText('5', { timeout: 5_000 });

  // The panel tracks the active build faction: Iron Swarm starts at food 30.
  await page.getByTestId('build-faction').selectOption('2');
  await expect(page.getByTestId('reserve-food')).toHaveText('30', { timeout: 5_000 });
  await page.getByTestId('reserve-wood-inc').click();
  await expect(page.getByTestId('reserve-wood')).toHaveText('5', { timeout: 5_000 });

  // Lower it back to zero (floor: the minus button never goes negative).
  await page.getByTestId('reserve-wood-dec').click();
  await expect(page.getByTestId('reserve-wood')).toHaveText('0', { timeout: 5_000 });
  await page.getByTestId('reserve-wood-dec').click();
  await expect(page.getByTestId('reserve-wood')).toHaveText('0');
});
