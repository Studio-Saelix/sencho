/**
 * io.sencho.update and io.sencho.notify.route, end to end.
 *
 * The stacks are seeded and never deployed: the policy is read from the rendered
 * Compose model, so no container is needed to prove a refusal, a bulk skip, or
 * the activity row a skip writes. Where a surface is a dialog, the API answer
 * that drives it is asserted too, so a regression that keeps the dialog happy but
 * lets the route mutate the stack fails here.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const STACK = 'e2e-label-policy';
const COMPOSE = `services:
  web:
    image: nginx:alpine
    labels:
      io.sencho.update: manual
      io.sencho.notify.route: production
  db:
    image: postgres:16-alpine
    labels:
      io.sencho.update: disabled
  cache:
    image: redis:7-alpine
`;

const INVALID_STACK = 'e2e-label-policy-invalid';
const INVALID_COMPOSE = `services:
  web:
    image: nginx:alpine
    labels:
      io.sencho.update: off
      io.sencho.notify.route: https://example.test/hook
`;

interface AnatomyLabels {
  senchoLabels: {
    renderable: boolean;
    services: Record<string, { update: string | null; notifyRoute: string | null }>;
  };
}

interface ReadinessReport {
  verdict: string;
  signals: Array<{ id: string; status: string; detail: string; affectsVerdict: boolean }>;
  updatePolicy?: {
    evaluation: string;
    manualDecision: string;
    unattendedDecision: string;
    services: Array<{ service: string; policy: string; eligible: boolean }>;
    reason: string | null;
  };
}

async function seed(page: Page, stackName: string, content: string): Promise<void> {
  await page.evaluate(async ({ stackName, content }: { stackName: string; content: string }) => {
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
      body: JSON.stringify({ content }),
    });
    if (!write.ok) throw new Error(`write failed: ${write.status}`);
  }, { stackName, content });
}

async function remove(page: Page, stackName: string): Promise<void> {
  await page.evaluate(async (name: string) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, stackName);
}

test.describe('io.sencho.update and io.sencho.notify.route', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await remove(page, STACK);
    await remove(page, INVALID_STACK);
    await seed(page, STACK, COMPOSE);
    await seed(page, INVALID_STACK, INVALID_COMPOSE);
  });

  test.afterEach(async ({ page }) => {
    await remove(page, STACK);
    await remove(page, INVALID_STACK);
  });

  test('resolves both labels from the rendered model, and an invalid value as invalid', async ({ page }) => {
    const anatomy = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/effective-anatomy`, { credentials: 'include' });
      return (await res.json()) as AnatomyLabels;
    }, STACK);

    expect(anatomy.senchoLabels.renderable).toBe(true);
    expect(anatomy.senchoLabels.services.web).toMatchObject({ update: 'manual', notifyRoute: 'production' });
    expect(anatomy.senchoLabels.services.db.update).toBe('disabled');
    expect(anatomy.senchoLabels.services.cache.update).toBeNull();

    const invalid = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/effective-anatomy`, { credentials: 'include' });
      return (await res.json()) as AnatomyLabels;
    }, INVALID_STACK);
    // An unrecognized value is not absent: it restricts unattended updates.
    expect(invalid.senchoLabels.services.web.update).toBe('invalid');
    // A URL-shaped routing key is ignored rather than used as a destination.
    expect(invalid.senchoLabels.services.web.notifyRoute).toBeNull();
  });

  test('readiness reports the policy without changing the verdict, and refuses the update', async ({ page }) => {
    const report = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/update-readiness`, { credentials: 'include' });
      return (await res.json()) as ReadinessReport;
    }, STACK);

    const signal = report.signals.find(s => s.id === 'update_policy');
    expect(signal).toBeDefined();
    expect(signal?.status).toBe('attention');
    expect(signal?.affectsVerdict).toBe(false);
    expect(report.updatePolicy).toMatchObject({ manualDecision: 'block', unattendedDecision: 'skip' });
    expect(report.updatePolicy?.services.find(s => s.service === 'db')).toMatchObject({ eligible: false });

    const refused = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { status: res.status, body: await res.json() as { code?: string; error?: string } };
    }, STACK);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('update_policy_blocked');
    expect(refused.body.error).toContain('io.sencho.update');
  });

  test('pull images is refused with the same code', async ({ page }) => {
    const refused = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/pull-images`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      return { status: res.status, body: await res.json() as { code?: string } };
    }, STACK);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('update_policy_blocked');
  });

  test('a bulk update reports the policy skip per stack instead of updating it', async ({ page }) => {
    const result = await page.evaluate(async (stackName: string) => {
      const res = await fetch('/api/stacks/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', stackNames: [stackName] }),
      });
      return await res.json() as { results: Array<{ stackName: string; ok: boolean; code?: string; error?: string }> };
    }, STACK);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ stackName: STACK, ok: false, code: 'update_policy_skipped' });
    expect(result.results[0].error).toContain('io.sencho.update');
  });

  test('the refusal writes one read update-policy activity row, and a second refusal does not add another', async ({ page }) => {
    await page.evaluate(async (stackName: string) => {
      for (let i = 0; i < 2; i += 1) {
        await fetch(`/api/stacks/${stackName}/update`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
      }
    }, STACK);

    const activity = await page.evaluate(async (stackName: string) => {
      const res = await fetch(`/api/stacks/${stackName}/activity?limit=50`, { credentials: 'include' });
      return await res.json() as { events?: Array<{ category?: string; is_read: boolean; message: string }> };
    }, STACK);

    const rows = (activity.events ?? []).filter(row => row.category === 'update_policy');
    expect(rows).toHaveLength(1);
    expect(rows[0].is_read).toBe(true);
    expect(rows[0].message).toContain('db (disabled)');
  });

  test('the Compose Labels tab shows both labels and their states', async ({ page }) => {
    await page.reload();
    await waitForStacksLoaded(page);
    await Promise.all([
      page.waitForResponse(
        r => r.url().endsWith(`/api/stacks/${STACK}`) && r.request().method() === 'GET' && r.ok(),
        { timeout: 10_000 },
      ),
      page.getByText(STACK, { exact: true }).first().click(),
    ]);
    await page.getByRole('tab', { name: 'Compose Labels' }).click();

    const panel = page.getByTestId('compose-labels-panel');
    await expect(panel).toBeVisible();
    const updateRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.update' }).filter({ hasText: 'manual' });
    await expect(updateRow.getByTestId('label-behavior')).toHaveText('Active');
    const routeRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.notify.route' }).filter({ hasText: 'production' });
    await expect(routeRow.getByTestId('label-behavior')).toHaveText('Active');
    await expect(routeRow).toContainText('routing rules of the instance that runs this stack');
  });

  test('a routing rule keeps its normalized keys, and refuses an address-shaped one', async ({ page }) => {
    const created = await page.evaluate(async () => {
      const res = await fetch('/api/notification-routes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'e2e production route',
          stack_patterns: [],
          channel_type: 'webhook',
          channel_url: 'https://example.test/hook',
          priority: 0,
          enabled: false,
          route_keys: ['Production', 'database'],
        }),
      });
      return { status: res.status, body: await res.json() as { id?: number; route_keys?: string[] | null } };
    });
    expect(created.status).toBe(201);
    expect(created.body.route_keys).toEqual(['production', 'database']);

    const refused = await page.evaluate(async () => {
      const res = await fetch('/api/notification-routes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'e2e bad route',
          stack_patterns: [],
          channel_type: 'webhook',
          channel_url: 'https://example.test/hook',
          priority: 0,
          enabled: false,
          route_keys: ['user@host'],
        }),
      });
      return { status: res.status, body: await res.json() as { error?: string } };
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('route_keys');

    await page.evaluate(async (id: number) => {
      await fetch(`/api/notification-routes/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, created.body.id as number);
  });
});
