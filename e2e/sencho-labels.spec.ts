/**
 * io.sencho.* Compose labels: the node resolves them from the rendered Compose
 * model (so interpolation and a merged override file count), and the stack view
 * reports which ones are active, ignored, or unsupported.
 *
 * Seeds its own stack and removes it afterwards. Nothing is deployed: the
 * labels are read from the Compose files, not from running containers.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const STACK = 'e2e-sencho-labels';
const COMPOSE = `services:
  web:
    image: nginx:alpine
    labels:
      io.sencho.url: https://app.example.com
      io.sencho.order: "\${WEB_ORDER:-20}"
  api:
    image: nginx:alpine
    labels:
      io.sencho.order: "10"
      io.sencho.hidden: "maybe"
      io.sencho.future: "1"
  helper:
    image: nginx:alpine
    labels:
      io.sencho.hidden: "true"
`;
const OVERRIDE = `services:
  web:
    labels:
      io.sencho.order: "5"
      io.sencho.url.docs: https://docs.example.com
`;

interface SenchoServiceLabels { links: Array<{ name: string | null; url: string }>; order: number | null; hidden: boolean }
interface SenchoResolution {
  renderable: boolean;
  services: Record<string, SenchoServiceLabels>;
  entries: Array<{ service: string; key: string; state: string }>;
  serviceOrder: string[];
}

async function seedStack(page: Page): Promise<void> {
  await page.evaluate(
    async ({ stackName, base, override }: { stackName: string; base: string; override: string }) => {
      const create = await fetch('/api/stacks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName }),
      });
      if (!create.ok && create.status !== 409) throw new Error(`create failed: ${create.status}`);
      const write = await fetch(`/api/stacks/${stackName}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: base }),
      });
      if (!write.ok) throw new Error(`write failed: ${write.status}`);
      const file = await fetch(`/api/stacks/${stackName}/files/content?path=compose.override.yaml`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: override }),
      });
      if (!file.ok) throw new Error(`override write failed: ${file.status}`);
    },
    { stackName: STACK, base: COMPOSE, override: OVERRIDE },
  );
}

async function deleteStack(page: Page): Promise<void> {
  await page.evaluate(async (stackName: string) => {
    await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, STACK);
}

async function openStack(page: Page): Promise<void> {
  await page.reload();
  await waitForStacksLoaded(page);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/stacks/${STACK}`) && r.request().method() === 'GET' && r.ok(),
      { timeout: 10_000 },
    ),
    page.getByText(STACK, { exact: true }).first().click(),
  ]);
}

test.describe('io.sencho.* labels', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await deleteStack(page);
    await seedStack(page);
  });
  test.afterEach(async ({ page }) => {
    await deleteStack(page);
  });

  test('resolves labels from the merged model: override wins, links validate, order and hidden apply', async ({ page }) => {
    const body = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/effective-anatomy`, { credentials: 'include' });
      return { ok: res.ok, json: await res.json() as { senchoLabels: SenchoResolution; serviceUrls: Record<string, string> } };
    }, STACK);
    expect(body.ok).toBe(true);
    const { senchoLabels, serviceUrls } = body.json;
    expect(senchoLabels.renderable).toBe(true);
    // The override file is merged last, so its order replaces the interpolated default.
    expect(senchoLabels.services.web.order).toBe(5);
    expect(senchoLabels.services.web.links).toEqual([
      { name: null, url: 'https://app.example.com' },
      { name: 'docs', url: 'https://docs.example.com' },
    ]);
    expect(serviceUrls).toEqual({ web: 'https://app.example.com' });
    expect(senchoLabels.services.helper.hidden).toBe(true);
    // An invalid value is ignored, so the service stays visible, and an unknown key is reported.
    expect(senchoLabels.services.api.hidden).toBe(false);
    const states = Object.fromEntries(senchoLabels.entries.filter(e => e.service === 'api').map(e => [e.key, e.state]));
    expect(states).toMatchObject({ 'io.sencho.hidden': 'invalid', 'io.sencho.order': 'active', 'io.sencho.future': 'unsupported' });
    expect(senchoLabels.serviceOrder).toEqual(['web', 'api', 'helper']);
  });

  test('the stack view lists services in label order and marks each label status', async ({ page }) => {
    await openStack(page);
    const chips = page.getByText('services', { exact: true }).locator('xpath=following-sibling::*[1]').locator('span');
    await expect(chips).toHaveText(['web', 'api', 'helper']);
    await expect(page.getByTitle('Hidden from default lists by io.sencho.hidden')).toHaveText('helper');

    await page.getByRole('tab', { name: 'Compose Labels' }).click();
    const panel = page.getByTestId('compose-labels-panel');
    await expect(panel).toBeVisible();
    const hiddenRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.hidden' }).filter({ hasText: 'maybe' });
    await expect(hiddenRow.getByTestId('label-behavior')).toHaveText('Ignored');
    await expect(hiddenRow).toContainText('Use true or false.');
    const futureRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.future' });
    await expect(futureRow.getByTestId('label-behavior')).toHaveText('Unsupported');
    const orderRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.url.docs' });
    await expect(orderRow.getByTestId('label-behavior')).toHaveText('Active');
  });
});
