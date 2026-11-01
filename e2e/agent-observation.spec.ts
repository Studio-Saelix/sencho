/**
 * The Observe Only token journey, end to end.
 *
 * An operator who wants to connect an AI client should be able to do it from
 * Settings and get a credential that reaches the five observation projections
 * and nothing else. This spec drives the create dialog in the browser, then
 * talks to the API with a cookie-free context that holds the token alone, so the
 * assertions are about the credential rather than about the browser session.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { loginAs, TEST_PASSWORD, TEST_USERNAME } from './helpers';

const STACK_NAME = 'e2e-observe';
const TOKEN_NAME = 'e2e-observe-agent';

let admin: APIRequestContext | undefined;

/**
 * An admin API context for fixture setup. Built here rather than through the
 * shared helper because that helper pins the default dev port, and this spec
 * must follow whatever base URL the runner is pointed at.
 */
async function adminApiContext(): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({
    baseURL: process.env.SENCHO_E2E_BASE_URL ?? 'http://localhost:5173',
  });
  const login = await api.post('/api/auth/login', {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed with ${login.status()}`);
  return api;
}

async function deleteTokenByName(api: APIRequestContext, name: string): Promise<void> {
  const res = await api.get('/api/api-tokens');
  if (!res.ok()) return;
  const tokens = (await res.json()) as Array<{ id: number; name: string; revoked_at: number | null }>;
  for (const token of tokens) {
    if (token.name === name && !token.revoked_at) await api.delete(`/api/api-tokens/${token.id}`);
  }
}

test.beforeAll(async () => {
  admin = await adminApiContext();
  await deleteTokenByName(admin, TOKEN_NAME);
  const priorDelete = await admin.delete(`/api/stacks/${STACK_NAME}`);
  if (!priorDelete.ok() && priorDelete.status() !== 404) {
    throw new Error(`delete prior ${STACK_NAME} failed with ${priorDelete.status()}`);
  }
  const create = await admin.post('/api/stacks', { data: { stackName: STACK_NAME } });
  if (!create.ok()) throw new Error(`create ${STACK_NAME} failed with ${create.status()}`);
});

test.afterAll(async () => {
  try {
    if (admin) {
      await deleteTokenByName(admin, TOKEN_NAME);
      await admin.delete(`/api/stacks/${STACK_NAME}`).catch(() => undefined);
    }
  } finally {
    await admin?.dispose();
  }
});

async function createObserveToken(page: Page): Promise<string> {
  // Warm the dev server once: the first navigation compiles the SPA module
  // graph, which can outlast the shared login helper's readiness window on a
  // cold or busy machine. The second navigation inside loginAs is then served
  // from Vite's transform cache.
  await page.goto('/');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await loginAs(page);
  // The Settings section is reachable by deep link, which keeps the test
  // independent of the operator's top-bar navigation mode.
  await page.goto('/nodes/local/settings/api-tokens');
  await expect(page.getByRole('button', { name: /Create token/ })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /Create token/ }).click();
  await page.getByPlaceholder('CI deploy pipeline').fill(TOKEN_NAME);

  // Scope and expiry build on the same Combobox primitive; scope them by label
  // so the shell's own comboboxes cannot be picked up instead.
  const scopeCombo = page.getByText('Permission Scope', { exact: true })
    .locator('..')
    .getByRole('combobox');
  const expiryCombo = page.getByText('Expiration', { exact: true })
    .locator('..')
    .getByRole('combobox');

  await scopeCombo.click();
  await page.getByRole('button', { name: /Observe Only/ }).click();

  // The required-expiry scope offers no "No expiration" and defaults to 90 days.
  await expect(expiryCombo).toHaveText(/90 days/);
  await expiryCombo.click();
  await expect(page.getByRole('button', { name: 'No expiration' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Create', exact: true }).click();

  const reveal = page.locator('code', { hasText: 'sen_sk_' });
  await expect(reveal).toBeVisible();
  const token = (await reveal.textContent())?.trim();
  if (!token) throw new Error('token reveal was empty');
  return token;
}

test('an Observe Only token reaches only the observation projections', async ({ page, baseURL }) => {
  const token = await createObserveToken(page);

  // A cookie-free context: the token is the only credential in play.
  const observer = await pwRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const nodes = await observer.get('/api/fleet/observation/nodes');
    expect(nodes.status()).toBe(200);
    const nodesBody = await nodes.json();
    expect(nodesBody.schemaVersion).toBe(1);
    expect(Array.isArray(nodesBody.data)).toBe(true);
    expect(Object.keys(nodesBody.data[0]).sort()).toEqual([
      'cordoned', 'id', 'lastContactAt', 'name', 'status', 'transport', 'type',
    ]);

    const health = await observer.get('/api/fleet/observation/health');
    expect(health.status()).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.schemaVersion).toBe(1);
    expect(healthBody.data.domains).not.toContain('control');
    expect(Array.isArray(healthBody.data.nodes)).toBe(true);

    const list = await observer.get('/api/stacks/platform/observation');
    expect(list.status()).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.stacks.map((s: { name: string }) => s.name)).toContain(STACK_NAME);

    const status = await observer.get(`/api/stacks/${STACK_NAME}/observation/status`);
    expect(status.status()).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.data.stack).toBe(STACK_NAME);
    expect(['ok', 'unavailable']).toContain(statusBody.data.outcome);
    expect(Array.isArray(statusBody.data.containers)).toBe(true);

    const readiness = await observer.get(`/api/stacks/${STACK_NAME}/observation/readiness`);
    expect(readiness.status()).toBe(200);
    const readinessBody = await readiness.json();
    expect(readinessBody.data.stack).toBe(STACK_NAME);
    expect(Object.keys(readinessBody.data).sort()).toEqual([
      'rollback', 'stack', 'unavailableReason', 'update',
    ]);

    // Everything a Read Only token may reach is out of this credential's reach.
    const env = await observer.get(`/api/stacks/${STACK_NAME}/env`);
    expect(env.status()).toBe(403);
    expect((await env.json()).code).toBe('SCOPE_DENIED');

    const check = await observer.get('/api/auth/check');
    expect(check.status()).toBe(403);
    expect((await check.json()).code).toBe('SCOPE_DENIED');

    // Revoking through the UI ends the credential.
    await page.reload();
    // The card row is the name's grandparent: name, badge and the icon-only
    // revoke button all live in that flex row.
    const row = page.getByText(TOKEN_NAME, { exact: true }).locator('..').locator('..');
    await row.getByRole('button').click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByText('API token revoked.')).toBeVisible();

    const afterRevoke = await observer.get('/api/fleet/observation/nodes');
    expect(afterRevoke.status()).toBe(401);
  } finally {
    await observer.dispose();
  }
});
