/**
 * Detected exposure next to the declared intent, on the Stack Networking tab.
 *
 * Both stacks are saved, never deployed: the classification reads the rendered
 * Compose model, so no image pull or network is needed. A tunnel-reached
 * service and a broadly bound one show their answers; declaring `internal` on
 * the broad one shows the conflict chip, and clearing it returns to auto. A
 * lone loopback-only service reads "same host only" and offers no adoption
 * because the runtime has no running container to confirm it.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const TUNNEL_STACK = 'e2e-detected-tunnel';
const LOOPBACK_STACK = 'e2e-detected-loopback';

const TUNNEL_COMPOSE = `services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: e2e-placeholder-token
  app:
    image: nginx:alpine
    network_mode: service:cloudflared
  broad:
    image: nginx:alpine
    ports:
      - "0.0.0.0:8080:80"
    networks:
      - standalone
networks:
  standalone: {}
`;

const LOOPBACK_COMPOSE = `services:
  local:
    image: nginx:alpine
    ports:
      - "127.0.0.1:3000:80"
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

async function openNetworkingTab(page: Page, name: string): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/api/stacks/${name}/networking`) && r.request().method() === 'GET' && r.ok(),
      { timeout: 15_000 },
    ),
    page.getByTestId('networking-tab').click(),
  ]);
  await expect(page.getByTestId('networking-panel')).toBeVisible();
}

test.describe('detected exposure', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await deleteStackViaApi(page, TUNNEL_STACK);
    await deleteStackViaApi(page, LOOPBACK_STACK);
  });

  test.afterEach(async ({ page }) => {
    await deleteStackViaApi(page, TUNNEL_STACK);
    await deleteStackViaApi(page, LOOPBACK_STACK);
  });

  test('shows a tunnel and a broad bind, and a conflict once internal is declared', async ({ page }) => {
    await createStackViaApi(page, TUNNEL_STACK, TUNNEL_COMPOSE);
    await openStack(page, TUNNEL_STACK);
    await openNetworkingTab(page, TUNNEL_STACK);

    const appRow = page.getByTestId('service-intent-app');
    const broadRow = page.getByTestId('service-intent-broad');
    await expect(appRow.getByText('detected: public edge (unverified)')).toBeVisible();
    await expect(broadRow.getByText('detected: host-published')).toBeVisible();
    await expect(broadRow.getByText('→ auto (detected)')).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/stacks/${TUNNEL_STACK}/exposure`) && r.request().method() === 'PUT' && r.ok(),
        { timeout: 10_000 },
      ),
      broadRow.getByRole('button', { name: 'internal', exact: true }).click(),
    ]);
    await expect(broadRow.getByText('conflicts with internal: published port')).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/stacks/${TUNNEL_STACK}/exposure`) && r.request().method() === 'PUT' && r.ok(),
        { timeout: 10_000 },
      ),
      broadRow.getByRole('button', { name: 'inherit', exact: true }).click(),
    ]);
    await expect(broadRow.getByText('conflicts with internal: published port')).toHaveCount(0);
    await expect(broadRow.getByText('→ auto (detected)')).toBeVisible();
  });

  test('reads a loopback-only service as same host only and withholds adoption', async ({ page }) => {
    await createStackViaApi(page, LOOPBACK_STACK, LOOPBACK_COMPOSE);
    await openStack(page, LOOPBACK_STACK);
    await openNetworkingTab(page, LOOPBACK_STACK);

    const row = page.getByTestId('service-intent-local');
    await expect(row.getByText('detected: same host only')).toBeVisible();
    // No running container, so Sencho cannot confirm a loopback-only reach.
    await expect(row.getByRole('button', { name: /use same-node/i })).toHaveCount(0);
    await expect(page.getByText(/runtime not checked/)).toBeVisible();
  });
});
