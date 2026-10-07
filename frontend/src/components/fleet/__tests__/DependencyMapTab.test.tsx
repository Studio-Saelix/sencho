import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// The graph canvas is not under test here; stub it so the tab's own states render.
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div data-testid="graph">{children}</div>,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useNodesState: () => [[], vi.fn(), vi.fn()],
  useEdgesState: () => [[], vi.fn(), vi.fn()],
}));

import { DependencyMapTab } from '../DependencyMapTab';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';
import type { FleetMapState } from '../useFleetMap';

const EMPTY = { nodes: [], edges: [], flags: [], nodeErrors: [], parseErrors: [] };

function state(overrides: Partial<FleetMapState> = {}): FleetMapState {
  return { data: EMPTY, loading: false, progress: null, refresh: vi.fn(), retryFailed: vi.fn(), ...overrides };
}

afterEach(() => vi.useRealTimers());

describe('DependencyMapTab', () => {
  it('holds still while the first load is fast, then shows the layout-matched skeleton', () => {
    vi.useFakeTimers();
    const { container } = render(<DependencyMapTab map={state({ data: null, loading: true })} />);
    expect(screen.queryByLabelText('Loading dependency map')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading dependency map…')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(DURATION_BASE_MS + 20); });
    expect(screen.getByLabelText('Loading dependency map')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('keeps the map visible and never shows the skeleton during a background revalidation', () => {
    vi.useFakeTimers();
    render(<DependencyMapTab map={state({ loading: true })} />);
    act(() => { vi.advanceTimersByTime(DURATION_BASE_MS * 3); });
    expect(screen.queryByLabelText('Loading dependency map')).not.toBeInTheDocument();
    expect(screen.getByText(/No stacks to map on this fleet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled();
  });

  it('names each unreachable node with its reason and retries only the failed nodes from the banner', () => {
    const retryFailed = vi.fn();
    const refresh = vi.fn();
    const data = { ...EMPTY, nodeErrors: [{ nodeId: 12, nodeName: 'edge-02', error: 'Timed out after 8s' }] };
    render(<DependencyMapTab map={state({ data, retryFailed, refresh })} />);
    expect(screen.getByText(/edge-02 \(Timed out after 8s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryFailed).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables the banner Retry while a refresh is in flight', () => {
    const data = { ...EMPTY, nodeErrors: [{ nodeId: 12, nodeName: 'edge-02', error: 'Timed out after 8s' }] };
    render(<DependencyMapTab map={state({ data, loading: true })} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('does not call a fleet where no node could be read empty, and does not claim the rest is shown', () => {
    const data = { ...EMPTY, nodeErrors: [{ nodeId: 1, nodeName: 'Local', error: 'Request failed (403)' }] };
    render(<DependencyMapTab map={state({ data })} />);
    expect(screen.getByText('Nothing to map yet: no node could be read.')).toBeInTheDocument();
    expect(screen.getByText(/No node could be read, so there is nothing to draw/)).toBeInTheDocument();
    expect(screen.queryByText(/No stacks to map/)).not.toBeInTheDocument();
  });

  it('announces the unreachable-node banner as a status', () => {
    const data = { ...EMPTY, nodeErrors: [{ nodeId: 12, nodeName: 'edge-02', error: 'Timed out after 8s' }] };
    render(<DependencyMapTab map={state({ data })} />);
    expect(screen.getByRole('status')).toHaveTextContent('edge-02');
  });

  it('shows how many nodes have answered while the rest are pending, with the map already drawn', () => {
    render(<DependencyMapTab map={state({ loading: true, progress: { done: 2, total: 3 } })} />);
    expect(screen.getByText('2 of 3 nodes')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading dependency map')).not.toBeInTheDocument();
  });

  it('shows no progress once every node has answered', () => {
    render(<DependencyMapTab map={state()} />);
    expect(screen.queryByText(/of \d+ nodes/)).not.toBeInTheDocument();
  });

  it('refreshes every node from the toolbar button', () => {
    const refresh = vi.fn();
    render(<DependencyMapTab map={state({ refresh })} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
