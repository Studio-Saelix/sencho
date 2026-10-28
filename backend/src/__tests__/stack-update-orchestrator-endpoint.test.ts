/**
 * The Docker endpoint guard inside the service-scoped update and restore paths
 * of StackUpdateOrchestrator: the up-front refusal leaves nothing behind, and a
 * refusal raised inside the Compose call (the in-lock re-check) keeps its code
 * instead of becoming a generic compose failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EffectiveServiceModelResult, EffectiveServiceSpec } from '../services/effectiveServiceModel';

const { state } = vi.hoisted(() => ({
  state: {
    evaluateDockerEndpoint: vi.fn(),
    updateService: vi.fn(),
    recreateServiceFromLocal: vi.fn(),
    prepare: vi.fn(),
    claim: vi.fn(),
    reactivate: vi.fn(),
    invalidate: vi.fn(),
    createIfEligible: vi.fn(),
    tag: vi.fn(),
    model: null as EffectiveServiceModelResult | null,
  },
}));

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      evaluateDockerEndpoint: state.evaluateDockerEndpoint,
      updateService: state.updateService,
      recreateServiceFromLocal: state.recreateServiceFromLocal,
    }),
  },
}));

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: vi.fn(async () => state.model),
}));

vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: {
    getInstance: () => ({ isRestoredCurrentPinActive: () => false }),
  },
}));

vi.mock('../services/HealthGateService', () => ({
  HealthGateService: { getInstance: () => ({ prepare: state.prepare }) },
}));

vi.mock('../services/AutoHealService', () => ({
  AutoHealService: { getInstance: () => ({ suppress: vi.fn(), clearSuppress: vi.fn() }) },
}));

vi.mock('../services/PolicyEnforcement', () => ({
  enforcePolicyForImageRefs: vi.fn().mockResolvedValue({ ok: true, bypassed: false, violations: [] }),
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([]),
        getImage: () => ({ inspect: vi.fn().mockResolvedValue({ Id: 'sha256:held', RepoDigests: [] }), tag: state.tag }),
      }),
    }),
  },
}));

vi.mock('../services/ServiceUpdateRecoveryService', () => ({
  ServiceUpdateRecoveryService: {
    getInstance: () => ({
      get: () => ({
        id: 'rec-1',
        node_id: 0,
        stack_name: 'web',
        service_name: 'socket-proxy',
        status: 'active',
        majority_image_id: 'sha256:held',
        declared_image_ref: 'proxy:1',
        replicas_json: '[]',
      }),
      claim: state.claim,
      startClaimRenewal: vi.fn(),
      stopClaimRenewal: vi.fn(),
      reactivate: state.reactivate,
      invalidate: state.invalidate,
      createIfEligible: state.createIfEligible,
    }),
  },
}));

import { StackUpdateOrchestrator } from '../services/StackUpdateOrchestrator';
import { DockerEndpointProtectedError } from '../helpers/dockerEndpointError';

const orch = () => StackUpdateOrchestrator.getInstance();
const policyOptions = { bypass: false, actor: 'tester' };
const refusal = { reason: 'provider' as const, service: 'socket-proxy', message: 'Service "socket-proxy" carries the Docker connection.' };

function spec(name: string): EffectiveServiceSpec {
  return { name, declaredImage: 'proxy:1', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false };
}

const ctx = {
  nodeId: 0, stackName: 'web', target: { scope: 'service' as const, serviceName: 'socket-proxy' }, trigger: 'manual' as const, actor: 'tester',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.model = { renderable: true, services: [spec('app'), spec('socket-proxy')] };
  state.evaluateDockerEndpoint.mockResolvedValue(null);
  state.updateService.mockResolvedValue(undefined);
  state.recreateServiceFromLocal.mockResolvedValue(undefined);
  state.prepare.mockResolvedValue({ prepareToken: 'tok', snapshotOk: true });
  state.claim.mockReturnValue({ id: 'rec-1' });
  state.createIfEligible.mockReturnValue({ eligible: false });
  state.tag.mockResolvedValue(undefined);
});

describe('service-scoped update', () => {
  it('keeps the refusal code when the guard refuses inside the compose call, without a generic compose failure', async () => {
    state.updateService.mockRejectedValue(new DockerEndpointProtectedError(refusal));

    const result = await orch().execute(ctx, { policyOptions });

    expect(result).toMatchObject({
      kind: 'service_failed',
      code: 'docker_endpoint_protected',
      error: refusal.message,
      mutationStage: 'compose',
    });
  });

  it('still reports any other compose error as a compose failure', async () => {
    state.updateService.mockRejectedValue(new Error('pull access denied'));

    const result = await orch().execute(ctx, { policyOptions });

    expect(result).toMatchObject({ kind: 'service_failed', code: 'service_update_compose_failed', error: 'pull access denied' });
  });

  it('refuses up front, before the gate is prepared or any compose call', async () => {
    state.evaluateDockerEndpoint.mockResolvedValue(refusal);

    const result = await orch().execute(ctx, { policyOptions });

    expect(result).toMatchObject({ kind: 'service_failed', code: 'docker_endpoint_protected' });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.updateService).not.toHaveBeenCalled();
  });
});

describe('service-scoped restore', () => {
  const restoreOptions = { policyOptions, recoveryId: 'rec-1' };

  it('refuses up front, before the claim, the retag, or the gate', async () => {
    state.evaluateDockerEndpoint.mockResolvedValue(refusal);

    const result = await orch().execute(ctx, restoreOptions);

    expect(result).toMatchObject({ kind: 'service_failed', code: 'docker_endpoint_protected', error: refusal.message, recoveryId: 'rec-1' });
    expect(state.claim).not.toHaveBeenCalled();
    expect(state.tag).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.recreateServiceFromLocal).not.toHaveBeenCalled();
  });

  it('keeps the refusal code when the guard refuses inside the recreate, and gives the claimed recovery back', async () => {
    state.recreateServiceFromLocal.mockRejectedValue(new DockerEndpointProtectedError(refusal));

    const result = await orch().execute(ctx, restoreOptions);

    expect(result).toMatchObject({
      kind: 'service_failed',
      code: 'docker_endpoint_protected',
      error: refusal.message,
      mutationStage: 'compose',
      recoveryId: 'rec-1',
    });
    // The snapshot was claimed before the refusal; it must be restorable again.
    expect(state.reactivate).toHaveBeenCalledWith('rec-1');
    expect(state.invalidate).not.toHaveBeenCalled();
  });

  it('still reports any other recreate error as a restore compose failure', async () => {
    state.recreateServiceFromLocal.mockRejectedValue(new Error('no such image'));

    const result = await orch().execute(ctx, restoreOptions);

    expect(result).toMatchObject({ kind: 'service_failed', code: 'restore_compose_failed', error: 'no such image' });
  });
});
