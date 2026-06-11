/**
 * Deploy feedback modal E2E tests.
 *
 * The modal is opt-in (default off). Each test that expects the modal must
 * enable the setting via localStorage before triggering an action.
 *
 * These tests require a running Docker daemon because they exercise real
 * docker compose operations. Timeouts are generous to allow for image pulls
 * on a cold cache.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const HAPPY_STACK = 'e2e-deploy-log-test';
const FAIL_STACK = 'e2e-deploy-log-fail-test';
const DEPLOY_FEEDBACK_KEY = 'sencho.deploy-feedback.enabled';

const HAPPY_COMPOSE = `services:
  web:
    image: nginx:alpine
`;

const FAIL_COMPOSE = `services:
  web:
    image: nginnnnx:notexist
`;

async function createStackViaApi(page: Page, name: string, composeContent: string): Promise<void> {
  await page.evaluate(
    async ({ stackName, content }: { stackName: string; content: string }) => {
      const createRes = await fetch('/api/stacks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName }),
      });
      if (!createRes.ok && createRes.status !== 409) {
        throw new Error(`Failed to create stack: ${createRes.status}`);
      }

      const writeRes = await fetch(`/api/stacks/${stackName}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!writeRes.ok) {
        throw new Error(`Failed to write compose file: ${writeRes.status}`);
      }
    },
    { stackName: name, content: composeContent },
  );
}

async function deleteStackViaApi(page: Page, name: string): Promise<void> {
  await page.evaluate(async (stackName: string) => {
    await fetch(`/api/stacks/${stackName}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {});
  }, name);
}

/**
 * Set the opt-in flag so it survives every page navigation and reload in the
 * test. addInitScript runs before any page script on each load, so the React
 * tree's useState initializer always reads the current value on mount. The
 * page.evaluate call covers any state already mounted on the current page.
 */
async function enableDeployFeedback(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    window.localStorage.setItem(key, 'true');
  }, DEPLOY_FEEDBACK_KEY);
  await page.evaluate((key: string) => {
    window.localStorage.setItem(key, 'true');
    window.dispatchEvent(new CustomEvent('SENCHO_SETTINGS_CHANGED'));
  }, DEPLOY_FEEDBACK_KEY);
}

/**
 * Shrink the post-deploy health gate observation window so success-path tests
 * can watch the full deploy, verify, succeed sequence without waiting out the
 * 90s default. 15 seconds is the smallest value the settings API accepts.
 */
async function setHealthGateWindow(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (windowSeconds: number) => {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ health_gate_window_seconds: windowSeconds }),
    });
    if (!res.ok) {
      throw new Error(`Failed to set health gate window: ${res.status}`);
    }
  }, seconds);
}

/**
 * Force the React hook to re-read localStorage and update its state. Used
 * right before a deploy click to defeat any stale-state edge cases after
 * navigation.
 */
async function syncDeployFeedbackState(page: Page): Promise<void> {
  const stored = await page.evaluate((key: string) => {
    window.dispatchEvent(new CustomEvent('SENCHO_SETTINGS_CHANGED'));
    return window.localStorage.getItem(key);
  }, DEPLOY_FEEDBACK_KEY);
  expect(stored, 'deploy feedback opt-in flag missing in localStorage').toBe('true');
  // Allow React to process the state update from the dispatched event before
  // the next user interaction. The click fires synchronously, but React
  // re-renders in a microtask; without this wait the click handler can run
  // against the stale closure where isEnabled was still false.
  await page.waitForTimeout(200);
}

async function disableDeployFeedback(page: Page): Promise<void> {
  // The panel is on by default (opt-out), so disabling means writing an
  // explicit 'false' that survives the reload, not clearing the key.
  await page.addInitScript((key: string) => {
    window.localStorage.setItem(key, 'false');
  }, DEPLOY_FEEDBACK_KEY);
  await page.evaluate((key: string) => {
    window.localStorage.setItem(key, 'false');
    window.dispatchEvent(new CustomEvent('SENCHO_SETTINGS_CHANGED'));
  }, DEPLOY_FEEDBACK_KEY);
}

/**
 * Delete any leftover stack, create a fresh one, reload so the sidebar picks
 * it up, and click it to open the editor. Returns with the stack selected and
 * the Deploy button ready.
 *
 * The stack click and the file fetch that follows are awaited together so
 * the editor's selectedFile state is committed before the test continues.
 * Without this, deployStack() returns early at the !selectedFile guard and
 * never calls runWithLog, leaving the modal closed.
 */
