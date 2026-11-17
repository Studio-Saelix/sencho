import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

it('opens a lone node to its items and keeps several nodes collapsed until opened', async () => {
  const user = userEvent.setup();
  const second: FleetPruneNodeResult = { ...plan, nodeId: 2, nodeName: 'edge', items: [items[0]] };
  const first = render(<PrunePlanResults planResults={[plan]} />);
  expect(screen.getByText('removed:latest')).toBeInTheDocument();
  first.unmount();
  render(<PrunePlanResults planResults={[plan, second]} />);
  expect(screen.queryByText('removed:latest')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /central/ }));
  expect(screen.getByText('removed:latest')).toBeInTheDocument();
});

it('shows the exception count on a collapsed finished node and an excluded node as a flat row', async () => {
  const second: FleetPruneNodeResult = { ...plan, nodeId: 2, nodeName: 'edge', items };
  const down: FleetPruneNodeResult = { nodeId: 3, nodeName: 'far', reachable: false, error: 'Pilot tunnel is disconnected', reclaimableBytes: 0, targets: [] };
  const execution: FleetPruneNodeResult = {
    nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 0,
    outcomes: [
      { target: 'images', id: 'skipped-id', status: 'skipped', reason: 'Became active' },
      { target: 'images', id: 'failed-id', status: 'failed', error: 'Docker refused removal' },
    ],
    targets: [],
  };
  render(<PrunePlanResults planResults={[plan, second, down]} executeResults={[execution]} />);
  expect(screen.getByRole('button', { name: /central/ })).toHaveTextContent('1 failed · 1 skipped');
  const excluded = screen.getByText('far · excluded').parentElement;
  expect(excluded?.className).not.toMatch(/\brounded\b|bg-card/);
  expect(excluded?.querySelector('button')).toBeNull();
  expect(screen.getByText('Pilot tunnel is disconnected')).toBeInTheDocument();
});

it('does not repeat the total on a lone node but states it per node when there are several', () => {
  const first = render(<PrunePlanResults planResults={[{ ...plan, reclaimableBytes: 2048 }]} />);
  expect(screen.getByRole('button', { name: /central/ })).not.toHaveTextContent('KB');
  first.unmount();
  render(<PrunePlanResults planResults={[{ ...plan, reclaimableBytes: 2048 }, { ...plan, nodeId: 2, nodeName: 'edge', reclaimableBytes: 1024 }]} />);
  expect(screen.getByRole('button', { name: /central/ })).toHaveTextContent('central · 2 KB');
  expect(screen.getByRole('button', { name: /edge/ })).toHaveTextContent('edge · 1 KB');
});

const down: FleetPruneNodeResult = { nodeId: 3, nodeName: 'far', reachable: false, error: 'Pilot tunnel is disconnected', reclaimableBytes: 0, targets: [] };

it('treats the only reachable node as solo even when other nodes are excluded', () => {
  render(<PrunePlanResults planResults={[{ ...plan, reclaimableBytes: 2048 }, down]} />);
  const trigger = screen.getByRole('button', { name: /central/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(trigger).not.toHaveTextContent('KB');
  expect(screen.getByText('far · excluded')).toBeInTheDocument();
});

it('shows only the flat row, with nothing to open, when the single node is excluded', () => {
  render(<PrunePlanResults planResults={[down]} />);
  expect(screen.getByText('far · excluded')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('shows the reclaimed total for a finished node only when several nodes ran, and no exception meta when everything was removed', () => {
  const run = (nodeId: number, nodeName: string): FleetPruneNodeResult => ({
    nodeId, nodeName, reachable: true, reclaimedBytes: 2048,
    outcomes: [{ target: 'images', id: 'removed-id', status: 'removed' }], targets: [],
  });
  const first = render(<PrunePlanResults planResults={[plan]} executeResults={[run(1, 'central')]} />);
  expect(screen.getByRole('button', { name: /central/ })).not.toHaveTextContent('KB');
  first.unmount();
  render(<PrunePlanResults planResults={[plan, { ...plan, nodeId: 2, nodeName: 'edge' }]} executeResults={[run(1, 'central'), run(2, 'edge')]} />);
  const trigger = screen.getByRole('button', { name: /central/ });
  expect(trigger).toHaveTextContent('central · 2 KB');
  expect(trigger).not.toHaveTextContent(/failed|skipped|error/);
});

it('flags a node-level error on the collapsed row', () => {
  const failedRun: FleetPruneNodeResult = { nodeId: 1, nodeName: 'central', reachable: true, error: 'Docker daemon unreachable', targets: [] };
  render(<PrunePlanResults planResults={[plan, { ...plan, nodeId: 2, nodeName: 'edge' }]} executeResults={[failedRun]} />);
  expect(screen.getByRole('button', { name: /central/ })).toHaveTextContent('error');
});
