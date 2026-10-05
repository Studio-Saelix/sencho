/**
 * The deployment table is where a held repair becomes visible, so the held row
 * is rendered and asserted rather than only typechecked: a status that reaches
 * the table without a label renders as a blank chip, which no type would catch.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BlueprintDeploymentTable } from './BlueprintDeploymentTable';
import type { BlueprintDeployment } from '@/lib/blueprintsApi';

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: [{ id: 1, name: 'edge-1', status: 'online' }] }),
}));

function deployment(overrides: Partial<BlueprintDeployment>): BlueprintDeployment {
  return {
    blueprint_id: 7,
    node_id: 1,
    status: 'repair_held',
    applied_revision: 3,
    last_deployed_at: 1,
    last_checked_at: 2,
    last_drift_at: 2,
    drift_summary: 'the rollout for this target was superseded, so the rollout replacing it owns it',
    last_error: null,
    ...overrides,
  } as BlueprintDeployment;
}

function renderTable(deployments: BlueprintDeployment[]) {
  return render(
    <BlueprintDeploymentTable
      deployments={deployments}
      classification="stateless"
      canDeploy={() => true}
      canWithdraw={() => true}
      canRetry
      busyNodeId={null}
      onWithdraw={() => {}}
      onAcceptStateReview={() => {}}
      onRetry={() => {}}
    />,
  );
}

describe('a held repair is visible in the deployment table', () => {
  it('labels the held row and carries the reason', () => {
    renderTable([deployment({})]);

    // The label is the whole point: a blank chip would hide a drift Sencho is
    // declining to fix, which is the exact failure the status exists to prevent.
    expect(screen.getByText('Repair held')).toBeDefined();
    expect(screen.getByText(/superseded/)).toBeDefined();
  });

  it('warns rather than reads as healthy, and does not offer a repair', () => {
    const { container } = renderTable([deployment({})]);

    // Same warning tone as drift, not the success tone an active row would use.
    expect(container.querySelector('.bg-warning')).not.toBeNull();
    expect(container.querySelector('.bg-success')).toBeNull();
    // A held row is not a corrective target, so no auto-fix action is offered.
    expect(screen.queryByRole('button', { name: /correct/i })).toBeNull();
  });

  it('still offers Withdraw, which is the documented way out of a hold', () => {
    renderTable([deployment({})]);

    // Without this the state the docs tell operators to resolve by withdrawing
    // had no control on the row that shows it.
    expect(screen.getByRole('button', { name: /withdraw/i })).toBeDefined();
  });
});

describe('a failed deploy is readable in the deployment table', () => {
  const log = 'Network a Creating\nContainer a-1 Starting\nError response from daemon: Bind for 0.0.0.0:8080 failed: port is already allocated';

  it('shows the cause on one line and keeps the full output behind a disclosure', () => {
    renderTable([deployment({ status: 'failed', drift_summary: null, last_error: log })]);
    expect(screen.getByText('Error response from daemon: Bind for 0.0.0.0:8080 failed: port is already allocated')).toBeInTheDocument();
    expect(screen.getByText('Full output')).toBeInTheDocument();
  });

  it('names the row action Re-apply, the same name the status verb uses', () => {
    renderTable([deployment({ status: 'failed', drift_summary: null, last_error: log })]);
    expect(screen.getByRole('button', { name: 'Re-apply' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows no disclosure for a one-line error', () => {
    renderTable([deployment({ status: 'failed', drift_summary: null, last_error: 'image pull denied' })]);
    expect(screen.getByText('image pull denied')).toBeInTheDocument();
    expect(screen.queryByText('Full output')).toBeNull();
  });

  it('says so when a failed row recorded no error output', () => {
    renderTable([deployment({ status: 'failed', drift_summary: null, last_error: '  ' })]);
    expect(screen.getByText('No error output recorded')).toBeInTheDocument();
  });

  it('falls back to the drift summary for a failed row with no usable error', () => {
    renderTable([deployment({ status: 'failed', drift_summary: 'image changed on the node', last_error: '' })]);
    expect(screen.getByText('image changed on the node')).toBeInTheDocument();
  });

  it('says nothing is deployed yet instead of asking for a node ID', () => {
    renderTable([]);
    expect(screen.getByText(/No deployments yet/)).toBeInTheDocument();
  });
});
