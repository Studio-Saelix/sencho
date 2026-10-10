import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkingFindingsList, type NetworkingDismissedList } from '../NetworkingFindingsList';
import type { NetworkingFindingControls } from '../NetworkingFindingActions';
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
    fingerprint: 'fp',
    count: 1,
    dismissPolicy: 'any',
    ...overrides,
  };
}

function controls(overrides: Partial<NetworkingFindingControls> = {}): NetworkingFindingControls {
  return {
    nodeId: 1,
    isAdmin: true,
    canEditStack: () => true,
    onAction: vi.fn(),
    onAcknowledge: vi.fn(),
    onResolved: vi.fn(),
    canDismiss: () => true,
    isDismissing: () => false,
    onDismiss: vi.fn(),
    ...overrides,
  };
}

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
    render(<NetworkingFindingsList findings={[]} loading={false} controls={controls()} />);
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
        controls={controls()}
      />,
    );
    expect(screen.getByText(/Needs action/)).toBeInTheDocument();
    expect(screen.getByText(/Review recommended/)).toBeInTheDocument();
    expect(screen.getByText(/Informational/)).toBeInTheDocument();
  });

  it('respects node-scoped stack:edit for the primary action', () => {
    render(<NetworkingFindingsList findings={[exposureFinding()]} loading={false} controls={controls({ isAdmin: false, nodeId: 7, canEditStack: () => true })} />);
    expect(screen.getByRole('button', { name: 'Set exposure intent' })).toBeInTheDocument();
  });

  it('hides the primary action when the node scope does not match', () => {
    render(<NetworkingFindingsList findings={[exposureFinding()]} loading={false} controls={controls({ isAdmin: false, nodeId: 7, canEditStack: () => false })} />);
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
        controls={controls()}
      />,
    );
    expect(screen.getByText('Live · also found by Doctor')).toBeInTheDocument();
  });

  it('runs a navigation verb through the page handler in one click', async () => {
    const onAction = vi.fn();
    const drift = finding({
      id: 'drift', kind: 'declared-network-unused', title: 'Declared network unused',
      recommendedActions: [{ kind: 'open-stack-editor', label: 'Open stack editor', stack: 'web' }],
    });
    render(<NetworkingFindingsList findings={[drift]} loading={false} controls={controls({ onAction })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open stack editor' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'open-stack-editor', stack: 'web' }));
  });

  it('puts the copy actions in the overflow menu, never as the headline verb', async () => {
    const missing = finding({
      id: 'missing', kind: 'external-network-missing', title: 'External network not found',
      recommendedActions: [
        { kind: 'create-network', label: 'Create network', networkName: 'backbone', requiresAdmin: true },
        { kind: 'copy-docker-command', label: 'Copy Docker command', commandKind: 'network-create', networkName: 'backbone' },
        { kind: 'open-stack-editor', label: 'Open stack editor', stack: 'web' },
      ],
    });
    render(<NetworkingFindingsList findings={[missing]} loading={false} controls={controls()} />);
    expect(screen.getByRole('button', { name: 'Create network' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Docker command' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /More actions/ }));
    expect(await screen.findByRole('menuitem', { name: 'Copy Docker command' })).toBeInTheDocument();
  });

  it('falls back to the named navigation for an account that cannot create a network', () => {
    const missing = finding({
      id: 'missing', kind: 'external-network-missing',
      recommendedActions: [
        { kind: 'create-network', label: 'Create network', networkName: 'backbone', requiresAdmin: true },
        { kind: 'open-stack-editor', label: 'Open stack editor', stack: 'web' },
      ],
    });
    render(<NetworkingFindingsList findings={[missing]} loading={false} controls={controls({ isAdmin: false })} />);
    expect(screen.queryByRole('button', { name: 'Create network' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open stack editor' })).toBeInTheDocument();
  });

  it('dismisses in one click and offers no Dismiss to an account that may not', async () => {
    const onDismiss = vi.fn();
    const item = finding({ id: 'shared', title: 'Shared network' });
    const { rerender } = render(<NetworkingFindingsList findings={[item]} loading={false} controls={controls({ onDismiss })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss: Shared network' }));
    expect(onDismiss).toHaveBeenCalledWith(item, 'until_change', undefined);
    rerender(<NetworkingFindingsList findings={[item]} loading={false} controls={controls({ canDismiss: () => false })} />);
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
  });

  it('offers a Doctor-only card Acknowledge in Doctor and no Dismiss', async () => {
    const onAcknowledge = vi.fn();
    const doctorOnly = finding({
      id: 'doctor', kind: 'sensitive-service-broad-exposure', title: 'Broadly exposed', stack: 'web', sources: ['doctor'],
      dismissPolicy: 'none',
      doctorFindings: [{ ruleId: 'r', ranAt: new Date().toISOString(), title: 't', message: 'm', severity: 'high', service: 'db' }],
      recommendedActions: [{ kind: 'open-stack-doctor', label: 'Open Doctor', stack: 'web' }],
    });
    render(<NetworkingFindingsList findings={[doctorOnly]} loading={false} controls={controls({ onAcknowledge })} />);
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge in Doctor' }));
    expect(onAcknowledge).toHaveBeenCalledWith(doctorOnly);
  });

  it("shows Doctor's remediation under the message", () => {
    render(
      <NetworkingFindingsList
        findings={[finding({
          doctorFindings: [{ ruleId: 'r', ranAt: new Date().toISOString(), title: 't', message: 'm', severity: 'high', remediation: 'Bind the port to 127.0.0.1.' }],
        })]}
        loading={false}
        controls={controls()}
      />,
    );
    expect(screen.getByText('Bind the port to 127.0.0.1.')).toBeInTheDocument();
  });

  it('lists dismissed findings under a quiet count and restores one on request', async () => {
    const onRestore = vi.fn();
    const hidden = finding({ id: 'hidden', title: 'Hidden finding' });
    const dismissed: NetworkingDismissedList = {
      items: [{
        finding: hidden,
        dismissal: { id: 4, nodeId: 1, surface: 'networking', findingKey: 'networking:1:hidden', fingerprint: 'fp', severity: 'medium', count: 1, mode: 'until_change', expiresAt: null, createdBy: 'alice', createdAt: Date.now() - 60_000 },
      }],
      now: Date.now(),
      canRestore: () => true,
      onRestore,
      isRestoring: () => false,
    };
    render(<NetworkingFindingsList findings={[]} dismissed={dismissed} loading={false} controls={controls()} />);
    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument();
    expect(screen.getByText('1 dismissed')).toBeInTheDocument();
    expect(screen.getByText(/dismissed by alice/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith(dismissed.items[0]);
  });
});
