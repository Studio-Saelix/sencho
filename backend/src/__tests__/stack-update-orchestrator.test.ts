/**
 * Unit tests for StackUpdateOrchestrator dispatch: the stack branch runs
 * ComposeService.updateStack (side effects stay with callers), the service
 * branch hard-rejects any non-manual trigger, and a single-service stack is
 * refused with the stable `service_update_single_service` code before any
 * mutation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EffectiveServiceModelResult, EffectiveServiceSpec } from '../services/effectiveServiceModel';

const { state } = vi.hoisted(() => ({
  state: {
    updateStack: vi.fn(),
    model: null as EffectiveServiceModelResult | null,
  },
}));

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({ updateStack: state.updateStack }),
  },
}));

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: vi.fn(async () => state.model),
}));

import { StackUpdateOrchestrator, evaluateServiceReplicaConvergence, shortImageId } from '../services/StackUpdateOrchestrator';

const orch = () => StackUpdateOrchestrator.getInstance();

function spec(name: string): EffectiveServiceSpec {
  return { name, declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false };
}

beforeEach(() => {
  state.updateStack.mockReset();
  state.updateStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
  state.model = null;
});

describe('evaluateServiceReplicaConvergence', () => {
  it('converges when the exact expected running replicas share one image', () => {
    expect(evaluateServiceReplicaConvergence('api', 3, ['sha:a', 'sha:a', 'sha:a'], 0)).toEqual({
      kind: 'converged', imageId: 'sha:a',
    });
  });

  it('reports divergent when running replica count is below expected', () => {
    const result = evaluateServiceReplicaConvergence('api', 3, ['sha:a'], 0);
    expect(result).toMatchObject({ kind: 'divergent' });
    expect((result as { error: string }).error).toMatch(/1 running.*expected 3/i);
  });

  it('reports divergent when no running replicas remain', () => {
    const result = evaluateServiceReplicaConvergence('api', 2, [], 0);
    expect(result).toMatchObject({ kind: 'divergent' });
    expect((result as { error: string }).error).toMatch(/no running replicas/i);
  });

  it('reports divergent when replicas disagree on image', () => {
    const result = evaluateServiceReplicaConvergence('api', 2, ['sha:a', 'sha:b'], 0);
    expect(result).toMatchObject({ kind: 'divergent' });
    expect((result as { error: string }).error).toMatch(/did not converge/i);
  });

  it('reports inspect_failed when every inspect failed', () => {
    expect(evaluateServiceReplicaConvergence('api', 2, [], 2)).toMatchObject({ kind: 'inspect_failed' });
  });

  it('treats scale-zero as converged with a null image', () => {
    expect(evaluateServiceReplicaConvergence('api', 0, [], 0)).toEqual({ kind: 'converged', imageId: null });
  });
});

describe('shortImageId', () => {
  it('strips the sha256 prefix and truncates', () => {
    expect(shortImageId('sha256:abcdef0123456789')).toBe('abcdef012345');
  });
});

describe('StackUpdateOrchestrator stack branch', () => {
  it('runs ComposeService.updateStack and returns stack_compose_done', async () => {
    const result = await orch().execute(
      { nodeId: 0, stackName: 'web', target: { scope: 'stack' }, trigger: 'manual', actor: 'tester' },
      { atomic: true, terminalWs: null },
    );
    expect(result).toEqual({ kind: 'stack_compose_done', recoveryId: null });
    expect(state.updateStack).toHaveBeenCalledWith('web', undefined, true);
    // recoveryId is forwarded from ComposeService.updateStack
  });
});

describe('StackUpdateOrchestrator service branch guards', () => {
  it('rejects a service-scoped update with a non-manual trigger', async () => {
    await expect(
      orch().execute(
        { nodeId: 0, stackName: 'web', target: { scope: 'service', serviceName: 'app' }, trigger: 'scheduled', actor: 'system' },
        { policyOptions: { bypass: false, actor: 'system' } },
      ),
    ).rejects.toThrow(/manual/i);
    expect(state.updateStack).not.toHaveBeenCalled();
  });

  it('refuses a single-service stack with code service_update_single_service', async () => {
    state.model = { renderable: true, services: [spec('only')] };
    const result = await orch().execute(
      { nodeId: 0, stackName: 'web', target: { scope: 'service', serviceName: 'only' }, trigger: 'manual', actor: 'tester' },
      { policyOptions: { bypass: false, actor: 'tester' } },
    );
    expect(result).toMatchObject({ kind: 'service_failed', code: 'service_update_single_service' });
    expect(state.updateStack).not.toHaveBeenCalled();
  });

  it('fails closed when the effective model cannot render', async () => {
    state.model = { renderable: false, code: 'effective_model_render_failed', error: 'boom' };
    const result = await orch().execute(
      { nodeId: 0, stackName: 'web', target: { scope: 'service', serviceName: 'app' }, trigger: 'manual', actor: 'tester' },
      { policyOptions: { bypass: false, actor: 'tester' } },
    );
    expect(result).toMatchObject({ kind: 'service_failed', code: 'effective_model_render_failed' });
  });
});
