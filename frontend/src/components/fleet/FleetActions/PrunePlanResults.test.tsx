import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetPruneNodeResult, PrunePlanItem } from '@/lib/prunePlan';
import { PrunePlanResults } from './PrunePlanResults';

const items: PrunePlanItem[] = [
  { target: 'images', id: 'removed-id', name: 'removed:latest', managed: true, reason: 'unused', image: { references: ['removed:latest'] } },
  { target: 'images', id: 'skipped-id', name: 'skipped:latest', managed: true, reason: 'unused', image: { references: ['skipped:latest'] } },
  { target: 'images', id: 'failed-id', name: 'failed:latest', managed: false, reason: 'unused', image: { references: ['failed:latest'] } },
];

const plan: FleetPruneNodeResult = {
  nodeId: 1,
  nodeName: 'central',
  reachable: true,
  fingerprint: 'plan',
  items,
  reclaimableBytes: 0,
  targets: [{ target: 'images', success: true, reclaimedBytes: 0, dryRun: true }],
};

it('renders removed, skipped, and failed outcomes with reviewed item names', () => {
  const execution: FleetPruneNodeResult = {
    nodeId: 1,
    nodeName: 'central',
    reachable: true,
    reclaimedBytes: 0,
    outcomes: [
      { target: 'images', id: 'removed-id', status: 'removed' },
      { target: 'images', id: 'skipped-id', status: 'skipped', reason: 'Became active' },
      { target: 'images', id: 'failed-id', status: 'failed', error: 'Docker refused removal' },
    ],
    targets: [{
      target: 'images', success: false, reclaimedBytes: 0, dryRun: false,
      removed: 1, skipped: 1, failed: 1,
    }],
  };
  render(<PrunePlanResults planResults={[plan]} executeResults={[execution]} />);

  expect(screen.getByText('removed:latest')).toBeInTheDocument();
  expect(screen.getByText('skipped:latest')).toBeInTheDocument();
  expect(screen.getByText('failed:latest')).toBeInTheDocument();
  expect(screen.getByText('removed')).toBeInTheDocument();
  expect(screen.getByText('skipped')).toBeInTheDocument();
  expect(screen.getByText('failed')).toBeInTheDocument();
  expect(screen.getByText('Became active')).toBeInTheDocument();
  expect(screen.getByText('Docker refused removal')).toBeInTheDocument();
});

it('renders the total-only fallback when a remote omits outcomes', () => {
  const execution: FleetPruneNodeResult = {
    nodeId: 1,
    nodeName: 'central',
    reachable: true,
    reclaimedBytes: 1024,
    targets: [{ target: 'images', success: true, reclaimedBytes: 1024, dryRun: false }],
  };
  render(<PrunePlanResults planResults={[plan]} executeResults={[execution]} />);
  expect(screen.getByText('This node reported 1 KB reclaimed without itemized outcomes.')).toBeInTheDocument();
});
