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
  return { data: EMPTY, loading: false, error: null, refresh: vi.fn(), ...overrides };
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

  it('shows the error with a Retry that refreshes when there is no map yet', () => {
    const refresh = vi.fn();
    render(<DependencyMapTab map={state({ data: null, error: 'Request failed (502)', refresh })} />);
    expect(screen.getByText('Request failed (502)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('names each unreachable node with its reason and offers Retry in the banner', () => {
    const refresh = vi.fn();
    const data = { ...EMPTY, nodeErrors: [{ nodeId: 12, nodeName: 'edge-02', error: 'Timed out after 8s' }] };
    render(<DependencyMapTab map={state({ data, refresh })} />);
    expect(screen.getByText(/edge-02 \(Timed out after 8s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('disables the banner Retry while a refresh is in flight', () => {
    const data = { ...EMPTY, nodeErrors: [{ nodeId: 12, nodeName: 'edge-02', error: 'Timed out after 8s' }] };
    render(<DependencyMapTab map={state({ data, loading: true })} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('says so when a refresh failed and the previous result is still shown', () => {
    render(<DependencyMapTab map={state({ error: 'network down' })} />);
    expect(screen.getByText('Refresh failed. Showing the previous result.')).toBeInTheDocument();
  });
});
