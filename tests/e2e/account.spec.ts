import { expect, test } from '@playwright/test';

/**
 * Account system: the landing door opens into the account page, a commander
 * registers with a faction emblem, and the overview boots as that commander
 * (spawned server-side into the shared world). Usernames are unique per run —
 * accounts persist in the database, so a re-run must never collide.
 */
let registered: { username: string; name: string } | null = null;

test('registers a commander with a faction emblem and boots the overview', async ({ page }) => {
  const username = `e2e_${Date.now()}`;
  const name = `Warden ${username}`;
  registered = { username, name };

  // The landing enter action opens the account door.
  await page.goto('/');
  await page.getByTestId('enter-link').click();
  await expect(page).toHaveURL(/account\.html/);

  // The emblem bank renders as one flat grid (the power is auto-assigned).
  await expect(page.getByTestId('account-symbol-hearth-crown')).toBeVisible();
  await expect(page.getByTestId('account-symbol-iron-talon')).toBeVisible();

  // Pick the Blade standard, fill the ledger, and establish the archive.
  await page.getByTestId('account-symbol-iron-blade').click();
  await page.getByTestId('account-name').fill(name);
  await page.getByTestId('account-username').fill(username);
  await page.getByTestId('account-password').fill('correct horse');
  await page.getByTestId('account-confirm').fill('correct horse');
  await page.getByTestId('account-submit').click();

  // The overview boots as the new commander, wearing the chosen emblem.
  await expect(page).toHaveURL(/game\.html/);
  await expect(page.getByTestId('commander-name')).toHaveText(name, { timeout: 15_000 });
  // The chosen Blade standard rides in the header.
  await expect(page.locator('.brand-emblem')).toBeVisible();
  await expect(page.locator('.brand-emblem path')).toHaveAttribute(
    'd',
    'M24 6v14M14 16l20 4M16 22h16M16 22l-3 18M32 22l3 18',
  );

  // Returning to the account page recognises the session; sign-out clears it.
  await page.goto('/account.html');
  await expect(page.getByTestId('account-session-name')).toHaveText(name);
  await page.getByTestId('account-sign-out').click();
  await expect(page.getByTestId('account-username')).toBeVisible({ timeout: 15_000 });
});

test('logs in with the registered session', async ({ page }) => {
  expect(registered, 'register test must run first').not.toBeNull();
  await page.goto('/account.html');
  await page.getByTestId('account-tab-login').click();

  // A wrong password is rejected with one indistinguishable error.
  await page.getByTestId('account-username').fill(registered!.username);
  await page.getByTestId('account-password').fill('wrong password');
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-error')).toBeVisible();

  // The right password returns the commander to the overview.
  await page.getByTestId('account-password').fill('correct horse');
  await page.getByTestId('account-submit').click();
  await expect(page).toHaveURL(/game\.html/);
  await expect(page.getByTestId('commander-name')).toHaveText(registered!.name, {
    timeout: 15_000,
  });
});

test('control panel renames the commander, swaps the emblem, and changes the password', async ({
  page,
}) => {
  expect(registered, 'register test must run first').not.toBeNull();
  await page.goto('/account.html');
  await page.getByTestId('account-tab-login').click();
  await page.getByTestId('account-username').fill(registered!.username);
  await page.getByTestId('account-password').fill('correct horse');
  await page.getByTestId('account-submit').click();
  await expect(page).toHaveURL(/game\.html/);
  await page.goto('/account.html');
  await expect(page.getByTestId('cp-account-username')).toHaveText(registered!.username);
  await expect(page.getByTestId('cp-name')).toHaveValue(registered!.name);
  await expect(page.getByTestId('cp-faction')).not.toHaveText('');

  // Rename the commander and swap the Blade standard for the Crown.
  await page.getByTestId('cp-name').fill('Warden Renamed');
  await page.getByTestId('cp-emblem-hearth-crown').click();
  await page.getByTestId('cp-profile-save').click();
  await expect(page.getByTestId('cp-profile-notice')).toHaveText('Profile saved.');
  await expect(page.getByTestId('account-session-name')).toHaveText('Warden Renamed');
  // The header now wears the Crown, and the world aggregate knows the new name.
  await expect(page.locator('.brand-emblem path')).toHaveAttribute(
    'd',
    'M8 20l8 6 8-10 8 10 8-6v14H8z',
  );

  // Change the password and sign every other device out.
  await page.getByTestId('cp-current-password').fill('correct horse');
  await page.getByTestId('cp-new-password').fill('fresh horse');
  await page.getByTestId('cp-confirm-password').fill('fresh horse');
  await page.getByTestId('cp-revoke-others').check();
  await page.getByTestId('cp-password-submit').click();
  await expect(page.getByTestId('cp-password-notice')).toHaveText(/Password changed/);

  // The old password is dead; the new one signs the renamed commander in.
  await page.getByTestId('account-sign-out').click();
  await expect(page.getByTestId('account-username')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('account-tab-login').click();
  await page.getByTestId('account-username').fill(registered!.username);
  await page.getByTestId('account-password').fill('correct horse');
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-error')).toBeVisible();
  await page.getByTestId('account-password').fill('fresh horse');
  await page.getByTestId('account-submit').click();
  await expect(page).toHaveURL(/game\.html/);
  await expect(page.getByTestId('commander-name')).toHaveText('Warden Renamed', {
    timeout: 15_000,
  });
});

test('account page clears a stale session and explains why the door is showing', async ({
  page,
}) => {
  // Seed a persisted session whose token the archive no longer knows, once.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('stale-account-seeded')) return;
    sessionStorage.setItem('stale-account-seeded', '1');
    localStorage.setItem(
      'ashes.session.v1',
      JSON.stringify({
        token: 'sess_stale_invalid_token',
        account: {
          id: 'acc_stale',
          username: 'stale_warden',
          name: 'Stale Commander',
          factionId: 'hearth',
          symbolId: 'hearth-crown',
          worldId: 'world:1337',
          playerId: 'player:stale',
          homePlanetId: 'planet:1:1:1:1',
          createdAt: 1,
        },
      }),
    );
  });
  await page.goto('/account.html');

  // The door shows, with a clear reason instead of a silent register/login.
  await expect(page.getByTestId('account-session-notice')).toContainText(/signed out or expired/);
  await expect(page.getByTestId('account-username')).toBeVisible();

  // The invalid session was cleared so a reload lands on the same door.
  const remaining = await page.evaluate(() => localStorage.getItem('ashes.session.v1'));
  expect(remaining).toBeNull();
});
