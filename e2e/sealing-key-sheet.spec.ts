/**
 * Sealing key sheet in Settings, Nodes. The sheet is a discovery-gated
 * surface: with the experimental flag on, every node the session manages gets
 * a "Sealing key" button that opens the sheet; with it off, the Nodes table
 * stays as it is. The flag is read from /api/meta, so each test answers that
 * read with the flag it needs.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

async function withExperimental(page: Page, experimental: boolean): Promise<void> {
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, experimental } });
  });
}

async function openNodes(page: Page): Promise<void> {
  await loginAs(page);
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^nodes$/i }).click();
}

test.describe('Sealing key sheet', () => {
  test('shows this instance its own sealing key fingerprint', async ({ page }) => {
    await withExperimental(page, true);
    await openNodes(page);

    const status = page.waitForResponse((res) => /\/api\/nodes\/\d+\/sealing-key$/.test(res.url()) && res.request().method() === 'GET');
    await page.getByRole('button', { name: 'Sealing key' }).first().click();
    const body = await (await status).json() as { kind: string; fingerprint: string };
    expect(body.kind).toBe('local');

    const sheet = page.getByTestId('sealing-key-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('This instance\'s sealing key')).toBeVisible();
    await expect(page.getByTestId('sealing-fp-local')).toContainText(body.fingerprint);
  });

  test('keeps the Nodes table unchanged with the flag off', async ({ page }) => {
    await withExperimental(page, false);
    await openNodes(page);
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sealing key' })).toHaveCount(0);
  });
});
