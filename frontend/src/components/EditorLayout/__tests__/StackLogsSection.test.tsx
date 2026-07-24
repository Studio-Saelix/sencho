/**
 * StackLogsSection forwards showServiceChips to StructuredLogViewer and leaves
 * the raw-terminal contract unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { StackLogsSection } from '../editor-view-blocks';

let lastViewerShowServiceChips: boolean | undefined;

vi.mock('../../StructuredLogViewer', () => ({
  default: ({ showServiceChips }: { showServiceChips?: boolean }) => {
    lastViewerShowServiceChips = showServiceChips;
    return <div data-testid="structured-log-viewer" />;
  },
}));

vi.mock('../../Terminal', () => ({
  default: ({ stackName }: { stackName: string }) => (
    <div data-testid="raw-terminal">{stackName}</div>
  ),
}));

vi.mock('../../ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('StackLogsSection showServiceChips forwarding', () => {
  beforeEach(() => {
    lastViewerShowServiceChips = undefined;
  });

  it('forwards true to StructuredLogViewer in structured mode', () => {
    render(
      <StackLogsSection
        stackName="web"
        logsMode="structured"
        setLogsMode={vi.fn()}
        showServiceChips
      />,
    );
    expect(screen.getByTestId('structured-log-viewer')).toBeInTheDocument();
    expect(lastViewerShowServiceChips).toBe(true);
  });

  it('forwards false to StructuredLogViewer in structured mode', () => {
    render(
      <StackLogsSection
        stackName="web"
        logsMode="structured"
        setLogsMode={vi.fn()}
        showServiceChips={false}
      />,
    );
    expect(screen.getByTestId('structured-log-viewer')).toBeInTheDocument();
    expect(lastViewerShowServiceChips).toBe(false);
  });

  it('renders TerminalComponent in raw mode without requiring chip props', () => {
    const setLogsMode = vi.fn();
    render(
      <StackLogsSection
        stackName="web"
        logsMode="raw"
        setLogsMode={setLogsMode}
        showServiceChips={false}
      />,
    );
    expect(screen.getByTestId('raw-terminal')).toHaveTextContent('web');
    expect(screen.queryByTestId('structured-log-viewer')).toBeNull();
    expect(lastViewerShowServiceChips).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: /Structured/i }));
    expect(setLogsMode).toHaveBeenCalledWith('structured');
  });
});
