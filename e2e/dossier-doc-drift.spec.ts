/**
 * Documentation drift in the Stack Dossier.
 *
 * The Dossier tab warns when a port written into access_urls is not published by
 * the stack's compose. The visual-regression project does not cover the
 * stack-detail surface, so this functional flow does. It seeds its own stack and
 * compose with a known published port and cleans them up, and does not need a
 * running Docker daemon: documentation drift compares the dossier against the
 * compose-derived anatomy, not the runtime.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const STACK = 'e2e-doc-drift-test';
const COMPOSE = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;

async function createStackViaApi(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(
    async ({ stackName, body }: { stackName: string; body: string }) => {
      const createRes = await fetch('/api/stacks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName }),
      });
      if (!createRes.ok && createRes.status !== 409) throw new Error(`create failed: ${createRes.status}`);
      const writeRes = await fetch(`/api/stacks/${stackName}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body }),
      });
      if (!writeRes.ok) throw new Error(`write failed: ${writeRes.status}`);
    },
    { stackName: name, body: content },
  );
}

async function seedDossierAccessUrls(page: Page, name: string, accessUrls: string): Promise<void> {
  await page.evaluate(
    async ({ stackName, urls }: { stackName: string; urls: string }) => {
      const res = await fetch(`/api/stacks/${stackName}/dossier`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_urls: urls }),
      });
      if (!res.ok) throw new Error(`dossier seed failed: ${res.status}`);
    },
    { stackName: name, urls: accessUrls },
  );
}

async function deleteStackViaApi(page: Page, name: string): Promise<void> {
  await page.evaluate(async (stackName: string) => {
    await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, name);
}

async function openStack(page: Page, name: string): Promise<void> {
  await page.reload();
  await waitForStacksLoaded(page);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/stacks/${name}`) && r.request().method() === 'GET' && r.ok(),
      { timeout: 10_000 },
    ),
    page.getByText(name, { exact: true }).first().click(),
  ]);
}

test.describe('Dossier documentation drift', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await deleteStackViaApi(page, STACK);
  });
  test.afterEach(async ({ page }) => {
    await deleteStackViaApi(page, STACK);
  });

  test('warns for an unpublished access-URL port and clears when it matches', async ({ page }) => {
    await createStackViaApi(page, STACK, COMPOSE);
    await openStack(page, STACK);
    // Wait for the dossier GET to land before typing: it resolves by setting
    // `fields` from the server (empty access_urls) and only then flips the
    // doc-drift gate on, so a fill that races ahead of it would be overwritten.
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/stacks/${STACK}/dossier`) && r.request().method() === 'GET' && r.ok(),
        { timeout: 10_000 },
      ),
      page.getByRole('tab', { name: 'Dossier' }).click(),
    ]);
    await expect(page.getByTestId('dossier-panel')).toBeVisible();

    const field = page.getByTestId('dossier-field-access_urls');
    await field.fill('http://localhost:9000');
    const warning = page.getByTestId('dossier-doc-drift');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(':9000');

    // Point the URL at the published port: the warning must clear.
    await field.fill('http://localhost:8080');
    await expect(page.getByTestId('dossier-doc-drift')).toHaveCount(0);
  });

  test('shows the warning on the read-only mobile dossier', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createStackViaApi(page, STACK, COMPOSE);
    await seedDossierAccessUrls(page, STACK, 'http://localhost:9000');
    await openStack(page, STACK);
    await page.getByRole('tab', { name: 'Compose' }).click();
    await page.getByRole('tab', { name: 'Dossier' }).click();
    const warning = page.getByTestId('dossier-doc-drift');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(':9000');
  });
});