async function setupDeployStack(page: Page, name: string, composeContent: string): Promise<void> {
  await deleteStackViaApi(page, name);
  await page.waitForTimeout(300);
  await createStackViaApi(page, name, composeContent);
  // Reload preserves auth cookies, so the page lands back on the dashboard
  // without needing a fresh login. Calling loginAs() here was racing the
  // login-page detection during the brief render where the auth context
  // was still loading, then waiting forever on a #username field that
  // never re-appeared once the dashboard committed.
  await page.reload();
  await waitForStacksLoaded(page);

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/stacks/${name}`) &&
        res.request().method() === 'GET' &&
        res.ok(),
      { timeout: 10_000 },
    ),
    page.getByText(name, { exact: true }).first().click(),
  ]);

  // Wait for the editor's action bar to render with the deploy/start button.
  await expect(page.getByTestId('stack-deploy-button')).toBeVisible({ timeout: 10_000 });

  // Settle remaining state updates and any follow-up fetches the editor
  // triggers (env file, container list, backup info). Without this the click
  // can race with React committing selectedFile, leaving deployStack to bail
  // at its !selectedFile guard.
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
  await page.waitForTimeout(500);
}

test.describe('Deploy feedback modal', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // Surface React errors and network failures from the browser so test
    // failures arrive with diagnostic context instead of just "modal not
    // visible". Skip noisy info/log/debug messages.
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        // eslint-disable-next-line no-console
        console.log(`[browser ${msg.type()}] [${testInfo.title}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[browser pageerror] [${testInfo.title}] ${err.message}`);
    });
    await loginAs(page);
    await waitForStacksLoaded(page);
  });

  test('no modal appears when the progress panel is turned off', async ({ page }) => {
    test.setTimeout(60_000);

    await disableDeployFeedback(page);
    await setupDeployStack(page, HAPPY_STACK, HAPPY_COMPOSE);

    await page.getByTestId('stack-deploy-button').click();

    // Modal must not appear when the panel has been explicitly disabled
    await expect(page.locator('[data-testid="deploy-feedback-modal"]')).not.toBeVisible({
      timeout: 5_000,
    });
  });

  test('modal opens, streams output, and auto-closes on success', async ({ page }) => {
    // Worst-case assertion budget: 90s compose run + 45s gate verdict + 15s
    // auto-close, so the per-assertion timeout fires before the test timeout.
    test.setTimeout(160_000);

    await enableDeployFeedback(page);
    await setHealthGateWindow(page, 15);
    await setupDeployStack(page, HAPPY_STACK, HAPPY_COMPOSE);
    await syncDeployFeedbackState(page);

    await page.getByTestId('stack-deploy-button').click();
    // Park the cursor in a corner so the modal's onMouseEnter never fires.
    // The modal pauses its 4s auto-close countdown on hover; without this
    // move, the cursor lands inside the centered modal after click and the
    // countdown never fires.
    await page.mouse.move(0, 0);

    const modal = page.locator('[data-testid="deploy-feedback-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Initial status: either "Connecting..." or already streaming rows
    const connectingText = page.getByText(/Connecting\.\.\./i);
    const streamingIndicator = page.getByText(/\d+ lines?/i);
    await Promise.race([
      connectingText.waitFor({ state: 'visible', timeout: 10_000 }),
      streamingIndicator.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);

    // The compose run finishes first (up to 90s for a cold image pull), then
    // the post-deploy health gate observes the containers before the modal
    // commits to a verdict.
    await expect(modal.getByText('Verifying health')).toBeVisible({ timeout: 90_000 });

    // Gate window is 15s; allow the 4s status polling cadence plus slack.
    await expect(modal.getByText('Succeeded')).toBeVisible({ timeout: 45_000 });

    // Modal auto-closes AUTO_CLOSE_SECONDS (4s) after success; allow up to 15s total
    await expect(modal).toBeHidden({ timeout: 15_000 });
  });

  test('modal stays open with error indicator on failure', async ({ page }) => {
    test.setTimeout(120_000);

    await enableDeployFeedback(page);
    await setupDeployStack(page, FAIL_STACK, FAIL_COMPOSE);
    await syncDeployFeedbackState(page);

    await page.getByTestId('stack-deploy-button').click();

    const modal = page.locator('[data-testid="deploy-feedback-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Docker fails to pull the nonexistent image; give it up to 90s to attempt and fail
    await expect(
      page.getByText(/failed|error|not found|unable to find/i).first(),
    ).toBeVisible({ timeout: 90_000 });

    // Modal must remain open on failure
    await page.waitForTimeout(8_000);
    await expect(modal).toBeVisible();
  });

  test('modal can be minimized to a pill and expanded back', async ({ page }) => {
    test.setTimeout(120_000);

    await enableDeployFeedback(page);
    await setupDeployStack(page, HAPPY_STACK, HAPPY_COMPOSE);
    await syncDeployFeedbackState(page);

    await page.getByTestId('stack-deploy-button').click();
    // Move cursor away from modal so the auto-close countdown is not paused
    // by hover, in case the deploy completes before we click Minimize.
    await page.mouse.move(0, 0);

    const modal = page.locator('[data-testid="deploy-feedback-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Click the minimize button in the header (first occurrence)
    const minimizeBtn = page.getByRole('button', { name: 'Minimize' }).first();
    await expect(minimizeBtn).toBeVisible({ timeout: 5_000 });
    await minimizeBtn.click();

    // Modal dialog closes; pill appears at bottom center
    await expect(modal).toBeHidden({ timeout: 5_000 });
    const pill = page.locator('[data-testid="deploy-feedback-pill"]');
    await expect(pill).toBeVisible({ timeout: 5_000 });

    // Pill contains the stack name
    await expect(pill).toContainText(HAPPY_STACK);

    // Click the pill to restore the modal
    await pill.click();
    await expect(modal).toBeVisible({ timeout: 5_000 });
  });

  test('deploy continues to success after minimizing mid-deploy', async ({ page }) => {
    test.setTimeout(120_000);

    await enableDeployFeedback(page);
    await setHealthGateWindow(page, 15);
    await setupDeployStack(page, HAPPY_STACK, HAPPY_COMPOSE);
    await syncDeployFeedbackState(page);

    await page.getByTestId('stack-deploy-button').click();

    const modal = page.locator('[data-testid="deploy-feedback-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Wait until output is actually streaming so the minimize happens mid-deploy,
    // not after a too-fast completion (which would pass vacuously).
    await Promise.race([
      page.getByText(/Connecting\.\.\./i).waitFor({ state: 'visible', timeout: 10_000 }),
      page.getByText(/\d+ lines?/i).waitFor({ state: 'visible', timeout: 10_000 }),
    ]);

    // Minimize while the deploy is in flight. The progress socket closes when
    // the dialog unmounts; the deploy is owned by its HTTP request and must
    // keep running. Before the output-only fix this aborted the deploy with a
    // "client disconnected" failure.
    await page.getByRole('button', { name: 'Minimize' }).first().click();
    const pill = page.locator('[data-testid="deploy-feedback-pill"]');
    await expect(pill).toBeVisible({ timeout: 5_000 });

    // Re-expand and confirm the deploy reached success, never a disconnect failure.
    await pill.click();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/client disconnected/i)).toHaveCount(0);
  });

  test('failed operation shows a recovery panel with retry on desktop and mobile', async ({ page }) => {
    test.setTimeout(90_000);
    // The recovery panel lives in the stack detail and must work without the
    // streaming modal, so disable the modal and assert the panel directly.
    await disableDeployFeedback(page);

    let opCalls = 0;
    await page.route('**/api/stacks/**/deploy*', async (route) => {
      opCalls += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'pull failed: connection reset' }),
      });
    });

    await setupDeployStack(page, HAPPY_STACK, HAPPY_COMPOSE);

    // Desktop: a failed operation surfaces a recovery chip and never leaves the
    // action button stuck in a spinner. Clicking the chip opens the popover with
    // the recovery actions.
    await page.getByTestId('stack-deploy-button').click();
    await expect(page.getByTestId('recovery-chip')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Deploy failed')).toBeVisible();
    await expect(page.getByTestId('stack-deploy-button')).toBeEnabled({ timeout: 10_000 });

    await page.getByTestId('recovery-chip').click();
    await expect(page.getByTestId('recovery-panel')).toBeVisible({ timeout: 10_000 });
    // Retry re-issues the operation through the shared handler.
    await page.getByRole('button', { name: 'Retry deploy' }).click();
    await expect.poll(() => opCalls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // Mobile shell (below the md break) renders the recovery card inline.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await waitForStacksLoaded(page);
    await page.getByText(HAPPY_STACK, { exact: true }).first().click();
    await page.getByTestId('stack-deploy-button').click();
    await expect(page.getByTestId('recovery-panel')).toBeVisible({ timeout: 15_000 });
  });

  test.afterEach(async ({ page }) => {
    await deleteStackViaApi(page, HAPPY_STACK);
    await deleteStackViaApi(page, FAIL_STACK);
    await disableDeployFeedback(page);
    // Restore the default observation window so the shortened test value does
    // not leak into later suites or manual sessions against the same instance.
    // Best-effort: a failed test may have already lost the page session.
    await setHealthGateWindow(page, 90).catch(() => {});
  });
});
