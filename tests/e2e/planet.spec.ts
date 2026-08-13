import { expect, test, type Page } from '@playwright/test';

/**
 * Click a catalog build button and wait for the accepted receipt, retrying
 * after a reload when a 2s tick lands between the overview fetch and the click
 * (the API rejects the stale envelope with STALE_VERSION).
 */
async function submitBuild(page: Page, testId: string, okText: string) {
  const notice = page.getByTestId('construction-notice');
  const button = page.getByTestId(testId);
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(
      async () => {
        const t = await notice.textContent();
        if (t?.includes(okText)) return true;
        if (t?.includes('STALE_VERSION')) {
          await page.reload();
          await expect(button).toBeVisible({ timeout: 15_000 });
          await expect(button).toBeEnabled();
          await button.click();
          return false;
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Planet detail page (M1): the overview table links each known planet to a
 * dedicated ledger page that shows a procedurally generated portrait (fetched
 * from the API as PNG with the bearer token) plus the full planet detail.
 */
test('navigates from the overview to a planet ledger with a generated portrait', async ({
  page,
}) => {
  await page.goto('/game.html?seed=424242');
  await expect(page.getByTestId('commander-name')).not.toHaveText('');

  // Each row shows a small generated thumbnail portrait.
  const thumb = page.locator('img.planet-thumb').first();
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  // The home planet row links to the planet page.
  const link = page.locator('a.planet-link').first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^planet\.html\?seed=424242&planet=planet/);

  await link.click();
  await expect(page).toHaveURL(/planet\.html\?seed=424242&planet=planet/);

  // The ledger loads from the overview data.
  await expect(page.getByTestId('planet-coordinate')).toHaveText(/^\d+:\d+:\d+:\d+$/);
  await expect(page.getByTestId('planet-population')).not.toHaveText('');
  // Every world has a visual class (terrestrial, gas giant…) shown under the
  // portrait — the same class the art renderer uses for its palette.
  await expect(page.getByTestId('planet-class')).not.toBeEmpty();
  await expect(page.getByTestId('planet-faction')).toHaveText('Hearth Confederacy');

  // Resources render as glanceable per-resource tiles (stored + net).
  await expect(page.getByTestId('resource-stored-metal')).not.toHaveText('');
  await expect(page.getByTestId('resource-net-metal')).toHaveText(/^[+-]?\d+ \/ tick$/);

  // Section help explains the ledger and toggles open inline.
  const help = page.getByTestId('section-help-resources');
  await expect(help.locator('.section-help-body')).toBeHidden();
  await help.locator('summary').click();
  await expect(help.locator('.section-help-body')).toBeVisible();

  // The pre-rendered portrait arrives as a real image.
  const portrait = page.getByTestId('planet-image');
  await expect(portrait).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const naturalWidth = await portrait.evaluate((el) => (el as HTMLImageElement).naturalWidth);
        return naturalWidth;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // The dossier links out to the construction desk for this world.
  const desk = page.getByTestId('planet-construction-link');
  await expect(desk).toBeVisible();
  await expect(desk).toHaveAttribute('href', /constructions\.html\?seed=424242&planet=planet/);

  // The shared nav carries the construction desk.
  await expect(page.getByTestId('nav-constructions')).toBeVisible();

  // The header navigation returns to the overview.
  await page.getByTestId('nav-overview').click();
  await expect(page).toHaveURL(/game\.html\?seed=424242/);
  await expect(page.getByTestId('commander-name')).not.toHaveText('');
});

test('raises a building through the construction queue and it completes', async ({ page }) => {
  await page.goto('/game.html?seed=424242');
  await expect(page.getByTestId('commander-name')).not.toHaveText('');

  // Open the construction desk — it defaults to the home world.
  await page.goto('/constructions.html?seed=424242');
  await expect(page.getByTestId('building-catalog')).toBeVisible({ timeout: 15_000 });

  // The e2e world persists across runs, so a specific kind can eventually hit
  // its max level (the mine has). The queue flow is what's under test, so
  // raise whichever affordable building has the fewest levels today.
  const kinds = [
    { kind: 'mine', name: 'Metal Mine' },
    { kind: 'extractor', name: 'Mineral Extractor' },
    { kind: 'farm', name: 'Farm' },
    { kind: 'reactor', name: 'Reactor' },
    { kind: 'settlement', name: 'Settlement' },
    { kind: 'storehouse', name: 'Storehouse' },
    { kind: 'lab', name: 'Research Lab' },
    { kind: 'shipyard', name: 'Shipyard' },
  ];
  const pickable: Array<{ kind: string; name: string; level: number }> = [];
  for (const k of kinds) {
    const button = page.getByTestId(`build-${k.kind}`);
    if ((await button.isVisible()) && (await button.isEnabled())) {
      const levelEl = page.getByTestId(`building-level-${k.kind}`);
      const level =
        (await levelEl.count()) > 0
          ? parseInt((await levelEl.textContent())!.replace('L', ''), 10)
          : 0;
      pickable.push({ ...k, level });
    }
  }
  expect(pickable.length).toBeGreaterThan(0);
  pickable.sort((a, b) => a.level - b.level);
  const target = pickable[0];
  await submitBuild(page, `build-${target.kind}`, target.name);

  // The accepted order appears in the construction queue as under construction
  // with a tick countdown (submitBuild already waited for the receipt).
  const queue = page.getByTestId('construction-queue');
  await expect(queue.locator('.construction-order').first()).toContainText(/tick/);

  // The building completes after its build ticks (TICK_DURATION_MS=2000 in
  // e2e): the building list gains a level row one higher than when we queued
  // it, and the queue shows the order completed. Assert the increment, never
  // an absolute level.
  const levelLabel = page.getByTestId(`building-level-${target.kind}`);
  await expect(levelLabel).toHaveText(`L${target.level + 1}`, { timeout: 30_000 });
  await expect(queue.locator('.construction-order').first()).toContainText('completed', {
    timeout: 15_000,
  });
});

test('shows a build plan that chains producers for an unaffordable building', async ({
  page,
  request,
}) => {
  // A fresh account spawns on its own virgin planet with the full starting
  // package, so the Shipyard is always beyond its store — deterministic no
  // matter how the shared e2e world has accumulated builds across runs.
  const res = await request.post('http://localhost:3101/api/v1/accounts/register', {
    data: {
      username: `plan_show_${Date.now()}`,
      password: 'e2e-password',
      name: 'Plan Warden',
      symbolId: 'hearth-crown',
    },
  });
  expect(res.status()).toBe(201);
  const { token, account } = (await res.json()) as {
    token: string;
    account: { worldId: string; homePlanetId: string };
  };

  await page.goto('/game.html?seed=424242');
  await page.evaluate(
    (session) => localStorage.setItem('ashes.session.v1', JSON.stringify(session)),
    { token, account },
  );
  await page.goto(`/constructions.html?seed=424242&planet=${account.homePlanetId}`);
  await expect(page.getByTestId('building-catalog')).toBeVisible({ timeout: 15_000 });

  // The Shipyard is far beyond the starting store, so its row offers a
  // "How to afford" plan toggle instead of a build button.
  const toggle = page.getByTestId('plan-toggle-shipyard');
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();

  // The plan spells out the producer chain, an estimate, and a caveat.
  const plan = page.getByTestId('plan-shipyard');
  await expect(plan).toBeVisible();
  await expect(plan.locator('.build-plan-summary')).toContainText(/tick/);
  const steps = plan.locator('.build-plan-steps li');
  await expect(steps.first()).toBeVisible();
  // Every step is a producer that contributes toward the cost.
  await expect(steps.first()).toContainText(/Metal Mine|Mineral Extractor|Farm|Reactor/);
  await expect(plan.locator('.build-plan-note')).toContainText(/estimate/i);

  // Toggling again collapses the plan.
  await toggle.click();
  await expect(plan).toBeHidden();
});

test('groups the building catalog by category with collapsible sections', async ({ page }) => {
  await page.goto('/game.html?seed=424242');
  await expect(page.getByTestId('commander-name')).not.toHaveText('');

  await page.goto('/constructions.html?seed=424242');

  // The catalog groups every building under the category it declares in
  // content, and each group reports how many of its buildings are affordable.
  const extraction = page.getByTestId('catalog-group-toggle-extraction');
  await expect(extraction).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('catalog-group-toggle-infrastructure')).toBeVisible();
  await expect(page.getByTestId('catalog-group-toggle-advanced')).toBeVisible();
  await expect(extraction).toContainText(/buildings · \d+ affordable/);

  // Collapsing a group hides its rows; expanding restores them.
  await extraction.click();
  await expect(extraction).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('build-mine')).toBeHidden();
  await extraction.click();
  await expect(extraction).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('build-mine')).toBeVisible();
});

