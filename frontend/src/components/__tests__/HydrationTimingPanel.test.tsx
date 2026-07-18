import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HydrationReport, HydrationSnapshot } from '@/lib/hydrationTiming';

let mockSnapshot: HydrationSnapshot;
let mockListVisibleMs: number | null;
let mockReport: HydrationReport;

vi.mock('@/hooks/useHydrationTiming', () => ({
  useHydrationTiming: () => ({ snapshot: mockSnapshot, listVisibleMs: mockListVisibleMs }),
}));

const clearReportMock = vi.fn();
vi.mock('@/lib/hydrationTiming', () => ({
  getHydrationReport: () => mockReport,
  clearReport: () => clearReportMock(),
}));

const copyMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: (text: string) => copyMock(text) }));

import { HydrationTimingPanel } from '../HydrationTimingPanel';

function snapshot(events: HydrationSnapshot['events'] = []): HydrationSnapshot {
  return {
    schemaVersion: 1,
    clock: 'performance.now',
    bootSessionId: 'boot-1',
    bootStartAt: 0,
    nodeSessionId: 'node-2',
    nodeId: 1,
    events,
  };
}

function report(over: Partial<HydrationReport> = {}): HydrationReport {
  return {
    schemaVersion: 1,
    capturedAt: 0,
    clock: 'performance.now',
    bootSessionId: 'boot-1',
    nodeSessionId: 'node-2',
    nodeId: 1,
    listVisibleMs: 1200,
    anyProxied: false,
    phases: [
      { phase: 'boot_start', kind: 'milestone', offsetMs: 0, critical: true, outcome: 'ok' },
      { phase: 'list_visible', kind: 'milestone', offsetMs: 1200, uiCommitMs: 1200, critical: true, outcome: 'ok' },
    ],
    ...over,
  };
}

beforeEach(() => {
  clearReportMock.mockClear();
  copyMock.mockClear();
  mockSnapshot = snapshot();
  mockListVisibleMs = 1200;
  mockReport = report();
});

describe('HydrationTimingPanel', () => {
  it('shows the list_visible elapsed time on the collapsed chip', () => {
    render(<HydrationTimingPanel />);
    expect(screen.getByTestId('hydration-chip')).toHaveTextContent('list 1.2s');
  });

  it('shows an ellipsis before list_visible commits', () => {
    mockListVisibleMs = null;
    render(<HydrationTimingPanel />);
    expect(screen.getByTestId('hydration-chip')).toHaveTextContent('list …');
  });

  it('expands into the phase table and collapses again', () => {
    render(<HydrationTimingPanel />);
    fireEvent.click(screen.getByTestId('hydration-chip'));

    expect(screen.getByTestId('hydration-panel')).toBeInTheDocument();
    expect(screen.getByText('list_visible')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('hydration-collapse'));
    expect(screen.queryByTestId('hydration-panel')).toBeNull();
    expect(screen.getByTestId('hydration-chip')).toBeInTheDocument();
  });

  it('collapses on Escape', () => {
    render(<HydrationTimingPanel />);
    fireEvent.click(screen.getByTestId('hydration-chip'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByTestId('hydration-panel')).toBeNull();
  });

  it('copies the hydration report as pretty JSON', async () => {
    render(<HydrationTimingPanel />);
    fireEvent.click(screen.getByTestId('hydration-chip'));
    fireEvent.click(screen.getByTestId('hydration-copy'));

    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
    expect(copyMock).toHaveBeenCalledWith(JSON.stringify(mockReport, null, 2));
  });

  it('clears the report', () => {
    render(<HydrationTimingPanel />);
    fireEvent.click(screen.getByTestId('hydration-chip'));
    fireEvent.click(screen.getByTestId('hydration-clear'));
    expect(clearReportMock).toHaveBeenCalledTimes(1);
  });

  it('notes gateway developer mode when any event was proxied', () => {
    mockReport = report({ anyProxied: true });
    render(<HydrationTimingPanel />);
    fireEvent.click(screen.getByTestId('hydration-chip'));
    expect(screen.getByText(/gateway/i)).toBeInTheDocument();
  });
});
