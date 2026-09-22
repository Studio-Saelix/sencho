/**
 * GitOps workplace: the hub-owned portfolio destination.
 *
 * Covers the navigation contract the surface promises (first-class launcher
 * entry, direct URL), the masthead-led render, and the filter interaction. The
 * suite does not assert portfolio contents: CI starts from a fresh database,
 * so the meaningful assertions here are structural (the view resolves without
 * a stack or a node's GitOps state) while row-level classification is pinned
 * by the backend unit suites.
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

    // Masthead: kicker + verdict, on its own hub-owned surface.
    await expect(page.getByText('GITOPS · PORTFOLIO')).toBeVisible({ timeout: 10_000 });
    // The summary strip is portfolio-level, independent of which rows exist.
    await expect(page.getByText('Applications', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Attention', { exact: true }).first()).toBeVisible();

    // Either the table or the empty state renders; both are the surface
    // answering rather than bouncing to another view.
    const table = page.getByRole('region', { name: 'GitOps applications' });
    await expect(table).toBeVisible({ timeout: 10_000 });
  });

  test('filter chips narrow the list and clear restores it', async ({ page }) => {
    await loginAs(page);
    await page.goto('/nodes/local/gitops');
    await waitForShellReady(page);
    await expect(page.getByText('GITOPS · PORTFOLIO')).toBeVisible({ timeout: 10_000 });

    const attentionChip = page.getByRole('button', { name: 'Attention', exact: true }).first();
    await expect(attentionChip).toHaveAttribute('aria-pressed', 'false');
    await attentionChip.click();
    await expect(attentionChip).toHaveAttribute('aria-pressed', 'true');

    const clear = page.getByRole('button', { name: /Clear/ }).first();
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(attentionChip).toHaveAttribute('aria-pressed', 'false');
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