test('plans a cancellation to fund the keystone producer when income is zero', async ({
  page,
  request,
}) => {
  // A fresh account spawns on its own virgin planet with the full starting
  // package, so the scenario is deterministic no matter how the shared e2e
  // world has accumulated builds across runs.
  const res = await request.post('http://localhost:3101/api/v1/accounts/register', {
    data: {
      username: `plan_${Date.now()}`,
      password: 'e2e-password',
      name: 'Plan Warden',
      symbolId: 'hearth-crown',
    },
  });
  expect(res.status()).toBe(201);
  const { token, account } = (await res.json()) as {
    token: string;
    account: { worldId: string; homePlanetId: string };
  };

  // Boot with the session so the game pages authenticate as this commander.
  await page.goto('/game.html?seed=424242');
  await page.evaluate(
    (session) => localStorage.setItem('ashes.session.v1', JSON.stringify(session)),
    { token, account },
  );
  await page.goto(`/constructions.html?seed=424242&planet=${account.homePlanetId}`);
  await expect(page.getByTestId('building-catalog')).toBeVisible({ timeout: 15_000 });

  // Spend the seed metal (100) on a Farm (50): the store drops below the Metal
  // Mine's 60 with no metal income, so the Storehouse (metal 80) is only
  // reachable by recycling the Farm's full refund.
  await submitBuild(page, 'build-farm', 'Farm');

  const toggle = page.getByTestId('plan-toggle-storehouse');
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();

  // The plan names the trade and the keystone, and restores the farm.
  const plan = page.getByTestId('plan-storehouse');
  await expect(plan).toContainText('Cancel Farm');
  await expect(plan).toContainText('Metal Mine');
  await expect(plan.locator('.build-plan-steps')).toContainText('Farm');
  // The cancel step is the first thing the plan asks for.
  await expect(plan.locator('.build-plan-steps li').first()).toContainText('Cancel Farm');
});

test('shows a distinct unknown-planet state for a planet that does not exist', async ({ page }) => {
  await page.goto('/planet.html?seed=424242&planet=planet:9:9:9:9');
  // The planet detail endpoint 404s; the page shows the unknown-planet card
  // (not the offline card) with a path back to the overview.
  await expect(page.getByTestId('planet-not-found')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('planet-not-found')).toContainText('Unknown planet');
});
