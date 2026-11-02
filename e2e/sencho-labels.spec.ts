/**
 * io.sencho.* Compose labels: the node resolves them from the rendered Compose
 * model (so interpolation and a merged override file count), and the stack view
 * reports which ones are active, ignored, or unsupported.
 *
 * The first group seeds its own stack and deploys nothing: labels are read from
 * the Compose files, not from running containers. The second group deploys a
 * small stack to check the container list: links shown once per service, hidden
 * helpers collapsed, and only a failed helper flagged as needing attention.
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
    # List syntax, so the rendered list form is exercised end to end too.
    labels:
      - io.sencho.order=\${API_ORDER:-10}
      - io.sencho.url.docs=https://\${DOCS_HOST:-docs.example.com}/api
      - io.sencho.hidden=maybe
      - io.sencho.future=1
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

const INFRA_STACK = 'e2e-sencho-labels-infra';
// The protective label on a service that is never deployed: the guard would protect the
// container, and that protection would block the teardown.
const INFRA_COMPOSE = `services:
  proxy:
    image: nginx:alpine
    labels:
      io.sencho.infrastructure: "true"
`;

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
    // api's labels are set only in the base file, through interpolation defaults, so the
    // resolved values are the defaults Compose substituted, not a file's literal text.
    expect(senchoLabels.services.api.order).toBe(10);
    expect(senchoLabels.services.api.links).toEqual([{ name: 'docs', url: 'https://docs.example.com/api' }]);
    // An invalid value is ignored, so the service stays visible, and an unknown key is reported.
    expect(senchoLabels.services.api.hidden).toBe(false);
    const states = Object.fromEntries(senchoLabels.entries.filter(e => e.service === 'api').map(e => [e.key, e.state]));
    expect(states).toMatchObject({ 'io.sencho.hidden': 'invalid', 'io.sencho.order': 'active', 'io.sencho.future': 'unsupported', 'io.sencho.url.docs': 'active' });
  });

  test('the stack view lists services in label order and marks each label status', async ({ page }) => {
    await openStack(page);
    const chips = page.getByText('services', { exact: true }).locator('xpath=following-sibling::*[1]').locator('span');
    // The hidden helper has no chip; one toggle reveals it in place.
    await expect(chips).toHaveText(['web', 'api']);
    const hiddenToggle = page.getByTestId('anatomy-hidden-services-toggle');
    await expect(hiddenToggle).toHaveText('1 hidden');
    await hiddenToggle.click();
    await expect(chips).toHaveText(['web', 'api', 'helper']);
    await expect(page.getByTitle('Hidden from default lists by io.sencho.hidden')).toHaveText('helper');
    await hiddenToggle.click();
    await expect(chips).toHaveText(['web', 'api']);

    await page.getByRole('tab', { name: 'Compose Labels' }).click();
    const panel = page.getByTestId('compose-labels-panel');
    await expect(panel).toBeVisible();
    const hiddenRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.hidden' }).filter({ hasText: 'maybe' });
    await expect(hiddenRow.getByTestId('label-behavior')).toHaveText('Ignored');
    await expect(hiddenRow).toContainText('Use true or false.');
    const futureRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.future' });
    await expect(futureRow.getByTestId('label-behavior')).toHaveText('Unsupported');
    const docsRow = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.url.docs' }).filter({ hasText: 'docs.example.com/api' });
    await expect(docsRow.getByTestId('label-behavior')).toHaveText('Active');
  });

  test('marks a declared infrastructure label Active without deploying the stack', async ({ page }) => {
    await page.evaluate(async ({ stackName, content }: { stackName: string; content: string }) => {
      const create = await fetch('/api/stacks', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stackName }),
      });
      if (!create.ok && create.status !== 409) throw new Error(`create failed: ${create.status}`);
      const write = await fetch(`/api/stacks/${stackName}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      });
      if (!write.ok) throw new Error(`write failed: ${write.status}`);
    }, { stackName: INFRA_STACK, content: INFRA_COMPOSE });

    try {
      await page.reload();
      await waitForStacksLoaded(page);
      await page.getByText(INFRA_STACK, { exact: true }).first().click();
      await page.getByRole('tab', { name: 'Compose Labels' }).click();
      const panel = page.getByTestId('compose-labels-panel');
      const row = panel.getByTestId('compose-label-row').filter({ hasText: 'io.sencho.infrastructure' });
      await expect(row.getByTestId('label-behavior')).toHaveText('Active');
      // The label protects the service; it adds no link and no presentation.
      await expect(page.getByRole('link', { name: 'proxy', exact: true })).toHaveCount(0);
    } finally {
      await page.evaluate(async (stackName: string) => {
        await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
      }, INFRA_STACK);
    }
  });
});


const DEPLOYED_STACK = 'e2e-sencho-labels-live';
// network_mode: none keeps the fixture off Docker's address pools, which this kind of
// throwaway project has exhausted on shared dev hosts; every assertion is about labels.
const DEPLOYED_COMPOSE = `services:
  web:
    image: alpine:3
    command: sleep infinity
    restart: "no"
    network_mode: none
    deploy:
      replicas: 2
    labels:
      io.sencho.order: "1"
      io.sencho.url: https://app.example.com
      io.sencho.url.docs: https://\${DOCS_HOST:-docs.example.com}/web
  seed:
    image: alpine:3
    command: sh -c "exit 0"
    restart: "no"
    network_mode: none
    labels:
      io.sencho.hidden: "true"
  broken:
    image: alpine:3
    command: sleep infinity
    restart: "no"
    network_mode: none
    stop_grace_period: 1s
    labels:
      io.sencho.hidden: "true"
`;

/** Creates, writes, deploys, and fails the helper of the deployed fixture stack. Returns the last status code. */
async function deployFixture(page: Page): Promise<number> {
  return page.evaluate(async ({ stackName, content }: { stackName: string; content: string }) => {
    const create = await fetch('/api/stacks', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stackName }),
    });
    if (!create.ok && create.status !== 409) return create.status;
    const write = await fetch(`/api/stacks/${stackName}`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!write.ok) return write.status;
    const deploy = await fetch(`/api/stacks/${stackName}/deploy`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skip_scan: true }),
    });
    if (!deploy.ok) return deploy.status;
    // A deploy that sees a container crash is rolled back, so the helper fails after it: stop it, which ends it with a non-zero exit.
    const stop = await fetch(`/api/stacks/${stackName}/services/broken/stop`, { method: 'POST', credentials: 'include' });
    return stop.status;
  }, { stackName: DEPLOYED_STACK, content: DEPLOYED_COMPOSE });
}

