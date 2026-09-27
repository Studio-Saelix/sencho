/**
 * Tests for the async missing-external-networks resolver's render-failure
 * diagnosis.
 *
 * The behaviour under test is what an operator is told when Docker Compose
 * refuses to render a stack's effective model. The three-cause guess list alone
 * cannot name the real fault (a malformed port spec matches none of its
 * suggestions), so Compose's own stderr has to reach the message. These tests
 * pin that, plus the redaction and bound applied to it before it is surfaced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const mockRenderConfig = vi.fn();
const mockGetDependencySnapshot = vi.fn();

vi.mock('../services/ComposeService', () => ({
  ComposeService: { getInstance: () => ({ renderConfig: mockRenderConfig }) },
}));

vi.mock('../services/DockerController', () => ({
  default: { getInstance: () => ({ getDependencySnapshot: mockGetDependencySnapshot }) },
}));

let tmpDir: string;
let resolveMissingExternalNetworks: typeof import('../services/network/resolveMissingExternalNetworks').resolveMissingExternalNetworks;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ resolveMissingExternalNetworks } = await import('../services/network/resolveMissingExternalNetworks'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockRenderConfig.mockReset();
  mockGetDependencySnapshot.mockReset();
  mockGetDependencySnapshot.mockResolvedValue({ networks: [] });
  DatabaseService.getInstance().updateGlobalSetting('env_block_deploy_on_missing_required', '0');
});

/** A render that failed, with the stderr Docker Compose produced. */
function renderFailure(stderr: string, extra: Record<string, unknown> = {}) {
  mockRenderConfig.mockResolvedValue({ rendered: null, stderr, code: 1, timedOut: false, ...extra });
}

describe('resolveMissingExternalNetworks render failures', () => {
  it('quotes the cause Compose reported', async () => {
    renderFailure('invalid proto: udp/tcp');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.status).toBe('render_unavailable');
    expect(result.renderError).toContain('invalid proto: udp/tcp');
    expect(result.networks).toEqual([]);
  });

  it('names the missing variable instead, so the guardrail wording still wins', async () => {
    renderFailure('service "web" refers to undefined variable PUID\nrequired variable "PUID" is missing a value');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.status).toBe('render_unavailable');
    expect(result.renderError).toContain('PUID');
    expect(result.renderError).not.toContain('Could not render the effective Compose model');
  });

  it('redacts a token that Compose echoed into the diagnostic', async () => {
    renderFailure('failed to parse: token=ghp_abcdefghijklmnopqrstuvwxyz012345');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.renderError).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.renderError).toContain('[redacted]');
  });

  it('collapses a multi-line diagnostic onto one line', async () => {
    renderFailure('yaml: line 4: mapping values are not allowed\n  ports:\n   - 443:443/udp/tcp');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.renderError).not.toContain('\n');
    expect(result.renderError).toContain('mapping values are not allowed');
    expect(result.renderError).toContain('- 443:443/udp/tcp');
  });

  it('bounds the quoted diagnostic to 600 characters', async () => {
    renderFailure('x'.repeat(5000));

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    // The detail is the only run of x, so counting it pins the bound exactly
    // rather than merely bounding the whole sentence.
    expect(result.renderError!.match(/x+/g)![0]).toHaveLength(600);
  });

  it('strips control characters before the diagnostic reaches the UI', async () => {
    renderFailure('bad escape:\u001b[31mred\u001b[0m and a tab\there');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    // The ANSI sequences and the tab are gone; the words Compose wrote survive,
    // which is the part the operator actually needs.
    expect(result.renderError).not.toContain('\u001b');
    expect(result.renderError).toContain('[31mred[0m and a tabhere');
  });

  it('surfaces the timeout reason, which renderConfig also reports on stderr', async () => {
    renderFailure('docker compose config timed out', { timedOut: true });

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.renderError).toContain('timed out');
  });

  it('surfaces the output-cap reason, also reported on stderr', async () => {
    renderFailure('Rendered model exceeded the size limit');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.renderError).toContain('exceeded the size limit');
  });

  it('keeps the guidance sentence when Compose said nothing', async () => {
    renderFailure('');

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.renderError).toBe(
      'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.',
    );
  });

  it('reports a docker spawn failure rather than swallowing it', async () => {
    mockRenderConfig.mockRejectedValue(new Error('docker compose could not be started: ENOENT'));

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.status).toBe('render_unavailable');
    expect(result.renderError).toContain('ENOENT');
  });

  it('still reports ok when the model renders and nothing is missing', async () => {
    mockRenderConfig.mockResolvedValue({
      rendered: JSON.stringify({ name: 'my-stack', services: {}, networks: {}, volumes: {} }),
      stderr: '',
      code: 0,
      timedOut: false,
    });

    const result = await resolveMissingExternalNetworks(1, 'my-stack');

    expect(result.status).toBe('ok');
    expect(result.renderError).toBeUndefined();
  });
});
