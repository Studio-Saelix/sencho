/**
 * Bootstrap wizard: directory model, plan preview and invalidation.
 *
 * The bootstrap endpoints are intercepted, so this spec exercises the real
 * dialog without an SSH host. It proves the defaults come from the capabilities
 * response, both directories appear in the plan, and a path edit removes the
 * plan until the preflight runs again.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs } from './helpers';
import type { FleetNode } from '../frontend/src/components/FleetView/types';

const NODE: FleetNode = {
  id: 1,
  name: 'sencho-test-01',
  type: 'remote',
  mode: 'pilot_agent',
  status: 'online',
  stats: { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 },
  systemStats: null,
  stacks: [],
  cordoned: false,
  cordoned_at: null,
  cordoned_reason: null,
};

const CAPABILITIES = {
  supported: { os: ['ubuntu-22.04', 'ubuntu-24.04'], arch: ['x86_64'] },
  defaults: { composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent' },
  fixed: {
    projectName: 'sencho-agent',
    containerName: 'sencho-agent',
    dataVolume: 'sencho-agent-data',
    dataMount: '/app/data',
    image: 'saelix/sencho:latest',
  },
  limits: {
    maxPathLength: 200,
    blockBelowComposeFreeBytes: 2147483648,
    warnBelowComposeFreeBytes: 5368709120,
    blockBelowAgentFreeBytes: 536870912,
    warnBelowAgentFreeBytes: 1073741824,
    blockBelowDockerRootFreeBytes: 2147483648,
    warnBelowDockerRootFreeBytes: 5368709120,
  },
  pathPolicy: { reservedPrefixes: ['/etc'], exactRoots: ['/opt'], deniedFilesystems: ['tmpfs'] },
};

function pathFacts(input: string, exists: boolean) {
  return {
    input,
    normalized: input,
    realPath: input,
    exists,
    isDirectory: exists,
    isFinalSymlink: false,
    hasSymlinkAncestor: false,
    owner: exists ? 'ubuntu' : null,
    group: exists ? 'ubuntu' : null,
    mode: exists ? '755' : null,
    readableByUser: exists,
    writableByUser: exists,
    writableBySudo: exists,
    parentWritableByUser: true,
    nearestExistingAncestor: exists ? null : '/opt',
    filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
    freeBytes: 100 * 1024 ** 3,
    probeError: null,
  };
}

function planFor(composeDir: string, agentDir: string) {
  const digest = `${composeDir}|${agentDir}`.replace(/[^a-z0-9]/gi, '').padEnd(64, '0').slice(0, 64);
  return {
    version: 1,
    generatedAt: 1_762_300_000_000,
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    targetName: 'media-server',
    hostKeyFingerprint: 'SHA256:abc',
    hubUrl: 'https://sencho.example.com',
    paths: {
      composeDir: { input: composeDir, realPath: composeDir, exists: composeDir === '/opt/docker/sencho', created: composeDir !== '/opt/docker/sencho', stackCount: 0 },
      agentDir: { input: agentDir, realPath: agentDir, exists: false, created: true },
    },
    projectName: 'sencho-agent',
    containerName: 'sencho-agent',
    dataVolume: 'sencho-agent-data',
    image: { ref: 'saelix/sencho:latest', digest: null, resolvedAt: 'execution' },
    stages: [
      {
        id: 'agent_dir',
        title: 'Pilot Agent installation directory',
        steps: [{
          id: 'create-agent-dir',
          title: 'Create the Agent installation directory',
          rationale: 'The agent keeps its compose file in a dedicated directory.',
          effect: 'directory-create',
          privilege: 'user',
          command: `sh -c 'set -eu ...' sencho-mkdir '${agentDir}' '0700' 'ubuntu' 'ubuntu' '0' '${agentDir}' '64768:2:1000:2026-01-01'`,
          target: { path: agentDir, mode: '0700', owner: 'ubuntu', group: 'ubuntu', preserveExisting: false },
          disruptive: false,
          reversible: 'yes',
          pointOfNoReturn: false,
          timeoutMs: 10_000,
        }],
      },
      {
        id: 'agent_project',
        title: 'Agent files',
        steps: [{
          id: 'agent-compose-file',
          title: 'Write the Pilot compose file',
          rationale: 'The agent runs from this file.',
          effect: 'file-write',
          privilege: 'sudo',
          command: null,
          target: { path: `${agentDir}/compose.yaml`, mode: '0600', owner: 'root', group: 'root', preserveExisting: false },
          file: {
            path: `${agentDir}/compose.yaml`,
            mode: '0600',
            content: `name: sencho-agent\nSENCHO_ENROLL_TOKEN: {{SENCHO_ENROLL_TOKEN}}\nCOMPOSE_DIR: "${composeDir}"`,
            redacted: true,
          },
          disruptive: false,
          reversible: 'yes',
          pointOfNoReturn: false,
          timeoutMs: 10_000,
        }],
      },
      {
        id: 'agent_start',
        title: 'Start the Pilot agent',
        steps: [{
          id: 'start-agent',
          title: 'Start the sencho-agent project',
          rationale: 'Pinned project name.',
          effect: 'container-start',
          privilege: 'sudo',
          command: `sh -c 'set -eu ... exec env -u DOCKER_HOST docker compose --project-name sencho-agent --project-directory . -f ./compose.yaml up -d' sencho-start '${agentDir}' '${agentDir}' '/opt/docker/sencho' '/opt/docker/sencho'`,
          disruptive: true,
          reversible: 'yes',
          pointOfNoReturn: true,
          timeoutMs: 300_000,
        }],
      },
    ],
    skipped: [],
    sources: [],
    versions: {},
    redactions: [{ placeholder: '{{SENCHO_ENROLL_TOKEN}}', purpose: 'Minted at execution.' }],
    verification: [{ id: 'project-exists', title: 'The sencho-agent project exists', expected: 'docker compose ls lists it', slice: 'S2' }],
    notices: ['No changes have been made on this server.'],
    evidenceDigest: 'a'.repeat(64),
    digest,
  };
}

function inspection(composeDir: string, agentDir: string) {
  return {
    observedAt: 1_762_300_000_000,
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'server.example.com ssh-ed25519 AAAA' },
    paths: {
      composeDir: { ...pathFacts(composeDir, composeDir === '/opt/docker/sencho'), stackCount: 0, stackNames: [], inventoryTruncated: false, rootComposeFile: false },
      agentDir: { ...pathFacts(agentDir, false), entries: [], entriesTruncated: false, hasComposeFile: false, hasCaFile: false, hasMarker: false, markerProject: null, markerComposeDir: null, markerAgentDir: null },
    },
    agent: { projectContainers: [], dataVolumeExists: false, defaultDirHasComposeFile: false },
    dockerRoot: { path: '/var/lib/docker', freeBytes: 100 * 1024 ** 3, filesystemType: 'ext4' },
    checks: [
      { id: 'ssh_host_key', category: 'identity', label: 'SSH host key', status: 'pass', summary: 'The host key matches the fingerprint you reviewed.' },
      { id: 'compose_dir', category: 'paths', label: 'Compose stacks directory', status: 'pass', summary: `${composeDir} is writable.` },
      { id: 'agent_dir', category: 'paths', label: 'Pilot Agent installation directory', status: 'pass', summary: `${agentDir} will be created when the plan runs.` },
    ],
    blockers: 0,
    warnings: 0,
  };
}

async function mockBootstrap(page: Page): Promise<void> {
  await page.route('**/api/fleet/overview*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([NODE]) }));
  await page.route('**/api/fleet/update-status*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nodes: [] }) }));
  await page.route('**/api/nodes/bootstrap/capabilities*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CAPABILITIES) }));
  await page.route('**/api/nodes/bootstrap/host-key*', (route: Route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      host: 'server.example.com',
      port: 22,
      address: '192.168.1.50',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
      trust: 'unknown',
      pinnedFingerprint: null,
    }),
  }));
  await page.route('**/api/nodes/bootstrap/preflight*', (route: Route) => {
    const body = route.request().postDataJSON() as { composeDir: string; agentDir: string };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        inspection: inspection(body.composeDir, body.agentDir),
        plan: planFor(body.composeDir, body.agentDir),
        blocked: false,
      }),
    });
  });
}

