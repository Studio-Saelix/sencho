/**
 * Rendering tests for the portfolio attention queue.
 *
 * What matters: failures sort ahead of pending decisions, the *reason* words
 * are inline (never tooltip-only), and every entry drills into the owning
 * surface rather than duplicating it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
