import { describe, it, expect } from 'vitest';
import { foldNodeEstimate } from '../helpers/fleetEstimate';

const node = { nodeId: 1, nodeName: 'local' };

describe('foldNodeEstimate', () => {
  it('returns the sum when every target succeeds', () => {
    expect(foldNodeEstimate(node, [
      { bytes: 500 },
      { bytes: 100 },
    ])).toEqual({
      nodeId: 1,
      nodeName: 'local',
      reclaimableBytes: 600,
      reachable: true,
    });
  });

  it('keeps successful bytes and marks partial when some targets fail', () => {
    expect(foldNodeEstimate(node, [
      { bytes: 500 },
      { bytes: 0, error: 'Docker daemon is busy. Please try again in a moment.' },
      { bytes: 100 },
    ])).toEqual({
      nodeId: 1,
      nodeName: 'local',
      reclaimableBytes: 600,
      reachable: true,
      partial: true,
      error: 'Docker daemon is busy. Please try again in a moment.',
    });
  });

  it('marks the node unreachable when every target fails', () => {
    expect(foldNodeEstimate(node, [
      { bytes: 0, error: 'first failure' },
      { bytes: 0, error: 'second failure' },
    ])).toEqual({
      nodeId: 1,
      nodeName: 'local',
      reclaimableBytes: 0,
      reachable: false,
      error: 'first failure',
    });
  });

  it('surfaces the single-target failure message without partial', () => {
    expect(foldNodeEstimate(node, [
      { bytes: 0, error: 'Docker daemon is busy. Please try again in a moment.' },
    ])).toEqual({
      nodeId: 1,
      nodeName: 'local',
      reclaimableBytes: 0,
      reachable: false,
      error: 'Docker daemon is busy. Please try again in a moment.',
    });
  });
});