async function openWizard(page: Page) {
  await page.getByRole('button', { name: 'Node management' }).click();
  await page.getByRole('menuitem', { name: /Bootstrap new Linux server/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function fillConnection(page: Page) {
  await page.getByLabel('Node name').fill('media-server');
  await page.getByLabel('Host').fill('server.example.com');
  await page.getByLabel('SSH user').fill('ubuntu');
  await page.getByLabel('Private key').fill('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----');
}

test.describe('Node bootstrap wizard', () => {
  test('starts with both defaults and one collapsed Advanced section', async ({ page }) => {
    await loginAs(page);
    await mockBootstrap(page);
    await page.goto('/nodes/local/fleet');
    await openWizard(page);

    await expect(page.getByLabel('Compose stacks directory')).toHaveValue('/opt/docker/sencho');
    const advanced = page.getByRole('button', { name: /Advanced configuration/ });
    await expect(advanced).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel('Pilot Agent installation directory')).toHaveCount(0);
    await advanced.click();
    await expect(page.getByLabel('Pilot Agent installation directory')).toHaveValue('/opt/sencho-agent');
  });

  test('shows a custom pair in the plan, then invalidates it when a path changes', async ({ page }) => {
    await loginAs(page);
    await mockBootstrap(page);
    await page.goto('/nodes/local/fleet');
    await openWizard(page);
    await fillConnection(page);

    await page.getByLabel('Compose stacks directory').fill('/srv/sencho-stacks');
    await page.getByRole('button', { name: /Advanced configuration/ }).click();
    await page.getByLabel('Pilot Agent installation directory').fill('/srv/sencho-agent');
    await page.getByRole('button', { name: /Advanced configuration/ }).click();
    await expect(page.getByRole('button', { name: /Advanced configuration/ })).toContainText('/srv/sencho-agent');

    await page.getByRole('button', { name: 'Check host key' }).click();
    await page.getByRole('checkbox', { name: /I trust this host key/ }).check();
    await page.getByRole('button', { name: 'Run preflight' }).click();

    await expect(page.getByText('1. Pilot Agent installation directory')).toBeVisible();
    await expect(page.getByText('Not changed')).toBeVisible();
    await expect(page.getByText('/srv/sencho-stacks').first()).toBeVisible();
    await expect(page.getByText('/srv/sencho-agent').first()).toBeVisible();
    await expect(page.getByText(/sencho-mkdir .* '0700'/)).toBeVisible();
    await expect(page.getByText(/--project-name sencho-agent/)).toBeVisible();
    await expect(page.getByText('No changes have been made on this server.').first()).toBeVisible();
    const firstDigest = await page.locator('code', { hasText: /^sha256:/ }).innerText();

    await page.getByRole('button', { name: 'Back to inspection' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByLabel('Compose stacks directory').fill('/srv/other-stacks');

    await expect(page.getByText(/Paths changed. The previous preflight and plan no longer apply/)).toBeVisible();
    await expect(page.getByText('1. Pilot Agent installation directory')).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue to preflight' }).click();
    await page.getByRole('button', { name: /^Run preflight/ }).click();
    await expect(page.getByText('1. Pilot Agent installation directory')).toBeVisible();
    const secondDigest = await page.locator('code', { hasText: /^sha256:/ }).innerText();
    expect(secondDigest).not.toBe(firstDigest);
  });

  test('approves the reviewed plan in two clicks and follows the run to enrolled', async ({ page }) => {
    await loginAs(page);
    await mockBootstrap(page);
    const operationId = '11111111-1111-4111-8111-111111111111';
    const plan = planFor('/opt/docker/sencho', '/opt/sencho-agent');
    const operation = (state: string, stage: string | null) => ({
      id: operationId, targetName: 'media-server', host: 'server.example.com', port: 22, username: 'ubuntu',
      address: '192.168.1.50', hostKeyFingerprint: 'SHA256:abc', composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent',
      planDigest: plan.digest, approvedBy: 'admin', approvedAt: 1_762_300_000_000, attempt: 1, state, stage, step: null,
      nodeId: state === 'enrolled' ? 7 : null, changesMade: state !== 'rechecking', active: state !== 'enrolled', cancelRequested: false,
      error: null, enrollmentExpiresAt: null, createdAt: 1_762_300_000_000, updatedAt: 1_762_300_000_000, finishedAt: null,
      actions: { cancel: state !== 'enrolled', retry: false, release: false }, plan, events: [],
    });
    let executeBody: Record<string, unknown> | null = null;
    await page.route('**/api/nodes/bootstrap/operations', (route: Route) => {
      if (route.request().method() === 'POST') {
        executeBody = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(operation('rechecking', null)) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operations: [] }) });
    });
    await page.route(`**/api/nodes/bootstrap/operations/${operationId}`, (route: Route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(operation('enrolled', 'enroll')),
    }));

    await page.goto('/nodes/local/fleet');
    await openWizard(page);
    await fillConnection(page);
    await page.getByRole('button', { name: 'Check host key' }).click();
    await page.getByRole('checkbox', { name: /I trust this host key/ }).check();
    await page.getByRole('button', { name: 'Run preflight' }).click();

    await page.getByRole('button', { name: 'Approve and run' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(`Plan sha256:${plan.digest}`);
    expect(executeBody).toBeNull();
    await confirm.getByRole('button', { name: 'Approve and run' }).click();

    await expect(page.getByTestId('bootstrap-run-answer')).toContainText('Re-checking');
    await expect(page.getByTestId('bootstrap-run-answer')).toContainText('readiness for deployments has not been verified', { timeout: 10_000 });
    expect(executeBody).toMatchObject({ planDigest: plan.digest, host: 'server.example.com', targetName: 'media-server' });
  });
});
