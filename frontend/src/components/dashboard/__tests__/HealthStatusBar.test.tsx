/**
 * A node that has not answered must not read as healthy.
 *
 * The dashboard's headline is derived from the last stats it has. When the node
 * itself could not be read (the gateway's bounded read deadline, or an
 * unreachable node) the zeros on screen are an absence of data, not a clean
 * bill of health, so the headline names the unknown state instead. Stale meters
 * with a local cause keep the derived level and the stale chip: Sencho is still
 * answering in that case.
 */
import { describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HealthStatusBar } from '../HealthStatusBar';
import type { Stats } from '../types';
import type { UnreadableNodeFailure } from '@/lib/remoteReadFailure';

const EMPTY_STATS: Stats = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };

function renderBar(
  metricsStale: boolean,
  metricsUnreadable = false,
  metricsPending = false,
  unreadableCause: UnreadableNodeFailure | null = null,
) {
  return render(
    <HealthStatusBar
      stats={EMPTY_STATS}
      systemStats={null}
      notifications={[]}
      activeNodeName="edge-1"
      nodeCount={1}
      lastSyncAt={null}
      metricsStale={metricsStale}
      metricsUnreadable={metricsUnreadable}
      unreadableCause={unreadableCause}
      metricsPending={metricsPending}
    />,
  );
}

describe('HealthStatusBar unavailable state', () => {
  it('does not claim a health level while the first metrics read is still queued', () => {
    renderBar(false, false, true);
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Reading this node…')).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).toBeNull();
  });

  it('reports an unknown node rather than a healthy one when the node does not answer', () => {
    renderBar(true, true);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('This node is not answering.')).toBeInTheDocument();
    expect(screen.getByText('metrics stale')).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).toBeNull();
  });

  it('names a disconnected Pilot instead of calling every cause a silent node', () => {
    renderBar(true, true, false, 'pilot-disconnected');
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(
      screen.getByText('The Pilot tunnel to "edge-1" is disconnected. It resumes when the agent reconnects.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('This node is not answering.')).toBeNull();
  });

  it('names an unconfigured target and a refused address, not a timeout', () => {
    renderBar(true, true, false, 'not-configured');
    expect(screen.getByText(/has no API URL or token configured/i)).toBeInTheDocument();
    cleanup();
    renderBar(true, true, false, 'refused');
    expect(screen.getByText(/refused "edge-1"'s address/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not answer/i)).toBeNull();
  });

  it('keeps the silent-node sentence for a deadline and an unreachable node', () => {
    renderBar(true, true, false, 'timeout');
    expect(screen.getByText('This node is not answering.')).toBeInTheDocument();
    cleanup();
    renderBar(true, true, false, 'unreachable');
    expect(screen.getByText('This node is not answering.')).toBeInTheDocument();
  });

  it('keeps the derived level and the stale chip for stale meters with a local cause', () => {
    renderBar(true, false);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('metrics stale')).toBeInTheDocument();
    expect(screen.queryByText('This node is not answering.')).toBeNull();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('keeps the derived level when the metrics are current', () => {
    renderBar(false);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).toBeNull();
  });
});
