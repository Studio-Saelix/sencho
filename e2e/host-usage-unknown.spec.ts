/**
 * Host usage unknown: a Sencho (or Pilot) container nested in an LXC cannot
 * measure the Docker host's CPU or memory unless the host cgroup is mounted.
 * The dashboard must then show the Docker host's capacity, `--` for usage, and
 * the docs link, at desktop and phone width.
 *
 * `/api/system/stats` is stubbed with the nested payload so the spec does not
 * depend on the machine running it. Everything else is the real app.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

const GiB = 1024 ** 3;

const NESTED_STATS = {
  cpu: { usage: null, cores: 2 },
  memory: { total: 4 * GiB, used: null, free: null, usagePercent: null },
  disk: { fs: '/dev/sda1', mount: '/', total: 100 * GiB, used: 40 * GiB, free: 60 * GiB, usagePercent: '40.0' },
  network: { rxBytes: 0, txBytes: 0, rxSec: 0, txSec: 0 },
};

const DOCS_HREF = /#docker-hosts-inside-an-lxc-or-another-container$/;

// Counts are stubbed too: the verdict must be Healthy so the reasons line can
// only come from the unknown usage, not from a busy host running the suite.
const IDLE_STATS = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };

async function stubNestedStats(page: Page): Promise<void> {
  await page.route('**/api/system/stats**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NESTED_STATS) }));
  await page.route('**/api/stats**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/stats') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(IDLE_STATS) });
  });
}

test.describe('host usage unknown', () => {
  test('desktop dashboard shows capacity, placeholders, and the docs link', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubNestedStats(page);
    await loginAs(page);

    await expect(page.getByText('2 cores · usage unknown')).toBeVisible();
    await expect(page.getByText('4 GB total · usage unknown')).toBeVisible();
    const links = page.getByRole('link', { name: /Show usage/i });
    expect(await links.count()).toBeGreaterThan(0);
    await expect(links.first()).toHaveAttribute('href', DOCS_HREF);

    // The verdict stays healthy, but names what it cannot see.
    await expect(page.getByText('CPU and memory usage unknown')).toBeVisible();
    await expect(page.getByText('All systems nominal')).toHaveCount(0);
  });

  test('phone dashboard keeps the placeholder and the link', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubNestedStats(page);
    await loginAs(page);
    // The phone shell opens on Stacks; Home is the surface under test.
    await page.getByRole('button', { name: 'Home', exact: true }).click();

    await expect(page.getByText('usage unknown').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Show usage/i }).first()).toHaveAttribute('href', DOCS_HREF);
  });
});
