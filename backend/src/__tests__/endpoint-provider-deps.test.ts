import { describe, expect, it, vi } from 'vitest';
import type { ProviderReplacePlan } from '../helpers/endpointProviderReplace';
import type { HandoffFileSystem } from '../helpers/handoffFile';

const { dockerOptions } = vi.hoisted(() => ({ dockerOptions: vi.fn() }));

vi.mock('dockerode', () => ({
  default: class {
    constructor(options: unknown) {
      dockerOptions(options);
    }
  },
}));

import { buildDeps, HELPER_DOCKER_TIMEOUT_MS } from '../helpers/endpointProviderDeps';

const plan: ProviderReplacePlan = {
  schemaVersion: 1,
  operationId: '3f2b8c1e-5a4d-4e7f-9b2a-1c3d5e7f9a0b',
  mode: 'reapply',
  scope: 'provider',
  project: 'stack',
  workingDir: '/srv/stack',
  configFiles: ['/srv/stack/compose.yaml'],
  providerService: 'socket-proxy',
  senchoService: 'sencho',
  providerContainerId: 'proxy-id',
  composeCopy: null,
  pruneOnUpdate: false,
  providerReadySeconds: 60,
  ackSeconds: 180,
};

const handoffFs: HandoffFileSystem = {
  writeFile: vi.fn(),
  chmod: vi.fn(),
  chown: vi.fn(),
  rename: vi.fn(),
};

describe('helper Docker client', () => {
  it('bounds every helper Docker call so a hung socket cannot stall rollback', () => {
    buildDeps(plan, null, handoffFs, 1000);
    expect(HELPER_DOCKER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(dockerOptions).toHaveBeenCalledWith({
      socketPath: '/var/run/docker.sock',
      timeout: HELPER_DOCKER_TIMEOUT_MS,
    });
  });
});
