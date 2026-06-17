/**
 * Git Sources E2E - configure, save, pull, remove.
 *
 * These tests use a throwaway stack that is created via the browser's
 * authenticated fetch (so cookies are carried) and cleaned up in afterAll.
 * Pull tests use an unreachable URL on purpose so the suite does not depend
 * on real network egress or a specific upstream repo being available.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAs } from './helpers';

const TEST_STACK = 'e2e-git-source-stack';

async function createTestStackViaApi(page: Page) {
  return page.evaluate(async (name) => {
    const res = await fetch(`/api/stacks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ stackName: name }),
    });
    return res.status;
  }, TEST_STACK);
}

async function deleteTestStackViaApi(page: Page) {
  await page.evaluate(async (name) => {
    // Drop any orphaned git-source row first (safe even if the stack is already gone).
    await fetch(`/api/stacks/${name}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, TEST_STACK);
}

async function openGitSourcePanel(page: Page) {
  await page.getByText(TEST_STACK).first().click();
  const gitBtn = page.getByRole('button', { name: /Git Source/i });
  await expect(gitBtn).toBeVisible({ timeout: 10_000 });
  await gitBtn.click();
  // Match the title heading specifically; the modal also has a mono kicker
  // ("<STACK> · GIT SOURCE") that would satisfy a plain getByText match.
  await expect(page.getByRole('dialog').getByRole('heading', { name: /git source/i })).toBeVisible({ timeout: 5_000 });
}

test.describe('Git Sources', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page);
    await deleteTestStackViaApi(page);
    await createTestStackViaApi(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page);
    await deleteTestStackViaApi(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await expect(page.getByRole('button', { name: 'Create Stack' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
  });

  test('rejects non-HTTPS repository URLs client-side', async ({ page }) => {
    await openGitSourcePanel(page);

    await page.locator('#git-source-repo').fill('git@github.com:org/repo.git');
    await page.locator('#git-source-branch').fill('main');
    await page.getByRole('dialog').getByRole('button', { name: /^Save$/ }).click();

    await expect(page.getByText(/Only HTTPS repository URLs are supported/i)).toBeVisible({ timeout: 5_000 });
  });

  test('surfaces reachability error on save with unreachable repo', async ({ page }) => {
    await openGitSourcePanel(page);

    // Use a URL that resolves but returns 404 for the git protocol so the dry-run
    // fetch fails with a clean error. reserved-TLDs like .invalid trigger DNS failure
    // which maps to NETWORK_TIMEOUT or REPO_NOT_FOUND.
    await page.locator('#git-source-repo').fill('https://git.invalid.example/nope/nope.git');
    await page.locator('#git-source-branch').fill('main');
    await page.getByRole('dialog').getByRole('button', { name: /^Save$/ }).click();

    // Any of the mapped error messages is acceptable; the key is that nothing
    // persisted silently and the user sees a toast.
    await expect(
      page.getByText(/not found|unreachable|network|timeout|authentication failed/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('PUT against a non-existent stack returns 404', async ({ page }) => {
    const status = await page.evaluate(async () => {
      const res = await fetch(`/api/stacks/nonexistent-ghost-stack/git-source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          repo_url: 'https://github.com/example/repo.git',
          branch: 'main',
          compose_path: 'compose.yaml',
          sync_env: false,
          auth_type: 'none',
          auto_apply_on_webhook: false,
          auto_deploy_on_apply: false,
        }),
      });
      return res.status;
    });
    expect(status).toBe(404);
  });

  test('backend rejects http:// URLs on PUT with 400', async ({ page }) => {
    const status = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/${name}/git-source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          repo_url: 'http://github.com/example/repo.git',
          branch: 'main',
          compose_path: 'compose.yaml',
          sync_env: false,
          auth_type: 'none',
          auto_apply_on_webhook: false,
          auto_deploy_on_apply: false,
        }),
      });
      return res.status;
    }, TEST_STACK);
    expect(status).toBe(400);
  });

  test('backend rejects .git/config as compose_path', async ({ page }) => {
    const body = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/${name}/git-source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          repo_url: 'https://github.com/example/repo.git',
          branch: 'main',
          compose_path: '.git/config',
          sync_env: false,
          auth_type: 'none',
          auto_apply_on_webhook: false,
          auto_deploy_on_apply: false,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, TEST_STACK);
    expect(body.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body.body)).toMatch(/\.git|file/i);
  });

  test('configure, view pending-empty state, and remove via AlertDialog', async ({ page }) => {
    // Seed a git source directly via API so we can exercise the remove-confirm
    // flow without depending on a reachable upstream.
    const putStatus = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/${name}/git-source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          repo_url: 'https://github.com/docker/awesome-compose.git',
          branch: 'master',
          compose_path: 'nginx-golang/compose.yaml',
          sync_env: false,
          auth_type: 'none',
          auto_apply_on_webhook: false,
          auto_deploy_on_apply: false,
        }),
      });
      return res.status;
    }, TEST_STACK);

    // Either the dry-run succeeded (2xx) or the network blocked it (4xx/5xx).
    // If it failed, skip the rest of the remove flow to keep the suite robust.
    if (putStatus >= 400) {
      test.skip(true, `Upstream dry-run returned ${putStatus}; skipping remove path`);
      return;
    }

    await openGitSourcePanel(page);

    // Source should render with the saved repo URL.
    await expect(page.locator('#git-source-repo')).toHaveValue(/awesome-compose/);

    // Click Remove → AlertDialog appears → confirm → source cleared. Playwright's
    // name match is substring by default, so require an exact match to select the
    // footer button and not the picker's per-file "Remove <path>" buttons.
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5_000 });
    await page.getByRole('alertdialog').getByRole('button', { name: /^Remove$/ }).click();

    // After removal, the "Remove" button is gone from the panel footer.
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Remove$/ })).not.toBeVisible({ timeout: 5_000 });
  });
});

const CREATE_FROM_GIT_STACK = 'e2e-create-from-git';

async function deleteCreateFromGitStack(page: Page) {
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, CREATE_FROM_GIT_STACK);
}

async function openCreateStackDialog(page: Page) {
  await page.getByRole('button', { name: 'Create Stack' }).click();
  await expect(page.getByRole('dialog', { name: 'New stack' })).toBeVisible({ timeout: 5_000 });
}

test.describe('Create stack from Git', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page);
    await deleteCreateFromGitStack(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page);
    await deleteCreateFromGitStack(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await expect(page.getByRole('button', { name: 'Create Stack' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
  });

  test('dialog exposes Empty and From Git tabs', async ({ page }) => {
    await openCreateStackDialog(page);
    await expect(page.getByRole('dialog').getByRole('tab', { name: /Empty/i })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('tab', { name: /From Git/i })).toBeVisible();
  });

  test('From Git tab rejects non-HTTPS URLs client-side', async ({ page }) => {
    await openCreateStackDialog(page);
    await page.getByRole('dialog').getByRole('tab', { name: /From Git/i }).click();

    await page.locator('#create-git-stack-name').fill(CREATE_FROM_GIT_STACK);
    await page.locator('#git-source-repo').fill('git@github.com:org/repo.git');
    await page.locator('#git-source-branch').fill('main');
    await page.getByRole('dialog').getByRole('button', { name: /Create from Git/i }).click();
    await expect(page.getByText(/Only HTTPS repository URLs are supported/i)).toBeVisible({ timeout: 5_000 });
  });

  test('backend rejects .git/config compose_path on from-git', async ({ page }) => {
    const body = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/from-git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          stack_name: name,
          repo_url: 'https://github.com/example/repo.git',
          branch: 'main',
          compose_path: '.git/config',
          auth_type: 'none',
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, CREATE_FROM_GIT_STACK);
    expect(body.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body.body)).toMatch(/\.git|file/i);
  });

  test('happy path: fetches compose, creates stack, links git source', async ({ page }) => {
    // Use a public demo repo. If network egress is blocked, the POST fails
    // and we skip the rest of the test rather than hanging the suite.
    const result = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/from-git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          stack_name: name,
          repo_url: 'https://github.com/docker/awesome-compose.git',
          branch: 'master',
          compose_path: 'nginx-golang/compose.yaml',
          auth_type: 'none',
          auto_apply_on_webhook: false,
          auto_deploy_on_apply: false,
          deploy_now: false,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, CREATE_FROM_GIT_STACK);

    if (result.status >= 400) {
      test.skip(true, `Upstream unreachable (status ${result.status}); skipping happy path`);
      return;
    }
    expect(result.status).toBe(200);
    expect(result.body?.source?.stack_name).toBe(CREATE_FROM_GIT_STACK);
    expect(result.body?.source?.last_applied_commit_sha).toBeTruthy();

    // Stack dir should now exist and the compose should contain the upstream service names.
    const contentStatus = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/${name}`, { credentials: 'include' });
      return { status: res.status, body: await res.text() };
    }, CREATE_FROM_GIT_STACK);
    expect(contentStatus.status).toBe(200);
    expect(contentStatus.body).toMatch(/services:/);
    // Backend contract: commitSha is returned at full length so the frontend
    // can build the short-SHA suffix for the success toast. Guard it here so
    // the toast copy can never drift without a test catching it.
    expect(result.body?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('UI flow: success toast includes the short commit SHA', async ({ page }) => {
    // Pre-flight check: if the upstream is unreachable from this runner, the
    // UI flow will also fail. Probe the API with a throwaway name first so we
    // skip cleanly instead of hanging on a dialog that never resolves.
    const probeName = `${CREATE_FROM_GIT_STACK}-probe`;
    const probe = await page.evaluate(async (name) => {
      const res = await fetch(`/api/stacks/from-git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          stack_name: name,
          repo_url: 'https://github.com/docker/awesome-compose.git',
          branch: 'master',
          compose_path: 'nginx-golang/compose.yaml',
          auth_type: 'none',
          deploy_now: false,
        }),
      });
      return { status: res.status };
    }, probeName);

    // Always tear down the probe, whether it succeeded or not.
    await page.evaluate(async (name) => {
      await fetch(`/api/stacks/${name}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
      await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, probeName);

    if (probe.status >= 400) {
      test.skip(true, `Upstream unreachable (status ${probe.status}); skipping UI toast test`);
      return;
    }

    const uiName = `${CREATE_FROM_GIT_STACK}-ui`;
    // Ensure no leftover row from a prior failing run.
    await page.evaluate(async (name) => {
      await fetch(`/api/stacks/${name}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
      await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, uiName);

    try {
      await openCreateStackDialog(page);
      await page.getByRole('dialog').getByRole('tab', { name: /From Git/i }).click();

      await page.locator('#create-git-stack-name').fill(uiName);
      await page.locator('#git-source-repo').fill('https://github.com/docker/awesome-compose.git');
      await page.locator('#git-source-branch').fill('master');
      // Drive the compose-file picker: add the repo path, then drop the default
      // compose.yaml so only the intended file is deployed.
      const createDialog = page.getByRole('dialog');
      await createDialog.getByPlaceholder('path/to/compose.yaml').fill('nginx-golang/compose.yaml');
      await createDialog.getByPlaceholder('path/to/compose.yaml').press('Enter');
      await createDialog.getByRole('button', { name: 'Remove compose.yaml' }).click();

      await page.getByRole('dialog').getByRole('button', { name: /Create from Git/i }).click();

      // The toast copy is "Stack created from Git @ <short sha>." — match the
      // @-delimited 7-char hex suffix so any drift in wording still passes as
      // long as the SHA is surfaced.
      await expect(page.getByText(/@ [0-9a-f]{7}/).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await page.evaluate(async (name) => {
        await fetch(`/api/stacks/${name}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
        await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
      }, uiName);
    }
  });
});
