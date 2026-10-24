/**
 * The health-gated rollout line on a target card: what the policy is, whether
 * the target is still waiting, and whether a rollback has anything to restore.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { target } from '@/__tests__/gitopsFixtures';
import { GitOpsTargetCard } from '@/components/gitops/GitOpsTargetCard';
import type { GitOpsTargetProjection } from '@/types/gitops';

function renderCard(overrides: Partial<GitOpsTargetProjection> = {}) {
  return render(<GitOpsTargetCard target={target(overrides)} nodeName="node-a" />);
}

function gated(overrides: Partial<GitOpsTargetProjection['healthGate']>) {
  return {
    policy: 'observe' as const,
    configuredPolicy: 'observe' as const,
    awaitingRunId: null,
    attempts: 0,
    stopReason: null,
    recoveryAvailable: true,
    ...overrides,
  };
}

describe('GitOpsTargetCard health gating', () => {
  it('says nothing about health when a remote older than this one sent no gate at all', () => {
    // A remote on an older version answers a schema version 1 projection with no
    // healthGate. Reading it as an object would break the whole detail view.
    const { container } = renderCard({
      healthGate: undefined as unknown as GitOpsTargetProjection['healthGate'],
    });
    expect(container.textContent).not.toContain('health policy');
  });

  it('says nothing about health when the target was never gated', () => {
    const { container } = renderCard();
    expect(container.textContent).not.toContain('health policy');
  });

  it('names the policy the target is running under', () => {
    const { container } = renderCard({ healthGate: gated({ policy: 'pause' }) });
    expect(container.textContent).toContain('health policy pause');
  });

  it('reports a target still awaiting its verdict', () => {
    const { container } = renderCard({
      healthGate: gated({ policy: 'pause', awaitingRunId: 'run-1' }),
    });
    expect(container.textContent).toContain('awaiting its verdict');
  });

  it('reports the retry budget a target has spent', () => {
    const { container } = renderCard({
      healthGate: gated({ policy: 'retry_once', attempts: 1, stopReason: 'health_retry_exhausted' }),
    });
    expect(container.textContent).toContain('1 retry');
    expect(container.textContent).toContain('retry exhausted');
  });

  it('says a rollback policy has nothing to restore from', () => {
    const { container } = renderCard({
      healthGate: gated({ policy: 'rollback', recoveryAvailable: false, stopReason: 'rollback_unavailable' }),
    });
    expect(container.textContent).toContain('no pre-rollout generation captured');
    expect(container.textContent).toContain('recovery required');
  });

  it('says the rollout stopped, without claiming anything was restored', () => {
    const { container } = renderCard({
      healthGate: gated({ policy: 'stop', stopReason: 'rollout_stopped' }),
    });
    expect(container.textContent).toContain('rollout stopped');
  });
});
