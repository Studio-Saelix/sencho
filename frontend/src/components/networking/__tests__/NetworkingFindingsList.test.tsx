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

describe('NetworkingFindingsList', () => {
  it('shows a calm empty state when there are no findings', () => {
    render(<NetworkingFindingsList findings={[]} loading={false} canEdit={canEdit} isAdmin onAction={vi.fn()} />);
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
      />,
    );
    expect(screen.getByText(/Needs action/)).toBeInTheDocument();
    expect(screen.getByText(/Review recommended/)).toBeInTheDocument();
    expect(screen.getByText(/Informational/)).toBeInTheDocument();
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
      />,
    );
    expect(screen.getByText('Live · also found by Doctor')).toBeInTheDocument();
  });
});
