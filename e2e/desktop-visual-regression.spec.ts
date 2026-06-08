// ---------------------------------------------------------------------------
// Zero-desktop-change gate. Snapshots the top-level views at desktop widths;
// any pixel diff means a desktop base class changed instead of a mobile-only
// `max-md:` override being added.
//
// Runs as its own Playwright project so it never blocks the functional E2E run:
//   npx playwright test --project=visual                 # compare
//   npx playwright test --project=visual --update-snapshots   # (re)baseline
//
// In CI it runs in the Visual Regression workflow against a fresh app (empty
// COMPOSE_DIR, so no stacks). Baselines are platform-specific, so they are
// generated and committed on the Linux runner via that workflow's seed job, not
// locally. Locally, baseline against your own instance with the same command.
//
// stack-detail is intentionally not snapshotted: a fresh CI app has no stack to
// open, and its live log stream is not deterministic. Resources is omitted for
// the same async-Docker-height reason. The shell plus the four content views
// below catch a desktop base-class regression on the mobile-touched surfaces.
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
];

// Paint over genuinely non-deterministic content so it does not cause false
// diffs. Mask only the elements that actually churn between runs, NOT the
// surrounding shell: the rest of the sidebar and the top bar stay unmasked so
// the gate proves they are unchanged. Masked elements keep their box, so a
// layout shift around them still moves unmasked pixels and is caught.
function maskDynamic(page: Page) {
    return [
        // The sidebar activity ticker ("x ago" text + live dot) is the only
        // churning part of the otherwise-static sidebar.
        page.locator('[data-testid="activity-ticker"]'),
        // The top-bar notification count changes as alerts arrive.
        page.locator('[aria-label^="Notifications"]'),
        page.locator('svg'),                              // sparklines / gauges / charts
        page.locator('.xterm'),                           // live terminal (stack detail)
        page.locator('[data-testid="deploy-feedback-pill"]'),
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
                    // The only remaining churn is the in-content live stats that
                    // can't be masked without hiding layout (dashboard gauge
                    // values, fleet node CPU/MEM, per-container stats). This small
                    // budget absorbs that text churn yet stays orders of magnitude
                    // below any real desktop layout shift, so a base-class
                    // regression still fails loudly. Run against a seeded /
                    // frozen-data instance in CI to drop this to 0.
                    maxDiffPixels: 1200,
                });
            });
        }
    });
}
