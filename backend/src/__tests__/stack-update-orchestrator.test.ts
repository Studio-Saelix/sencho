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

import { StackUpdateOrchestrator } from '../services/StackUpdateOrchestrator';

const orch = () => StackUpdateOrchestrator.getInstance();

function spec(name: string): EffectiveServiceSpec {
  return { name, declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false };
}

beforeEach(() => {
  state.updateStack.mockReset();
  state.updateStack.mockResolvedValue(undefined);
  state.model = null;
});

describe('StackUpdateOrchestrator stack branch', () => {
  it('runs ComposeService.updateStack and returns stack_compose_done', async () => {
    const result = await orch().execute(
      { nodeId: 0, stackName: 'web', target: { scope: 'stack' }, trigger: 'manual', actor: 'tester' },
      { atomic: true, terminalWs: null },
    );
    expect(result).toEqual({ kind: 'stack_compose_done' });
    expect(state.updateStack).toHaveBeenCalledWith('web', undefined, true);
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
