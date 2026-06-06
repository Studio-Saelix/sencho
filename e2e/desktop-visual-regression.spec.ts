// ---------------------------------------------------------------------------
// Zero-desktop-change gate for the mobile work.
//
// Snapshots every top-level view the mobile pass touches, at desktop widths.
// Capture the baseline on the pre-change state, then run again after the mobile
// changes: any pixel diff means a desktop base class was edited instead of a
// mobile-only `max-md:` override being added.
//
//   # baseline (before the mobile changes):
//   E2E_PASSWORD=admin123 npx playwright test desktop-visual-regression --update-snapshots
//   # gate (after the changes):
//   E2E_PASSWORD=admin123 npx playwright test desktop-visual-regression
//
// Snapshots are platform-specific and gitignored; regenerate the baseline in
// the same environment (or a pinned CI/Docker image) you run the gate in.
// ---------------------------------------------------------------------------
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const WIDTHS = [1280, 1440, 1920] as const;
const HEIGHT = 1080;

interface View {
    id: string;
    label: string;
    open: (page: Page) => Promise<void>;
}

// Navigate via the app's real chrome (no router): top-bar buttons by aria-label,
// Settings via the profile menu, stack detail via a sidebar row.
const VIEWS: View[] = [
    { id: 'home', label: 'home', open: async () => { /* dashboard is the landing view */ } },
    { id: 'fleet', label: 'fleet', open: (p) => p.getByRole('button', { name: 'Fleet', exact: true }).click() },
    // Resources is intentionally omitted: its reclaim hero / table height depends
    // on async Docker data that shifts run-to-run, so it is not deterministically
    // snapshot-able in this live environment. Verify its desktop manually, or run
    // this gate against a seeded/frozen-data instance in CI to include it.
    { id: 'app-store', label: 'app-store', open: (p) => p.getByRole('button', { name: 'App Store', exact: true }).click() },
    {
        id: 'settings', label: 'settings', open: async (p) => {
            await p.getByRole('button', { name: /profile/i }).click();
            await p.getByRole('button', { name: 'Settings', exact: true }).click();
        },
    },
    {
        id: 'stack-detail', label: 'stack-detail', open: async (p) => {
            await p.locator('[data-stacks-loaded="true"] [data-testid="stack-row"]').first().click();
            await p.getByText('image', { exact: false }).first().waitFor({ timeout: 10_000 }).catch(() => {});
        },
    },
];

// Paint over genuinely non-deterministic content so it does not cause false
// diffs. These elements occupy the same box, so a layout shift around them
// still moves surrounding unmasked pixels and is caught.
function maskDynamic(page: Page) {
    return [
        // Persistent chrome with live content (the sidebar activity ticker and
        // live status dots, the top bar). Not touched by the mobile pass, and
        // its "x ago" ticker churns every run.
        page.locator('.bg-sidebar'),
        page.locator('svg'),                              // sparklines / gauges / charts
        page.locator('.xterm'),                           // live terminal (stack detail)
        page.locator('[data-testid="deploy-feedback-pill"]'),
        page.locator('[data-testid="ticker-dot"]'),
    ];
}

for (const width of WIDTHS) {
    test.describe(`desktop @ ${width}px must not change`, () => {
        test.use({ viewport: { width, height: HEIGHT } });

        test.beforeEach(async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await loginAs(page);
            await waitForStacksLoaded(page);
        });

        for (const view of VIEWS) {
            test(view.label, async ({ page }) => {
                await view.open(page);
                // Let the fade-up entrance and async data (Docker images, fleet
                // stats) settle before snapshotting so layout height is stable.
                await page.waitForTimeout(1200);
                // Viewport-only (not fullPage): a fixed-height frame removes
                // scroll-height variance from below-fold live data, while the
                // above-fold layout is where a base-class regression shows first.
                await expect(page).toHaveScreenshot(`${view.label}-${width}.png`, {
                    animations: 'disabled',
                    mask: maskDynamic(page),
                    // Live numeric stats (CPU%, memory, latency) churn between runs.
                    // This budget absorbs that few-hundred-pixel text churn while
                    // staying far below any real desktop layout shift, which moves
                    // tens of thousands of pixels. A base-class regression fails loudly.
                    maxDiffPixels: 3000,
                });
            });
        }
    });
}
