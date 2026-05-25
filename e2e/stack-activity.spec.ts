// Out of scope (no `.skip()` markers; this header exists so reviewers know what was excluded):
//   - Remote-node matrix: requires a real peer enrolled in the CI database.
//   - Stack:read permission denial: backend unit tests cover the route's 403 path.
//   - Developer-mode diagnostic-line matrix: the Playwright harness has no stable hook into backend stdout.
import { test, expect, type Page } from '@playwright/test';
import { loginAs, TEST_USERNAME } from './helpers';

const DEPLOY_TEST_IMAGE = 'alpine:3';
const STACK = 'e2e-activity-test';

function longRunningCompose(stackName: string): string {
  return [
    'services:',
    `  ${stackName}:`,
    `    image: ${DEPLOY_TEST_IMAGE}`,
    '    command: sleep infinity',
    '    restart: "no"',
    '',
  ].join('\n');
}

async function createStackWithCompose(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(
    async ({ stackName, body }) => {
      const createRes = await fetch('/api/stacks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName }),
      });
      if (!createRes.ok && createRes.status !== 409) {
        throw new Error(`Failed to create stack ${stackName}: HTTP ${createRes.status}`);
      }
      const putRes = await fetch(`/api/stacks/${stackName}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body }),
      });
      if (!putRes.ok) throw new Error(`Failed to seed compose for ${stackName}: HTTP ${putRes.status}`);
    },
    { stackName: name, body: content },
  );
}

async function teardownStack(page: Page, name: string): Promise<void> {
  await page.evaluate(async (stackName) => {
    await fetch(`/api/stacks/${stackName}/down`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
    await fetch(`/api/stacks/${stackName}`, { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
  }, name);
}

interface ActivityEvent {
  id: number;
  category?: string;
  message: string;
  timestamp: number;
  actor_username?: string | null;
}

async function fetchActivity(page: Page, name: string, query = ''): Promise<{ status: number; events: ActivityEvent[] }> {
  return page.evaluate(
    async ({ stackName, q }) => {
      const r = await fetch(`/api/stacks/${stackName}/activity${q}`, { credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, events: body.events ?? [] };
    },
    { stackName: name, q: query },
  );
}

async function waitForEventCount(page: Page, name: string, minCount: number, timeoutMs = 30_000): Promise<ActivityEvent[]> {
  const deadline = Date.now() + timeoutMs;
  let last: ActivityEvent[] = [];
  while (Date.now() < deadline) {
    const { events } = await fetchActivity(page, name);
    last = events;
    if (events.length >= minCount) return events;
    await page.waitForTimeout(500);
  }
  throw new Error(`waitForEventCount: expected ≥${minCount}, got ${last.length}: ${JSON.stringify(last)}`);
}

test.describe.serial('Stack Activity - lifecycle', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await loginAs(page);
      await createStackWithCompose(page, STACK, longRunningCompose(STACK));
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await loginAs(page);
      await teardownStack(page, STACK);
    } catch (e) {
      console.warn('teardown failed:', e);
    } finally {
      await page.close();
    }
  });

  test('deploy/restart/down emit attributed events visible via the activity endpoint', async ({ page }) => {
    await loginAs(page);

    // Deploy: produces a deploy_success event.
    const deployRes = await page.evaluate(async (name) => {
      const r = await fetch(`/api/stacks/${name}/deploy`, { method: 'POST', credentials: 'include' });
      return r.status;
    }, STACK);
    expect([200, 201]).toContain(deployRes);

    const afterDeploy = await waitForEventCount(page, STACK, 1);
    const deployEvt = afterDeploy.find(e => e.category === 'deploy_success');
    expect(deployEvt, 'deploy_success event recorded').toBeDefined();
    expect(deployEvt?.actor_username).toBe(TEST_USERNAME);
    expect(deployEvt?.message).toContain(STACK);

    // Restart: produces a stack_restarted event.
    const restartRes = await page.evaluate(async (name) => {
      const r = await fetch(`/api/stacks/${name}/restart`, { method: 'POST', credentials: 'include' });
      return r.status;
    }, STACK);
    expect([200, 201]).toContain(restartRes);

    const afterRestart = await waitForEventCount(page, STACK, 2);
    const restartEvt = afterRestart.find(e => e.category === 'stack_restarted');
    expect(restartEvt, 'stack_restarted event recorded').toBeDefined();
    expect(restartEvt?.actor_username).toBe(TEST_USERNAME);

    // Down: produces a stack_stopped event.
    const downRes = await page.evaluate(async (name) => {
      const r = await fetch(`/api/stacks/${name}/down`, { method: 'POST', credentials: 'include' });
      return r.status;
    }, STACK);
    expect([200, 201]).toContain(downRes);

    const afterDown = await waitForEventCount(page, STACK, 3);

    // Events are returned newest-first.
    for (let i = 1; i < afterDown.length; i++) {
      const prev = afterDown[i - 1];
      const curr = afterDown[i];
      expect(prev.timestamp > curr.timestamp || (prev.timestamp === curr.timestamp && prev.id > curr.id))
        .toBe(true);
    }
  });

  test('activity endpoint rejects invalid pagination input', async ({ page }) => {
    await loginAs(page);
    const invalidLimit = await page.evaluate(async (name) => {
      const r = await fetch(`/api/stacks/${name}/activity?limit=abc`, { credentials: 'include' });
      return r.status;
    }, STACK);
    expect(invalidLimit).toBe(400);

    const invalidBefore = await page.evaluate(async (name) => {
      const r = await fetch(`/api/stacks/${name}/activity?before=12abc`, { credentials: 'include' });
      return r.status;
    }, STACK);
    expect(invalidBefore).toBe(400);

    const invalidBeforeId = await page.evaluate(async (name) => {
      const r = await fetch(`/api/stacks/${name}/activity?beforeId=notanumber`, { credentials: 'include' });
      return r.status;
    }, STACK);
    expect(invalidBeforeId).toBe(400);
  });

  test('composite cursor advances past same-millisecond rows', async ({ page }) => {
    await loginAs(page);
    // The lifecycle test left ≥3 events. Pull page 1 (limit=1), then page 2
    // (before+beforeId of the first row). With only timestamp the second page
    // would silently drop rows sharing the same millisecond; with the
    // composite cursor it returns the next-older row deterministically.
    const page1 = await fetchActivity(page, STACK, '?limit=1');
    expect(page1.events.length).toBe(1);
    const cursor = page1.events[0];

    const page2 = await fetchActivity(
      page,
      STACK,
      `?limit=1&before=${cursor.timestamp}&beforeId=${cursor.id}`,
    );
    expect(page2.status).toBe(200);
    // The lifecycle test leaves at least 3 events; page 2 with limit=1 must return exactly 1
    // and it cannot be the cursor row.
    expect(page2.events.length).toBe(1);
    expect(page2.events[0].id).not.toBe(cursor.id);

    const orphanCursor = await fetchActivity(page, STACK, '?beforeId=99999');
    expect(orphanCursor.status).toBe(400);
  });
});

