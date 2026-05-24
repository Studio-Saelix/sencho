/**
 * F-3 regression: creating an Empty stack via the dialog must produce a
 * compose.yaml whose host port binding is commented out, so the first
 * deploy never collides with whatever already owns the host's port 8080.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const TEST_STACK = `e2e-default-template-${Date.now()}`;

async function deleteStackViaApi(page: import('@playwright/test').Page, name: string) {
  await page.evaluate(async (stackName) => {
    await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => { });
  }, name);
}

async function readComposeViaApi(page: import('@playwright/test').Page, name: string): Promise<string> {
  return page.evaluate(async (stackName) => {
    const res = await fetch(
      `/api/stacks/${stackName}/files/content?path=compose.yaml`,
      { credentials: 'include', cache: 'no-store' }
    );
    if (!res.ok) throw new Error(`read compose failed: HTTP ${res.status}`);
    const body = (await res.json()) as { content?: string };
    if (typeof body.content !== 'string') throw new Error('compose response missing content field');
    return body.content;
  }, name);
}

test.describe('Default Empty-stack template', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
    await deleteStackViaApi(page, TEST_STACK);
  });

  test.afterEach(async ({ page }) => {
    await deleteStackViaApi(page, TEST_STACK);
  });

  test('ships with the ports block commented out so first deploy never collides on 8080', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Stack' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    await page.locator('#create-stack-name').fill(TEST_STACK);
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
    await expect(page.getByText(`Stack "${TEST_STACK}" created.`)).toBeVisible({ timeout: 5_000 });

    const compose = await readComposeViaApi(page, TEST_STACK);

    expect(compose, 'no uncommented ports: line').not.toMatch(/^(?![ \t]*#)[ \t]*ports:/m);
    expect(compose, 'no uncommented host-port mapping').not.toMatch(/^(?![ \t]*#)[ \t]*-[ \t]+["']?8080:80["']?/m);

    expect(compose, 'commented ports: hint present').toMatch(/^[ \t]*#[ \t]*ports:[ \t]*$/m);
    expect(compose, 'commented port mapping present').toMatch(/^[ \t]*#[ \t]*-[ \t]*"8080:80"[ \t]*$/m);
    expect(compose, 'commented hint sentence above the block').toMatch(/^[ \t]*#[ \t]+Uncomment to expose a host port:[ \t]*$/m);

    expect(compose, 'live image line preserved').toMatch(/^[ \t]*image:[ \t]+nginx:latest[ \t]*$/m);
    expect(compose, 'live restart line preserved').toMatch(/^[ \t]*restart:[ \t]+always[ \t]*$/m);
  });
});
