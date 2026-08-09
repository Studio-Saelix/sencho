import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HydrationReport, HydrationSnapshot } from '@/lib/hydrationTiming';

let mockSnapshot: HydrationSnapshot;
let mockListVisibleMs: number | null;
let mockListAnchor: 'attempt' | 'session' | null;
let mockReport: HydrationReport;

vi.mock('@/hooks/useHydrationTiming', () => ({
  useHydrationTiming: () => ({
    snapshot: mockSnapshot,
    listVisibleMs: mockListVisibleMs,
    listAnchor: mockListAnchor,
  }),
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
    clock: 'performance.now',
    bootSessionId: 'boot-1',
    bootStartAt: 0,
    nodeSessionId: 'node-2',
    nodeId: 1,
    nodeSessionStartAt: 0,
    lastAttempt: null,
    events,
  };
}

function report(over: Partial<HydrationReport> = {}): HydrationReport {
  return {
    schemaVersion: 2,
    capturedAt: 0,
    clock: 'performance.now',
    bootSessionId: 'boot-1',
    nodeSessionId: 'node-2',
    nodeId: 1,
    listVisibleMs: 1200,
    bootAgeMs: 620000,
    bootAuthResolvedMs: 200,
    bootNodesResolvedMs: 400,
    bootShellCommittedMs: 500,
    sessionAgeMs: 4200,
    sessionListVisibleMs: 1200,
    sessionListHydratedMs: 1500,
    lastAttemptId: 'attempt-1',
    lastAttemptListVisibleMs: 420,
    lastAttemptListHydratedMs: 700,
    lastAttemptHydrationGapMs: 280,
    lastAttemptProxied: null,
    lastAttemptNodeId: null,
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
  mockListVisibleMs = 420;
  mockListAnchor = 'attempt';
  mockReport = report();
});

describe('HydrationTimingPanel', () => {
  it('shows the foreground list_visible elapsed time and its anchor on the collapsed chip', () => {
    render(<HydrationTimingPanel />);
    expect(screen.getByTestId('hydration-chip')).toHaveTextContent('list 420ms · attempt');
  });

  it('shows the session anchor when no foreground attempt exists', () => {
    mockListAnchor = 'session';
    mockListVisibleMs = 100;
    render(<HydrationTimingPanel />);
    expect(screen.getByTestId('hydration-chip')).toHaveTextContent('list 100ms · session');
  });

  it('shows an ellipsis before list_visible commits', () => {
    mockListVisibleMs = null;
    mockListAnchor = null;
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

  it('shows boot age and session age as context alongside the chip', () => {
    render(<HydrationTimingPanel />);
    fireEvent.click(screen.getByTestId('hydration-chip'));
    expect(screen.getByText(/Boot age/)).toHaveTextContent('620.0s');
    expect(screen.getByText(/Session age/)).toHaveTextContent('4.2s');
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
