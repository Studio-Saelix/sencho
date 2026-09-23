/**
 * Rendering tests for the portfolio attention queue.
 *
 * What matters: failures sort ahead of pending decisions, the *reason* words
 * are inline (never tooltip-only), and every entry opens that application's
 * view, whether or not its row names an owning surface.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { applicationIdFromSearch } from './portfolioNavigation';
import { AttentionQueue } from './AttentionQueue';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

function row(overrides: Partial<GitOpsPortfolioRow>): GitOpsPortfolioRow {
  return {
    id: '1:app-x',
    targetMode: 'direct',
    name: 'web',
    stackName: 'web',
    blueprintId: null,
    nodeId: 1,
    nodeName: 'local',
    repository: {
      configuredRepoUrl: 'https://github.com/example/repo.git',
      host: 'github.com',
      pathname: '/example/repo.git',
      configuredRef: 'main',
    },
    desiredCommitSha: null,
    fetchedCommitSha: null,
    candidateGenerationId: null,
    acceptedGenerationId: null,
    sourceStatus: 'application_generation_accepted',
    artifactStatus: 'artifact_exact',
    artifactQualification: 'exact',
    placementStatus: 'unbound_direct',
    rolloutStatus: 'not_applicable',
    runtimeStatus: 'synced_and_healthy',
    healthStatus: 'passed',
    targets: [],
    drift: { count: 0, classes: [] },
    attention: [],
    posture: 'converged',
    availableActions: [],
    limitations: [],
    lastActivityAt: 1700000000000,
    evidence: { partial: false, unreachableNodes: [], unknown: false },
    ...overrides,
  };
}

describe('AttentionQueue', () => {
  it('renders nothing when no row carries an attention reason', () => {
    const { container } = render(<AttentionQueue rows={[row({})]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one entry per application per reason with the explanation inline', () => {
    render(<AttentionQueue rows={[row({
      attention: ['source_review_pending', 'target_unreachable'],
      name: 'review-web',
    })]} />);
    expect(screen.getAllByText('review-web')).toHaveLength(2);
    expect(screen.getByText(/waiting for review before it can apply/)).toBeTruthy();
    expect(screen.getByText(/required target could not be reached/)).toBeTruthy();
  });

  it('orders failure-toned reasons before pending decisions', () => {
    render(<AttentionQueue rows={[
      row({ attention: ['source_review_pending'], name: 'pending-app', id: '1:a' }),
      row({ attention: ['source_failed'], name: 'failed-app', id: '1:b' }),
    ]} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('failed-app');
    expect(items[1]!.textContent).toContain('pending-app');
  });

  it('opens the application view even for a row with no owning surface identity', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops');
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], nodeId: null, stackName: null })]} />);
    const open = screen.getByRole('button', { name: /web/ });
    expect(open).toBeEnabled();
    fireEvent.click(open);
    expect(applicationIdFromSearch(window.location.search)).toBe('1:app-x');
  });

  it('routes a drill-down to the override when one is given, leaving the URL alone', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops');
    const onDrillDown = vi.fn();
    render(<AttentionQueue rows={[row({ attention: ['source_failed'] })]} onDrillDown={onDrillDown} />);
    fireEvent.click(screen.getByRole('button', { name: /web/ }));
    expect(onDrillDown).toHaveBeenCalledWith(expect.objectContaining({ id: '1:app-x' }));
    expect(window.location.search).toBe('');
  });
});
