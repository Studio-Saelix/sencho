import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { FleetMasthead } from '../FleetMasthead';
import { deriveFleetMastheadState } from '../fleetMastheadState';

const base = { nodeCount: 3, onlineCount: 3, criticalCount: 0, loading: false, lastSyncAt: 1_000 };

afterEach(() => vi.useRealTimers());

describe('deriveFleetMastheadState', () => {
  it('reads Checking, not Healthy, before the first overview lands', () => {
    expect(deriveFleetMastheadState({ ...base, nodeCount: 0, onlineCount: 0, loading: true, lastSyncAt: null }))
      .toEqual({ state: 'Checking', tone: 'idle' });
  });

  it('says Unavailable, not No nodes, when the first overview failed', () => {
    expect(deriveFleetMastheadState({ ...base, nodeCount: 0, onlineCount: 0, lastSyncAt: null }))
      .toEqual({ state: 'Unavailable', tone: 'warn' });
  });

  it('says No nodes for a synced fleet that is empty instead of claiming health', () => {
    expect(deriveFleetMastheadState({ ...base, nodeCount: 0, onlineCount: 0 })).toEqual({ state: 'No nodes', tone: 'idle' });
  });

  it('is Healthy when every node is online and none critical', () => {
    expect(deriveFleetMastheadState(base)).toEqual({ state: 'Healthy', tone: 'live' });
  });

  it('is Degraded when a node is offline', () => {
    expect(deriveFleetMastheadState({ ...base, onlineCount: 2 })).toEqual({ state: 'Degraded', tone: 'warn' });
  });

  it('is Critical when a node is critical, even with another offline', () => {
    expect(deriveFleetMastheadState({ ...base, onlineCount: 2, criticalCount: 1 })).toEqual({ state: 'Critical', tone: 'error' });
  });

  it('keeps the last verdict while a later refresh is loading', () => {
    expect(deriveFleetMastheadState({ ...base, loading: true })).toEqual({ state: 'Healthy', tone: 'live' });
  });
});

describe('FleetMasthead', () => {
  const props = {
    ...base, totalCpuPercent: 9, totalMemUsed: 3.6 * 1024 ** 3, activeContainers: 7, totalContainers: 8,
  };

  it('states each fact once: verdict in the state word, counts in the subtitle', () => {
    render(<FleetMasthead {...props} onlineCount={2} />);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText(/3 nodes · 1 offline · /)).toBeInTheDocument();
    expect(screen.getByText('fleet')).toBeInTheDocument();
    expect(screen.getByText('7/8')).toBeInTheDocument();
    expect(screen.getByText('3.6 GiB')).toBeInTheDocument();
  });

  it('omits offline and critical from the subtitle when there are none', () => {
    render(<FleetMasthead {...props} />);
    expect(screen.getByText(/^3 nodes · /)).toBeInTheDocument();
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
    expect(screen.queryByText(/critical/)).not.toBeInTheDocument();
  });

  it('does not show a node count before the first sync', () => {
    render(<FleetMasthead {...props} nodeCount={0} onlineCount={0} lastSyncAt={null} loading />);
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.queryByText(/0 nodes/)).not.toBeInTheDocument();
  });

  it('ticks the synced age every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    render(<FleetMasthead {...props} lastSyncAt={100_000} />);
    expect(screen.getByText(/synced 0s ago/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText(/synced 2s ago/)).toBeInTheDocument();
  });

  it('shows syncing while loading and not synced before any sync', () => {
    const { rerender } = render(<FleetMasthead {...props} loading />);
    expect(screen.getByText(/syncing…/)).toBeInTheDocument();
    rerender(<FleetMasthead {...props} lastSyncAt={null} loading={false} />);
    expect(screen.getByText(/not synced/)).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });
});
