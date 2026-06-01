import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapabilityGate } from '../CapabilityGate';

const nodes = {
  hasCapability: (c: string) => c !== 'vulnerability-scanning',
  activeNode: { id: 1, name: 'node-x' },
  activeNodeMeta: { version: '0.80.0', capabilities: [] as string[], fetchedAt: 0 },
};

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => nodes,
}));

describe('CapabilityGate', () => {
  it('renders a lock card (not the children) when the node lacks the capability', () => {
    render(
      <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
        <div>gated-content</div>
      </CapabilityGate>,
    );
    expect(screen.queryByText('gated-content')).toBeNull();
    expect(
      screen.getByText('Vulnerability scanning is not available on this node'),
    ).toBeInTheDocument();
    // The version hint names the running version so the operator knows what to upgrade.
    expect(screen.getByText(/node-x is running v0\.80\.0/)).toBeInTheDocument();
  });

  it('renders children when the node advertises the capability', () => {
    render(
      <CapabilityGate capability="stacks" featureName="Stacks">
        <div>gated-content</div>
      </CapabilityGate>,
    );
    expect(screen.getByText('gated-content')).toBeInTheDocument();
  });
});
