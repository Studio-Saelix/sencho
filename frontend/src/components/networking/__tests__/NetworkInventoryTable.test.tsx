import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkInventoryTable } from '../NetworkInventoryTable';
import type { NetworkingNetworkRow } from '@/types/networking';

function row(overrides: Partial<NetworkingNetworkRow> = {}): NetworkingNetworkRow {
  return {
    id: overrides.id ?? Math.random().toString(36),
    name: 'a-net', driver: 'bridge', scope: 'local', isSystem: false, ingress: false,
    composeProject: 'app', stack: 'app', connectedCount: 0, isSencho: false, ownership: 'compose-managed',
    declaredByStacks: [], declaredExternalByStacks: [], isExternalDependency: false,
    sharedStackCount: 0, exposureSummary: null, findingIds: [], serviceNames: [],
    ...overrides,
  };
}

describe('NetworkInventoryTable', () => {
  it('sorts rows when a column header is clicked', async () => {
    const rows = [row({ id: '1', name: 'zeta' }), row({ id: '2', name: 'alpha' })];
    const user = userEvent.setup();
    render(
      <NetworkInventoryTable
        rows={rows}
        findings={[]}
        loading={false}
        isAdmin={false}
        onInspect={vi.fn()}
        onDelete={vi.fn()}
        onOpenStack={vi.fn()}
        onFilterTopology={vi.fn()}
        renderVerificationUnavailable={false}
      />,
    );
    // Default sort is name ascending, independent of input row order.
    const cellsBefore = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(cellsBefore).toEqual(['alpha', 'zeta']);

    // Clicking the active column's header reverses the direction.
    await user.click(screen.getByRole('button', { name: /Name/ }));
    const cellsAfter = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(cellsAfter).toEqual(['zeta', 'alpha']);
  });

  it('orders row actions as Open, View, Topology, Delete with tooltips', () => {
    const rowWithStack = row({ stack: 'app' });
    render(
      <NetworkInventoryTable
        rows={[rowWithStack]}
        findings={[]}
        loading={false}
        isAdmin
        onInspect={vi.fn()}
        onDelete={vi.fn()}
        onOpenStack={vi.fn()}
        onFilterTopology={vi.fn()}
        renderVerificationUnavailable={false}
      />,
    );
    const actionButtons = screen.getAllByRole('button').filter((b) =>
      ['Open app', 'Inspect a-net', 'Show a-net in topology', 'Delete a-net'].includes(b.getAttribute('aria-label') ?? ''),
    );
    expect(actionButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open app', 'Inspect a-net', 'Show a-net in topology', 'Delete a-net',
    ]);
  });

  it('holds the delete affordance while render verification is unavailable', () => {
    const unlabeledExternal = row({ id: '1', name: 'shared_ext', composeProject: null, stack: null });
    render(
      <NetworkInventoryTable
        rows={[unlabeledExternal]}
        findings={[]}
        loading={false}
        isAdmin
        onInspect={vi.fn()}
        onDelete={vi.fn()}
        onOpenStack={vi.fn()}
        onFilterTopology={vi.fn()}
        renderVerificationUnavailable
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete shared_ext' })).toBeDisabled();
  });

  it('keeps delete enabled for the same network when renders succeed', () => {
    const unlabeledExternal = row({ id: '1', name: 'shared_ext', composeProject: null, stack: null });
    render(
      <NetworkInventoryTable
        rows={[unlabeledExternal]}
        findings={[]}
        loading={false}
        isAdmin
        onInspect={vi.fn()}
        onDelete={vi.fn()}
        onOpenStack={vi.fn()}
        onFilterTopology={vi.fn()}
        renderVerificationUnavailable={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete shared_ext' })).toBeEnabled();
  });
});
