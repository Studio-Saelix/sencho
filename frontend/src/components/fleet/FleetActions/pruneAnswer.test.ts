import { expect, it } from 'vitest';
import type { FleetPruneNodeResult } from '@/lib/prunePlan';
import { outcomeSummary, planAnswer, summarizePlan } from './pruneAnswer';

function plan(overrides: Partial<FleetPruneNodeResult> = {}): FleetPruneNodeResult {
  return { nodeId: 1, nodeName: 'central', reachable: true, fingerprint: 'fp', reclaimableBytes: 0, items: [], targets: [], ...overrides };
}

const image = (sizeBytes?: number) => ({
  target: 'images' as const, id: `i-${sizeBytes}`, name: 'img', sizeBytes, managed: true, reason: 'unused', image: { references: [] },
});
const volume = (id: string) => ({
  target: 'volumes' as const, id, name: id, managed: true, reason: 'unused', volume: {},
});

it('leads a sized plan with the bytes it frees', () => {
  const answer = planAnswer(summarizePlan([plan({ reclaimableBytes: 2048, items: [image(2048)] })]), null);
  expect(answer).toMatchObject({ tone: 'warning', title: '2 KB to reclaim', line: '1 item on 1 node' });
});

it('leads a plan of unsized items with the item count instead of 0 Bytes', () => {
  const answer = planAnswer(summarizePlan([plan({ items: [volume('a'), volume('b')] })]), null);
  expect(answer.title).toBe('2 items to reclaim');
  expect(answer.detail).toBe('No size is reported for these items.');
});

it('keeps a note when only some items report no size', () => {
  const answer = planAnswer(summarizePlan([plan({ reclaimableBytes: 1024, items: [image(1024), volume('a')] })]), null);
  expect(answer.title).toBe('1 KB to reclaim');
  expect(answer.detail).toBe('1 item reported no size.');
});

it('carries the stale-plan notice and the unreachable marker', () => {
  const unreachable = plan({ nodeId: 2, nodeName: 'edge', reachable: false, fingerprint: undefined });
  const answer = planAnswer(summarizePlan([plan({ reclaimableBytes: 10, items: [image(10)] }), unreachable]), 'The plan changed.');
  expect(answer.marker).toBe('1 unreachable, left out');
  expect(answer.detail).toBe('The plan changed.');
});

it('says so when no node could be reviewed', () => {
  const answer = planAnswer(summarizePlan([plan({ reachable: false, fingerprint: undefined })]), null);
  expect(answer).toMatchObject({ tone: 'warning', title: 'No node reachable' });
});

it('leads a finished prune of unsized items with the items removed', () => {
  const { answer } = outcomeSummary([{
    nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 0,
    outcomes: [{ id: 'a', target: 'volumes', status: 'removed' }, { id: 'b', target: 'volumes', status: 'removed' }],
    targets: [{ target: 'volumes', success: true, reclaimedBytes: 0, dryRun: false }],
  }]);
  expect(answer).toMatchObject({ tone: 'success', title: 'Removed 2 items', line: 'Across 1 node' });
});

it('counts skipped and failed items on a finished prune without hiding the failure', () => {
  const { answer, failedAny } = outcomeSummary([{
    nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 1024,
    outcomes: [
      { id: 'a', target: 'images', status: 'removed', sizeBytes: 1024 },
      { id: 'b', target: 'images', status: 'skipped', reason: 'Became active' },
      { id: 'c', target: 'images', status: 'failed', error: 'refused' },
    ],
    targets: [{ target: 'images', success: false, reclaimedBytes: 1024, dryRun: false }],
  }]);
  expect(failedAny).toBe(true);
  expect(answer).toMatchObject({ tone: 'warning', title: '1 KB reclaimed with failures', marker: '1 failed · 1 skipped' });
});
