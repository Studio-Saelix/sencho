/**
 * Topology reload keeps the canvas mounted, so a response that changes the
 * graph must re-fit the viewport. React Flow's `fitView` prop only frames the
 * nodes present at initialization, and dagre lays every node out again on each
 * response; without a re-fit the refreshed graph renders under the old viewport
 * transform and most of it lands outside the pane.
 *
 * The topology responses are stubbed so the graph can grow between the first
 * load and the in-view Refresh without creating Docker networks. jsdom cannot
 * measure layout, so the assertion reads the rendered node rectangles and the
 * pane rectangle in a real browser.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

interface StubContainer {
  id: string;
  name: string;
  ip: string;
  state: string;
  image: string;
  stack: string | null;
  service: string | null;
  composeAliases: string[];
  publishedPorts: never[];
  exposureIntent: null;
  findingIds: string[];
  driftFlags: string[];
  hostMode: boolean;
}

interface StubNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  stack: string | null;
  isSystem: boolean;
  ingress: boolean;
  ownership: string;
  declaredByStacks: string[];
  declaredExternalByStacks: string[];
  isExternalDependency: boolean;
  findingIds: string[];
  containers: StubContainer[];
}

function topologyNetwork(index: number, containerCount: number): StubNetwork {
  return {
    id: `qa-net-${index}`,
    name: `qa-net-${index}`,
    driver: 'bridge',
    scope: 'local',
    stack: null,
    isSystem: false,
    ingress: false,
    ownership: 'sencho-managed',
    declaredByStacks: [],
    declaredExternalByStacks: [],
    isExternalDependency: false,
    findingIds: [],
    containers: Array.from({ length: containerCount }, (_, position) => ({
      id: `qa-ctr-${index}-${position}`,
      name: `qa-ctr-${index}-${position}`,
      ip: `172.18.${index}.${position + 2}`,
      state: 'running',
      image: 'nginx:alpine',
      stack: null,
      service: null,
      composeAliases: [],
      publishedPorts: [],
      exposureIntent: null,
      findingIds: [],
      driftFlags: [],
      hostMode: false,
    })),
  };
}

function topologyEnvelope(networks: StubNetwork[]) {
  return {
    schemaVersion: 2,
    runtimeAvailable: true,
    generatedAt: new Date().toISOString(),
    includeSystem: false,
    networks,
  };
}

interface GraphMeasurement {
  paneMissing: boolean;
  total: number;
  outside: string[];
  transform: string;
}

async function measureGraph(page: Page): Promise<GraphMeasurement> {
  return page.evaluate(() => {
    const pane = document.querySelector('.react-flow');
    const viewport = document.querySelector('.react-flow__viewport');
    const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
    if (!(pane instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      return { paneMissing: true, total: nodes.length, outside: [], transform: '' };
    }
    const paneRect = pane.getBoundingClientRect();
    const outside = nodes
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left < paneRect.left - 1
          || rect.top < paneRect.top - 1
          || rect.right > paneRect.right + 1
          || rect.bottom > paneRect.bottom + 1;
      })
      .map((node) => node.getAttribute('data-id') ?? '?');
    return {
      paneMissing: false,
      total: nodes.length,
      outside,
      transform: getComputedStyle(viewport).transform,
    };
  });
}

async function expectGraphFitted(page: Page, expectedNodes: number): Promise<void> {
  await expect.poll(
    async () => {
      const graph = await measureGraph(page);
      const fitted = !graph.paneMissing
        && graph.total === expectedNodes
        && graph.outside.length === 0;
      return fitted ? 'fitted' : JSON.stringify(graph);
    },
    {
      message: `expected ${expectedNodes} topology nodes, all inside the pane`,
      timeout: 10_000,
    },
  ).toBe('fitted');
}

test.describe('Networking topology refresh', () => {
  test('a reload that grows the graph re-fits every node inside the pane', async ({ page }) => {
    const initialNetworks = [topologyNetwork(0, 1)];
    const reloadedNetworks = Array.from({ length: 6 }, (_, index) => topologyNetwork(index + 1, 1));
    let phase: 'initial' | 'reloaded' = 'initial';

    // A v2 overview keeps the page out of its legacy lock; the topology itself
    // is the only data this spec varies.
    await page.route('**/api/networking/overview*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 2,
        runtimeAvailable: true,
        generatedAt: new Date().toISOString(),
        overview: null,
        networks: [],
        findings: [],
        recentActivity: [],
      }),
    }));
    await page.route(/\/api\/networking\/topology(?:\?|$)/, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(topologyEnvelope(phase === 'initial' ? initialNetworks : reloadedNetworks)),
    }));

    await loginAs(page);
    await page.goto('/nodes/local/networking');
    await page.getByRole('tab', { name: 'Topology' }).click();

    // First load: 1 network + 1 container, framed by the canvas's initial fit.
    await expectGraphFitted(page, 2);
    const initialTransform = (await measureGraph(page)).transform;

    // Reload: 6 networks with 1 container each, a much wider dagre layout.
    phase = 'reloaded';
    await page.getByRole('button', { name: 'Refresh topology' }).click();
    await expectGraphFitted(page, 12);

    const reloaded = await measureGraph(page);
    expect(reloaded.transform).not.toBe(initialTransform);

    // Filters re-lay out the same mounted canvas, so narrowing and clearing
    // them must re-fit too.
    const networkFilter = page.getByPlaceholder(/Filter network/);
    await networkFilter.fill('qa-net-6');
    await expectGraphFitted(page, 2);
    // The narrowed graph is a different layout; leaving the 12-node fit in
    // place would keep the old transform even though every node happens to sit
    // inside it, so wait for the viewport to actually move.
    await expect.poll(async () => (await measureGraph(page)).transform).not.toBe(reloaded.transform);
    const narrowed = await measureGraph(page);
    expect(narrowed.outside).toEqual([]);
    await networkFilter.fill('');
    await expectGraphFitted(page, 12);
  });
});
