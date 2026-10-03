import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PortfolioMasthead } from './PortfolioMasthead';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

function portfolio(overrides: Partial<GitOpsPortfolioResponse['summary']> = {}, coverage: GitOpsPortfolioResponse['coverage'] = [{ nodeId: 1, nodeName: 'local', state: 'ok' }]): GitOpsPortfolioResponse {
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    summary: {
      applications: 4, attentionRequired: 0, failed: 0, inProgress: 1, converged: 3,
      convergedQualified: 0, unknown: 0, drifted: 0, byReason: {}, attentionByNode: {},
      ...overrides,
    },
    coverage,
    attentionQueue: [],
    attentionQueueTruncated: false,
    applications: [],
    nextCursor: null,
    truncated: false,
  };
}

/** The value shown under a tile's label. */
function tile(label: string): HTMLElement {
  const wrapper = screen.getByText(label).parentElement;
  if (!wrapper) throw new Error(`no tile for ${label}`);
  return wrapper;
}

describe('PortfolioMasthead', () => {
  it('leads with the GITOPS kicker, the verdict, and the counts', () => {
    render(<PortfolioMasthead data={portfolio()} staleSince={null} refreshing={false} />);
    expect(screen.getByText('GITOPS')).toBeInTheDocument();
    expect(within(tile('APPLICATIONS')).getByText('4')).toBeInTheDocument();
    expect(within(tile('CONVERGED')).getByText('3')).toBeInTheDocument();
    const attention = within(tile('ATTENTION')).getByText('0');
    expect(attention).not.toHaveClass('text-warning');
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('names the verdict the summary implies', () => {
    render(<PortfolioMasthead data={portfolio({ failed: 1, attentionRequired: 1 })} staleSince={null} refreshing={false} />);
    expect(screen.getByText('Needs action')).toBeInTheDocument();
  });

  it('puts freshness in the meta line and says refreshing while a refresh is in flight', () => {
    const { rerender } = render(<PortfolioMasthead data={portfolio()} staleSince={null} refreshing={false} />);
    expect(screen.getByText(/1\/1 node reporting · updated \d+s/)).toBeInTheDocument();
    expect(screen.queryByText(/refreshing/)).toBeNull();

    rerender(<PortfolioMasthead data={portfolio()} staleSince={null} refreshing />);
    expect(screen.getByText(/1\/1 node reporting · refreshing/)).toBeInTheDocument();
    expect(screen.queryByText(/updated \d+s/)).toBeNull();
  });

  it('says the data is last-known after a failed refresh', () => {
    render(<PortfolioMasthead data={portfolio()} staleSince={Date.now() - 60_000} refreshing={false} />);
    expect(screen.getByText('last refresh failed · showing last-known')).toBeInTheDocument();
  });

  it('counts qualified convergence separately and flags attention', () => {
    render(<PortfolioMasthead data={portfolio({ convergedQualified: 2, attentionRequired: 3, drifted: 1 })} staleSince={null} refreshing={false} />);
    expect(screen.getByText(/2 converged qualified/)).toBeInTheDocument();
    expect(within(tile('ATTENTION')).getByText('3')).toHaveClass('text-warning');
    expect(within(tile('DRIFTED')).getByText('1')).toHaveClass('text-warning');
  });

  it('counts only the nodes that reported', () => {
    render(<PortfolioMasthead
      data={portfolio({}, [{ nodeId: 1, nodeName: 'a', state: 'ok' }, { nodeId: 2, nodeName: 'b', state: 'unreachable' }])}
      staleSince={null}
      refreshing={false}
    />);
    expect(screen.getByText(/1\/2 nodes reporting/)).toBeInTheDocument();
  });
});
