import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NetworkingFindingsList } from '../NetworkingFindingsList';
import type { NetworkingFinding } from '@/types/networking';
function finding(overrides: Partial<NetworkingFinding> = {}): NetworkingFinding {
  return {
    id: overrides.id ?? Math.random().toString(36),
    kind: 'network-mode-host',
    severity: 'medium',
    title: 'Some finding',
    message: 'message',
    evidence: [],
    recommendedActions: [],
    sources: ['live'],
    doctorFindings: [],
    ...overrides,
  };
}

const canEdit = () => true;

function exposureFinding(): NetworkingFinding {
  return finding({
    id: 'exposure',
    kind: 'exposure-unclassified',
    title: 'Unclassified exposure',
    recommendedActions: [{ kind: 'set-exposure-intent', label: 'Set exposure intent', stack: 'proxy' }],
  });
}

describe('NetworkingFindingsList', () => {
  it('shows a calm empty state when there are no findings', () => {
    render(<NetworkingFindingsList findings={[]} loading={false} canEdit={canEdit} isAdmin onAction={vi.fn()} nodeId={1} />);
    expect(screen.getByText('No networking issues detected.')).toBeInTheDocument();
  });

  it('groups findings into Needs action, Review recommended, and Informational', () => {
    render(
      <NetworkingFindingsList
        findings={[
          finding({ id: 'a', severity: 'critical', title: 'Critical issue' }),
          finding({ id: 'b', severity: 'medium', title: 'Medium issue' }),
          finding({ id: 'c', severity: 'info', title: 'Info issue' }),
        ]}
        loading={false}
        canEdit={canEdit}
        isAdmin
        onAction={vi.fn()}
        nodeId={1}
      />,
    );
    expect(screen.getByText(/Needs action/)).toBeInTheDocument();
    expect(screen.getByText(/Review recommended/)).toBeInTheDocument();
    expect(screen.getByText(/Informational/)).toBeInTheDocument();
  });

  it('respects node-scoped stack:edit for the primary action', () => {
    const scopedCanEdit = vi.fn((_action: string, _type?: string, _id?: string, nodeId?: number | null) => nodeId === 7);
    render(<NetworkingFindingsList findings={[exposureFinding()]} loading={false} canEdit={scopedCanEdit} isAdmin={false} onAction={vi.fn()} nodeId={7} />);
    expect(screen.getByRole('button', { name: 'Set exposure intent' })).toBeInTheDocument();
  });

  it('hides the primary action when the node scope does not match', () => {
    const deniedCanEdit = vi.fn((_action: string, _type?: string, _id?: string, nodeId?: number | null) => nodeId === 8);
    render(<NetworkingFindingsList findings={[exposureFinding()]} loading={false} canEdit={deniedCanEdit} isAdmin={false} onAction={vi.fn()} nodeId={7} />);
    expect(screen.queryByRole('button', { name: 'Set exposure intent' })).not.toBeInTheDocument();
  });

  it('shows the merged source label for a card found by both engines', () => {
    render(
      <NetworkingFindingsList
        findings={[finding({
          sources: ['live', 'doctor'],
          doctorFindings: [{ ruleId: 'sensitive-service-broad-exposure', ranAt: new Date().toISOString(), title: 't', message: 'm', severity: 'high' }],
        })]}
        loading={false}
        canEdit={canEdit}
        isAdmin
        onAction={vi.fn()}
        nodeId={1}
      />,
    );
    expect(screen.getByText('Live · also found by Doctor')).toBeInTheDocument();
  });
});
