/**
 * GitOps workplace: the hub-owned portfolio destination.
 *
 * Covers the navigation contract the surface promises (first-class launcher
 * entry, direct URL), the masthead-led render, the shared filter row
 * (collapsible search + combobox filters), and the phone layout. The suite
 * does not assert portfolio contents: CI starts from a fresh database, so the
 * meaningful assertions here are structural while row-level classification is
 * pinned by the backend unit suites.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForShellReady } from './helpers';

test.describe('GitOps workplace', () => {
  test('is reachable from the launcher as a first-class destination', async ({ page }) => {
    await loginAs(page);
    await page.getByRole('button', { name: 'Open navigation launcher' }).click();
    const panel = page.getByRole('menu').filter({ has: page.getByText('Navigate', { exact: true }) });
    await expect(panel.getByText('GitOps', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('renders the portfolio at its own URL', async ({ page }) => {
    await loginAs(page);
    await page.goto('/nodes/local/gitops');
    await waitForShellReady(page);

    // The filter row is the surface's stable landmark (the masthead's state
    // word varies with what is in the portfolio).
    await expect(page.getByRole('button', { name: 'Search applications' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'GitOps applications' })).toBeVisible({ timeout: 10_000 });
    // The count tiles live in the masthead, independent of which rows exist.
    await expect(page.getByText('APPLICATIONS', { exact: true })).toBeVisible();
  });

  test('combobox filters narrow the list and reset through the same control', async ({ page }) => {
    await loginAs(page);
    await page.goto('/nodes/local/gitops');
    await waitForShellReady(page);

    // The shared Combobox trigger carries role="combobox" (an author-named
    // widget role), so target it by role plus its visible label text.
    const attentionFilter = page.locator('button[role="combobox"]').filter({ hasText: 'All applications' });
    await expect(attentionFilter).toBeVisible({ timeout: 10_000 });
    await attentionFilter.click();
    await page.getByRole('button', { name: 'Attention required' }).click();
    await expect(page).toHaveURL(/attention=1/);

    // Resetting through the same control returns the question to the whole set.
    await page.locator('button[role="combobox"]').filter({ hasText: 'Attention required' }).click();
    await page.getByRole('button', { name: 'All applications' }).click();
    await expect(page).not.toHaveURL(/attention=1/);
  });

  test('the search accordion expands, filters, and collapses when cleared', async ({ page }) => {
    await loginAs(page);
    await page.goto('/nodes/local/gitops');
    await waitForShellReady(page);

    await page.getByRole('button', { name: 'Search applications' }).click();
    const input = page.getByPlaceholder('Search applications...');
    await expect(input).toBeVisible();
    await input.fill('no-such-application-anywhere');
    await expect(page).toHaveURL(/q=no-such-application-anywhere/);
    await expect(page.getByText('No GitOps application matches the current filters.')).toBeVisible({ timeout: 10_000 });

    await input.fill('');
    await input.blur();
    await expect(input).toBeHidden();
  });

  test('the phone layout keeps the workplace readable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page);
    await page.goto('/nodes/local/gitops');
    // No shell-ready probe here: bespoke phone screens drop the global TopBar,
    // so the masthead's own kicker is the readiness signal.
    await expect(page.getByText('GITOPS · PORTFOLIO')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder('Search applications')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attention', exact: true }).first()).toBeVisible();
  });
});
