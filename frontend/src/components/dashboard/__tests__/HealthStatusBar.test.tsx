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
import { render, screen } from '@testing-library/react';
import { HealthStatusBar } from '../HealthStatusBar';
import type { Stats } from '../types';

const EMPTY_STATS: Stats = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };

function renderBar(metricsStale: boolean, metricsUnreadable = false) {
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
    />,
  );
}

describe('HealthStatusBar unavailable state', () => {
  it('reports an unknown node rather than a healthy one when the node does not answer', () => {
    renderBar(true, true);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('This node is not answering.')).toBeInTheDocument();
    expect(screen.getByText('metrics stale')).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).toBeNull();
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
