/**
 * HubOnlyGate short-circuits to null when the active node is remote so the
 * wrapped lazy chunk is never fetched. Locks the load-bearing behavior
 * documented in HubOnlyGate.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as NodeContext from '@/context/NodeContext';
import { HubOnlyGate } from '../HubOnlyGate';

vi.mock('@/context/NodeContext');

function mockActiveNode(type: 'local' | 'remote' | null) {
  vi.mocked(NodeContext.useNodes).mockReturnValue({
    activeNode: type === null ? null : { type, id: 1, name: 'n' },
  } as unknown as ReturnType<typeof NodeContext.useNodes>);
}

describe('HubOnlyGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when active node is local', () => {
    mockActiveNode('local');
    render(
      <HubOnlyGate>
        <div data-testid="payload">hub content</div>
      </HubOnlyGate>,
    );
    expect(screen.getByTestId('payload')).toBeTruthy();
  });

  it('renders children when active node is null (initial load)', () => {
    mockActiveNode(null);
    render(
      <HubOnlyGate>
        <div data-testid="payload">hub content</div>
      </HubOnlyGate>,
    );
    expect(screen.getByTestId('payload')).toBeTruthy();
  });

  it('returns null when active node is remote', () => {
    mockActiveNode('remote');
    const { container } = render(
      <HubOnlyGate>
        <div data-testid="payload">hub content</div>
      </HubOnlyGate>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('payload')).toBeNull();
  });
});
