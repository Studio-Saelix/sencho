import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { loginAs, waitForShellReady, TEST_PASSWORD } from './helpers';
import {
  APPEARANCE_DOC, adminApiContext, disposePrefUser, getPreferences, putDomain, seedPrefUser,
} from './preferences-helpers';

const SUITE_USER = 'anatomy-resize-e2e';
const STACK_NAME = 'anatomy-resize-e2e-stack';

function pane(page: Page) {
  return page.getByTestId('anatomy-resize-pane');
}

function separator(page: Page) {
  return page.getByTestId('anatomy-resize-separator');
}

function anatomyModeOption(page: Page, name: 'Fixed' | 'Resizable') {
  return page.getByRole('radiogroup', { name: 'Anatomy panel mode' }).getByRole('radio', { name });
}

async function openStack(page: Page, slug: string): Promise<void> {
  await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}`);
  await waitForShellReady(page);
  await expect(page.getByRole('tab', { name: 'Anatomy' })).toBeVisible();
}

async function openAppearanceSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stack detail layout' })).toBeVisible();
}

async function expectStoredAppearance(
  request: APIRequestContext,
  userId: number,
  expected: Record<string, unknown>,
): Promise<void> {
  await expect.poll(async () => {
    const rows = await getPreferences(request, userId);
    return rows.preferences.appearance?.data ?? null;
  }, { timeout: 15_000 }).toMatchObject(expected);
}

test.describe('Resizable Anatomy panel', () => {
  test.describe.configure({ mode: 'serial' });

  let prefUser: Awaited<ReturnType<typeof seedPrefUser>> | undefined;
  let admin: Awaited<ReturnType<typeof adminApiContext>> | undefined;

  test.beforeAll(async () => {
    prefUser = await seedPrefUser(SUITE_USER, TEST_PASSWORD, 'viewer');
    admin = await adminApiContext();
    const priorDelete = await admin.delete(`/api/stacks/${STACK_NAME}`);
    if (!priorDelete.ok() && priorDelete.status() !== 404) {
      throw new Error(`delete prior ${STACK_NAME} failed with ${priorDelete.status()}`);
    }
    const create = await admin.post('/api/stacks', { data: { stackName: STACK_NAME } });
    if (!create.ok()) throw new Error(`create ${STACK_NAME} failed with ${create.status()}`);
    await putDomain(prefUser.request, prefUser.userId, 'appearance', {
      ...APPEARANCE_DOC,
      anatomyWidth: 480,
    });
  });

  test.afterAll(async () => {
    try {
      if (admin) {
        const cleanup = await admin.delete(`/api/stacks/${STACK_NAME}`);
        if (!cleanup.ok() && cleanup.status() !== 404) {
          throw new Error(`delete ${STACK_NAME} failed with ${cleanup.status()}`);
        }
      }
    } finally {
      await disposePrefUser(prefUser, admin);
    }
  });

  test('Fixed preserves the existing stack detail split without a separator', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);
    await openStack(page, STACK_NAME);
    await expect(separator(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);
    await context.close();
  });

  test('Resizable drags the right pane, commits on release, and survives reload', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);
    await openAppearanceSettings(page);
    await anatomyModeOption(page, 'Resizable').click();
    await expectStoredAppearance(page.request, prefUser!.userId, { anatomyMode: 'resizable', anatomyWidth: 480 });
    await openStack(page, STACK_NAME);
    await expect(pane(page)).toHaveAttribute('style', /width: 480px/);

    let widthWrites = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/user-preferences/appearance')
        && (request.postDataJSON() as Record<string, unknown>).anatomyWidth !== undefined) {
        widthWrites += 1;
      }
    });
    const box = await separator(page).boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 48, startY, { steps: 4 });
    expect(widthWrites).toBe(0);
    await page.mouse.up();
    await expect(pane(page)).toHaveAttribute('style', /width: 432px/);
    await expect.poll(() => widthWrites).toBe(1);
    await expectStoredAppearance(page.request, prefUser!.userId, { anatomyMode: 'resizable', anatomyWidth: 432 });

    await page.reload();
    await waitForShellReady(page);
    await expect(pane(page)).toHaveAttribute('style', /width: 432px/);
    await context.close();
  });

  test('keyboard bounds and targeted reset leave the sidebar preference untouched', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);
    await openStack(page, STACK_NAME);

    await separator(page).focus();
    await page.keyboard.press('Home');
    await expect(pane(page)).toHaveAttribute('style', /width: 320px/);
    await expectStoredAppearance(page.request, prefUser!.userId, { anatomyWidth: 320 });

    const gridBox = await separator(page).locator('..').boundingBox();
    const separatorBox = await separator(page).boundingBox();
    expect(gridBox).not.toBeNull();
    expect(separatorBox).not.toBeNull();
    const expectedMaximum = Math.floor(gridBox!.width - 320 - separatorBox!.width);
    await page.keyboard.press('End');
    await expect(pane(page)).toHaveAttribute('style', new RegExp(`width: ${expectedMaximum}px`));
    await expectStoredAppearance(page.request, prefUser!.userId, { anatomyWidth: expectedMaximum });
    const primaryPaneBox = await page.getByTestId('stack-detail-primary-pane').boundingBox();
    expect(primaryPaneBox).not.toBeNull();
    expect(Math.abs(primaryPaneBox!.width - 320)).toBeLessThanOrEqual(1);

    await putDomain(page.request, prefUser!.userId, 'appearance', {
      ...APPEARANCE_DOC,
      sidebarMode: 'resizable',
      sidebarWidth: 400,
      anatomyMode: 'resizable',
      anatomyWidth: 800,
    });
    await page.reload();
    await waitForShellReady(page);
    await openAppearanceSettings(page);
    await page.getByRole('button', { name: 'Reset Anatomy panel layout' }).click();
    await expectStoredAppearance(page.request, prefUser!.userId, {
      anatomyMode: 'fixed', anatomyWidth: 640, sidebarMode: 'resizable', sidebarWidth: 400,
    });
    await context.close();
  });

  test('phone stack detail never renders the desktop Anatomy separator', async ({ browser }) => {
    await putDomain(prefUser!.request, prefUser!.userId, 'appearance', {
      ...APPEARANCE_DOC,
      anatomyMode: 'resizable',
      anatomyWidth: 720,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/nodes/local/stacks/${encodeURIComponent(STACK_NAME)}`);
    await expect(page.getByRole('tablist', { name: 'Stack detail sections' })).toBeVisible({ timeout: 15_000 });
    await expect(separator(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);
    await context.close();
  });
});
