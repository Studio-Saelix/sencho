/**
 * Self-update eligibility detection: one identity chain, a bounded refusal
 * reason, and the retry that recovers a node whose Docker endpoint was not
 * answering when Sencho started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  identityState: 'resolved' as 'resolved' | 'none' | 'unresolved',
  containerId: 'full-container-id',
  targets: [] as string[],
  inspect: vi.fn(),
  execFile: vi.fn(),
  pending: vi.fn(),
}));

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: state.execFile }));
vi.mock('util', () => ({ promisify: () => state.execFile }));
vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getContainer: (id: string) => {
          state.targets.push(id);
          return { inspect: () => state.inspect() };
        },
      }),
    }),
  },
}));
vi.mock('../services/SelfIdentityService', () => ({
  default: {
    getInstance: () => ({
      ensureResolved: () => Promise.resolve(state.identityState),
      getIdentity: () => ({ containerId: state.containerId }),
    }),
  },
}));
vi.mock('../services/ImageOperationService', () => ({
  ImageOperationService: { getInstance: () => ({ isEndpointProviderPending: state.pending }) },
}));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: { getInstance: () => ({ getGlobalSettings: () => ({}) }) },
}));
vi.mock('../services/DockerEndpointProvider', () => ({
  resolveDockerEndpointProvider: vi.fn(),
}));

import SelfUpdateService from '../services/SelfUpdateService';
import { enableCapability, getActiveCapabilities } from '../services/CapabilityRegistry';
import {
  SELF_UPDATE_RETRY_MAX_MS,
  nextSelfUpdateRetryDelay,
  parseSelfUpdateUnavailableCode,
} from '../helpers/selfUpdateEligibility';

let containerIdSeq = 0;

function inspectInfo(over: {
  labels?: Record<string, string> | null;
  image?: string | null;
} = {}) {
  const labels = over.labels === undefined
    ? {
      'com.docker.compose.project.working_dir': '/srv/sencho',
      'com.docker.compose.project.config_files': '/srv/sencho/compose.yaml',
      'com.docker.compose.service': 'sencho',
      'com.docker.compose.project': 'sencho',
    }
    : over.labels;
  return {
    Id: `container-${++containerIdSeq}`,
    Name: '/sencho',
    Image: 'sha256:running',
    Config: {
      Image: over.image === undefined ? 'saelix/sencho:0.98.2' : over.image,
      ...(labels ? { Labels: labels } : {}),
    },
    Mounts: [{ Type: 'bind', Source: '/srv/sencho/data', Destination: '/app/data' }],
  };
}

type Internals = {
  canSelfUpdate: boolean;
  composeContext: unknown;
  unavailableCode: string;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryDelayMs: number;
  stopped: boolean;
};

function internals(): Internals {
  return SelfUpdateService.getInstance() as unknown as Internals;
}

function resetService(): void {
  vi.useRealTimers();
  const svc = SelfUpdateService.getInstance();
  svc.stop();
  const i = internals();
  i.canSelfUpdate = false;
  i.composeContext = null;
  i.unavailableCode = 'detecting';
  i.retryTimer = null;
  i.retryDelayMs = 5_000;
  i.stopped = false;
  enableCapability('self-update');
  vi.useFakeTimers();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.identityState = 'resolved';
  state.containerId = 'full-container-id';
  state.targets = [];
  state.inspect.mockResolvedValue(inspectInfo());
  state.execFile.mockResolvedValue({ stdout: '' });
  state.pending.mockReturnValue(false);
  process.env.HOSTNAME = 'sencho-custom-hostname';
  resetService();
});

afterEach(() => {
  SelfUpdateService.getInstance().stop();
  vi.useRealTimers();
});

describe('detection identity chain', () => {
  it('inspects the identity-resolved container when HOSTNAME is not the container id', async () => {
    await SelfUpdateService.getInstance().initialize();

    expect(state.targets).toEqual(['full-container-id']);
    expect(SelfUpdateService.getInstance().isAvailable()).toBe(true);
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBeNull();
    expect(getActiveCapabilities()).toContain('self-update');
  });

  it('falls back to HOSTNAME when no container identity resolved (dev)', async () => {
    state.identityState = 'none';
    state.inspect.mockRejectedValue(Object.assign(new Error('no such container'), { statusCode: 404 }));

    await SelfUpdateService.getInstance().initialize();

    expect(state.targets).toEqual(['sencho-custom-hostname']);
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('not_in_container');
    expect(internals().retryTimer).toBeNull();
  });

  it('reports container_unidentified (transient) while identity cannot settle', async () => {
    state.identityState = 'unresolved';

    await SelfUpdateService.getInstance().initialize();

    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('container_unidentified');
    expect(internals().retryTimer).not.toBeNull();
  });
});

describe('refusal reasons', () => {
  it('reports not_compose_managed and schedules no retry when the labels are missing', async () => {
    state.inspect.mockResolvedValue(inspectInfo({ labels: null }));

    await SelfUpdateService.getInstance().initialize();

    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('not_compose_managed');
    expect(internals().retryTimer).toBeNull();
  });

  it('reports image_unknown and schedules no retry when the container has no image name', async () => {
    state.inspect.mockResolvedValue(inspectInfo({ image: '' }));

    await SelfUpdateService.getInstance().initialize();

    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('image_unknown');
    expect(internals().retryTimer).toBeNull();
  });
});

describe('retry after a transient failure', () => {
  it('recovers from an unreachable Docker endpoint without a restart', async () => {
    state.inspect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await SelfUpdateService.getInstance().initialize();
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('docker_unreachable');
    expect(SelfUpdateService.getInstance().isAvailable()).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(SelfUpdateService.getInstance().isAvailable()).toBe(true);
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBeNull();
    expect(getActiveCapabilities()).toContain('self-update');
  });

  it('recovers when the Compose CLI check failed at boot', async () => {
    state.execFile.mockRejectedValueOnce(new Error('spawn EAGAIN'));

    await SelfUpdateService.getInstance().initialize();
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('compose_cli_unavailable');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(SelfUpdateService.getInstance().isAvailable()).toBe(true);
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBeNull();
  });

  it('holds a retry while a Docker endpoint replacement is claimed', async () => {
    state.inspect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    state.pending.mockReturnValue(true);

    await SelfUpdateService.getInstance().initialize();
    const detectionTargetsAfterBoot = state.targets.length;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.targets.length).toBe(detectionTargetsAfterBoot);

    state.pending.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(SelfUpdateService.getInstance().isAvailable()).toBe(true);
  });

  it('keeps retrying when a retry throws unexpectedly', async () => {
    state.inspect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await SelfUpdateService.getInstance().initialize();
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('docker_unreachable');

    // A malformed inspect answer makes the probe throw outside its own guards.
    state.inspect.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(SelfUpdateService.getInstance().getUnavailableCode()).toBe('detecting');
    expect(internals().retryTimer).not.toBeNull();

    state.inspect.mockResolvedValue(inspectInfo());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(SelfUpdateService.getInstance().isAvailable()).toBe(true);
  });

  it('stop() clears the pending retry', async () => {
    state.inspect.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await SelfUpdateService.getInstance().initialize();
    const afterBoot = state.targets.length;
    expect(internals().retryTimer).not.toBeNull();

    SelfUpdateService.getInstance().stop();
    expect(internals().retryTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.targets.length).toBe(afterBoot);
  });
});

describe('backoff', () => {
  it('doubles from 5s and caps at 60s', () => {
    const steps = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]
      .map(delay => nextSelfUpdateRetryDelay(delay));
    expect(steps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(nextSelfUpdateRetryDelay(3_600_000)).toBe(SELF_UPDATE_RETRY_MAX_MS);
  });

  it('keeps retrying on the capped delay instead of giving up', async () => {
    state.inspect.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await SelfUpdateService.getInstance().initialize();

    for (let step = 0; step < 6; step++) {
      await vi.advanceTimersByTimeAsync(SELF_UPDATE_RETRY_MAX_MS);
    }

    expect(internals().retryDelayMs).toBe(SELF_UPDATE_RETRY_MAX_MS);
    expect(internals().retryTimer).not.toBeNull();
  });
});

describe('bounded code parsing', () => {
  it('keeps a known code and rejects anything else', () => {
    expect(parseSelfUpdateUnavailableCode('docker_unreachable')).toBe('docker_unreachable');
    expect(parseSelfUpdateUnavailableCode('detecting')).toBe('detecting');
    expect(parseSelfUpdateUnavailableCode('https://internal.host:2375')).toBeNull();
    expect(parseSelfUpdateUnavailableCode('not a code')).toBeNull();
    expect(parseSelfUpdateUnavailableCode(null)).toBeNull();
    expect(parseSelfUpdateUnavailableCode(7)).toBeNull();
  });
});
