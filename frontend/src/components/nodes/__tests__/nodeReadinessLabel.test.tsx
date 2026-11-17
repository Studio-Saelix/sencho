import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeReadinessBadge } from '../NodeReadinessBadge';
import { nodeReadinessLabel } from '../nodeReadinessLabel';
import type { Node } from '@/context/NodeContext';
import type { BootstrapOperationState } from '../bootstrap/types';

type Readiness = NonNullable<Node['readiness']>;

function readiness(state: Readiness['state'], operationState: BootstrapOperationState | null = 'enrolled'): Readiness {
  return { state, checkedAt: null, operationId: 'op-1', operationState };
}

describe('nodeReadinessLabel', () => {
  it('shows nothing for a node with no readiness (manual Pilot or API proxy) or a verified one', () => {
    expect(nodeReadinessLabel(null)).toBeNull();
    expect(nodeReadinessLabel(undefined)).toBeNull();
    expect(nodeReadinessLabel(readiness('ready'))).toBeNull();
  });

  it('never calls an enrolled but unchecked node ready', () => {
    expect(nodeReadinessLabel(readiness('provisional'))?.word).toBe('Unverified');
    expect(nodeReadinessLabel(readiness('verifying'))?.word).toBe('Verifying');
    expect(nodeReadinessLabel(readiness('not_ready'))).toMatchObject({ word: 'Unverified', tone: 'warning' });
  });

  it('names a provisional node by the run that registered it', () => {
    expect(nodeReadinessLabel(readiness('provisional', 'running'))?.word).toBe('Provisioning');
    expect(nodeReadinessLabel(readiness('provisional', 'enrolling'))?.word).toBe('Provisioning');
    expect(nodeReadinessLabel(readiness('provisional', 'failed'))).toMatchObject({ word: 'Bootstrap failed', tone: 'destructive' });
    expect(nodeReadinessLabel(readiness('provisional', 'partial'))?.word).toBe('Stopped partway');
    expect(nodeReadinessLabel(readiness('provisional', 'outcome_unknown'))?.word).toBe('Outcome unknown');
    expect(nodeReadinessLabel(readiness('provisional', 'blocked'))?.word).toBe('Bootstrap blocked');
    expect(nodeReadinessLabel(readiness('provisional', null))?.word).toBe('Unverified');
  });
});

describe('NodeReadinessBadge', () => {
  it('renders the word with an explanation, and nothing for a ready node', () => {
    const { rerender } = render(<NodeReadinessBadge readiness={readiness('not_ready')} />);
    const badge = screen.getByTestId('node-readiness-badge');
    expect(badge).toHaveTextContent('Unverified');
    expect(badge).toHaveAttribute('title', expect.stringContaining('did not pass the readiness check'));
    rerender(<NodeReadinessBadge readiness={readiness('ready')} />);
    expect(screen.queryByTestId('node-readiness-badge')).toBeNull();
  });
});
