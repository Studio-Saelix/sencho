import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BootstrapOperationsList } from '../BootstrapOperationsList';
import type { BootstrapOperation } from '../types';

function operation(index: number, overrides: Partial<BootstrapOperation> = {}): BootstrapOperation {
  return {
    id: `op-${index}`,
    targetName: `server-${index}`,
    host: `server-${index}.example.com`,
    port: 22,
    username: 'ubuntu',
    address: '192.168.1.50',
    hostKeyFingerprint: `SHA256:key-${index}`,
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    planDigest: 'd'.repeat(64),
    approvedBy: 'admin',
    approvedAt: 1_000 + index,
    attempt: 1,
    state: 'partial',
    stage: null,
    step: null,
    nodeId: null,
    changesMade: true,
    active: true,
    cancelRequested: false,
    error: null,
    enrollmentExpiresAt: null,
    createdAt: 1_000 + index,
    updatedAt: 1_000 + index,
    finishedAt: 2_000 + index,
    actions: { cancel: false, retry: true, release: true },
    ...overrides,
  };
}

function renderList(operations: BootstrapOperation[], handlers: { onFollow?: (op: BootstrapOperation) => void } = {}) {
  render(
    <BootstrapOperationsList
      operations={operations}
      loadFailed={false}
      disabled={false}
      onFollow={handlers.onFollow ?? vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

describe('BootstrapOperationsList', () => {
  it('lists every run that holds a server, however many there are, and opens the oldest', async () => {
    const holds = Array.from({ length: 25 }, (_, index) => operation(index));
    const onFollow = vi.fn();
    renderList(holds, { onFollow });
    for (const hold of holds) expect(screen.getByTestId(`bootstrap-run-${hold.id}`)).toBeInTheDocument();
    const oldest = screen.getByTestId('bootstrap-run-op-0');
    await userEvent.click(within(oldest).getByRole('button', { name: 'View' }));
    expect(onFollow).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-0' }));
    expect(within(oldest).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('cuts only finished runs, keeping all holds before the latest three finished ones', () => {
    const holds = Array.from({ length: 22 }, (_, index) => operation(index));
    const finished = Array.from({ length: 6 }, (_, index) => operation(100 + index, { active: false, state: 'enrolled', actions: { cancel: false, retry: false, release: false } }));
    renderList([...holds, ...finished]);
    for (const hold of holds) expect(screen.getByTestId(`bootstrap-run-${hold.id}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^bootstrap-run-op-1\d\d$/)).toHaveLength(3);
  });
});
