/**
 * Mobile compose/.env editing (below the md breakpoint).
 *
 * Logs in and creates the stack at desktop width (the create dialog and stack
 * list are desktop-driven), then resizes to a phone viewport so EditorView
 * renders MobileStackDetail. Covers the acceptance-criteria flows: open on
 * mobile, edit compose, save, save-and-deploy guard, and discard dirty changes.
 * Phone widths exercised: 390px and 430px. The compose/.env toggle and env-file
 * save share the same handlers and are covered by MobileStackDetail.test.tsx.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const TEST_STACK = 'e2e-mobile-edit-stack';
const PHONE_390 = { width: 390, height: 844 };
const PHONE_430 = { width: 430, height: 932 };

async function deleteTestStack(page: Page) {
    await page.evaluate(async (name) => {
        await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => { });
    }, TEST_STACK);
}

async function createTestStack(page: Page) {
    await page.getByRole('button', { name: 'Create Stack' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await page.locator('#create-stack-name').fill(TEST_STACK);
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
}

// Open the freshly created stack in the editor (desktop), then drop to a phone
// viewport so the mobile detail surface renders, and select the Compose segment.
async function openComposeOnPhone(page: Page, viewport = PHONE_390) {
    await page.locator('[role="listbox"]').getByText(TEST_STACK, { exact: true }).click();
    await page.setViewportSize(viewport);
    await page.getByRole('tab', { name: 'Compose' }).click();
}

async function openEditor(page: Page) {
    await page.getByRole('button', { name: 'edit' }).click();
    await expect(page.getByTestId('mobile-compose-editor')).toBeVisible({ timeout: 5_000 });
}

test.describe('mobile stack editing', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page);
        await waitForStacksLoaded(page);
        await deleteTestStack(page);
        await page.reload();
        await loginAs(page);
        await waitForStacksLoaded(page);
        await createTestStack(page);
    });

    test.afterEach(async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await deleteTestStack(page);
    });

    test('edits and saves the compose file from a phone (390px)', async ({ page }) => {
        await openComposeOnPhone(page);
        await openEditor(page);

        await page.getByTestId('mobile-compose-editor').fill('services:\n  app:\n    image: nginx:1.27\n    restart: always\n');
        await page.getByTestId('mobile-editor-save').click();

        await expect(page.getByText(/file saved successfully/i)).toBeVisible({ timeout: 5_000 });

        // The edit must actually reach disk, not just flash a toast.
        const onDisk = await page.evaluate(async (name) => {
            const res = await fetch(`/api/stacks/${name}`, { credentials: 'include' });
            return res.text();
        }, TEST_STACK);
        expect(onDisk).toContain('nginx:1.27');
    });

    test('does not deploy when the save PUT fails', async ({ page }) => {
        await page.route(`**/api/stacks/${TEST_STACK}`, async (route, req) => {
            if (req.method() === 'PUT') {
                await route.fulfill({ status: 500, body: 'forced save failure' });
                return;
            }
            await route.continue();
        });
        let deployAttempts = 0;
        await page.route(`**/api/stacks/${TEST_STACK}/deploy*`, async (route, req) => {
            if (req.method() === 'POST') deployAttempts += 1;
            await route.continue();
        });

        await openComposeOnPhone(page);
        await openEditor(page);
        await page.getByTestId('mobile-editor-save-deploy').click();

        await expect(page.getByText(/failed to save file/i)).toBeVisible({ timeout: 5_000 });
        await page.waitForTimeout(1_000);
        expect(deployAttempts).toBe(0);
    });

    test('guards a dirty close and discards on confirm', async ({ page }) => {
        await openComposeOnPhone(page);
        await openEditor(page);

        await page.getByTestId('mobile-compose-editor').fill('services:\n  app:\n    image: nginx:1.28\n');
        await page.getByTestId('mobile-editor-close').click();

        const dialog = page.getByRole('alertdialog', { name: /discard unsaved changes/i });
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await page.getByRole('button', { name: 'Discard changes' }).click();

        // The editor closes back to the read-only Compose segment.
        await expect(page.getByTestId('mobile-compose-editor')).toBeHidden();
        await expect(page.getByRole('button', { name: 'edit' })).toBeVisible();
    });

    test('opens a usable editor at 430px', async ({ page }) => {
        await openComposeOnPhone(page, PHONE_430);
        await openEditor(page);

        await expect(page.getByTestId('mobile-compose-editor')).toBeVisible();
        await expect(page.getByTestId('mobile-editor-save')).toBeVisible();
        await expect(page.getByTestId('mobile-editor-save-deploy')).toBeVisible();
    });
});