test.describe('io.sencho.* labels on a deployed stack', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.evaluate(async (stackName: string) => {
      await fetch(`/api/stacks/${stackName}/down`, { method: 'POST', credentials: 'include' }).catch(() => {});
      await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, DEPLOYED_STACK);
  });
  test.afterEach(async ({ page }) => {
    await page.evaluate(async (stackName: string) => {
      await fetch(`/api/stacks/${stackName}/down`, { method: 'POST', credentials: 'include' }).catch(() => {});
      await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, DEPLOYED_STACK);
  });

  test('shows links once per service, collapses helpers, and flags only the failed one', async ({ page }) => {
    test.setTimeout(90_000);
    expect(await deployFixture(page)).toBe(200);

    await page.reload();
    await waitForStacksLoaded(page);
    await page.getByText(DEPLOYED_STACK, { exact: true }).first().click();

    // Two helpers are hidden. The one-shot job exited 0 and the other was stopped with a failure, so exactly one needs attention.
    const row = page.getByTestId('hidden-services-row');
    await expect(row).toContainText('2 hidden helper services', { timeout: 30_000 });
    await expect(page.getByTestId('hidden-services-attention')).toHaveText('1 needs attention');
    await expect(page.getByText('e2e-sencho-labels-live-seed-1')).toHaveCount(0);

    // Hidden helpers are presentation only: the totals still count every container, collapsed or not.
    await expect(page.getByText('4 containers', { exact: true })).toBeVisible();

    // The service runs two replicas, and its interpolated named link shows once on the service header.
    const docs = page.getByRole('link', { name: 'docs', exact: true });
    await expect(docs).toHaveCount(1);
    await expect(docs).toHaveAttribute('href', 'https://docs.example.com/web');

    // Revealing the helpers lists the failed one in place.
    await row.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByText('e2e-sencho-labels-live-broken-1')).toBeVisible();
    await expect(page.getByText('e2e-sencho-labels-live-seed-1')).toBeVisible();

    // Hidden helpers are presentation only: a revealed one keeps its Service actions menu (Start service for a stopped helper).
    const brokenCard = page.getByText('e2e-sencho-labels-live-broken-1')
      .locator('xpath=ancestor::div[.//button[@aria-label="Service actions"]][1]');
    await brokenCard.getByRole('button', { name: 'Service actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Start service' })).toBeVisible();
  });

  test('applies nothing from the contract on a node that predates it, and says so', async ({ page }) => {
    test.setTimeout(120_000);
    expect(await deployFixture(page)).toBe(200);

    // Answer like an older node: no sencho-labels-v1 capability, and an effective-anatomy body
    // without the resolved labels. The authored service order is the only order left.
    await page.route('**/api/nodes/*/meta*', async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { version?: string; capabilities?: string[] };
      await route.fulfill({
        response,
        json: {
          ...body,
          version: '0.97.0',
          capabilities: (body.capabilities ?? []).filter(capability => capability !== 'sencho-labels-v1'),
        },
      });
    });
    await page.route('**/api/stacks/**/effective-anatomy*', async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { senchoLabels?: unknown };
      delete body.senchoLabels;
      await route.fulfill({ response, json: body });
    });

    await page.reload();
    await waitForStacksLoaded(page);
    await page.getByText(DEPLOYED_STACK, { exact: true }).first().click();

    // No named link, no hiding, no order, and no link pencil: the client applies no part of the contract.
    await expect(page.getByTestId('hidden-services-row')).toHaveCount(0);
    await expect(page.getByText('e2e-sencho-labels-live-seed-1')).toBeVisible();
    await expect(page.getByRole('link', { name: 'docs', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit service URL' })).toHaveCount(0);
    // io.sencho.order would put web first, then broken and seed by name; without the contract the authored order stands.
    const chips = page.getByText('services', { exact: true }).locator('xpath=following-sibling::*[1]').locator('span');
    await expect(chips).toHaveText(['web', 'seed', 'broken']);

    // The Compose Labels tab says the node does not apply the contract.
    await page.getByRole('tab', { name: 'Compose Labels' }).click();
    await expect(page.getByTestId('compose-labels-panel')).toContainText('This node does not apply io.sencho.* labels.');
  });
});
