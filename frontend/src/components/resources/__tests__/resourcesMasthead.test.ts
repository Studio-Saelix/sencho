import { describe, it, expect } from 'vitest';
import { formatBytes } from '@/lib/utils';
import { deriveResourcesMastheadState, type UsageData, type UsageLoad } from '../resourcesMasthead';

const ready = (data: UsageData): UsageLoad => ({ status: 'ready', data });

function usage(overrides: Partial<UsageData> = {}): UsageData {
  return {
    reclaimableImages: 0,
    reclaimableContainers: 0,
    reclaimableVolumes: 0,
    reclaimableImageCount: 0,
    reclaimableContainerCount: 0,
    reclaimableVolumeCount: 0,
    managedImageBytes: 0,
    unmanagedImageBytes: 0,
    managedVolumeBytes: 0,
    unmanagedVolumeBytes: 0,
    ...overrides,
  };
}

describe('deriveResourcesMastheadState', () => {
  it('reads as measuring while the first load is pending, with placeholder metadata so nothing shifts', () => {
    const model = deriveResourcesMastheadState({ status: 'loading' });
    expect(model).toMatchObject({ state: 'Measuring disk', tone: 'idle', reclaimableBytes: 0 });
    expect(model.metadata.map((m) => m.value)).toEqual(['--', '--']);
  });

  it('never reads as tidy when the usage could not be read', () => {
    const model = deriveResourcesMastheadState({ status: 'error' });
    expect(model.state).toBe('Disk usage unknown');
    expect(model.tone).toBe('warn');
    expect(model.subtitle).toBe('Could not read disk usage from this node.');
  });

  it('names the node and the cause when the usage read failed for a known reason', () => {
    const silent = deriveResourcesMastheadState({ status: 'error', failure: 'pilot-disconnected' }, 'edge-2');
    expect(silent.subtitle).toBe('The Pilot tunnel to "edge-2" is disconnected. It resumes when the agent reconnects.');
    const rejected = deriveResourcesMastheadState({ status: 'error', failure: 'node-credential' }, 'edge-2');
    expect(rejected.subtitle).toMatch(/stored credential for "edge-2" was rejected/);
    expect(deriveResourcesMastheadState({ status: 'error', failure: 'http' }, 'edge-2').subtitle)
      .toBe('Could not read disk usage from this node.');
  });

  it('is Tidy when nothing is reclaimable', () => {
    const model = deriveResourcesMastheadState(ready(usage({ managedImageBytes: 2000 })));
    expect(model).toMatchObject({ state: 'Tidy', tone: 'live', reclaimableBytes: 0 });
    expect(model.subtitle).toBe('Nothing to reclaim on this node.');
  });

  it('states the total a reclaim frees and what it is made of, with singular and plural nouns', () => {
    const model = deriveResourcesMastheadState(ready(usage({
      reclaimableImages: 1000,
      reclaimableContainers: 24,
      reclaimableVolumes: 500,
      reclaimableImageCount: 3,
      reclaimableContainerCount: 1,
      reclaimableVolumeCount: 2,
    })));
    expect(model.state).toBe(`${formatBytes(1524)} reclaimable`);
    expect(model.tone).toBe('warn');
    expect(model.reclaimableBytes).toBe(1524);
    expect(model.reclaimableItems).toBe(6);
    expect(model.subtitle).toBe('3 unused images · 1 stopped container · 2 dangling volumes');
  });

  it('is Tidy when only storage-driver residue is left and there is nothing to remove', () => {
    const model = deriveResourcesMastheadState(ready(usage({ reclaimableImages: 4_000_000 })));
    expect(model).toMatchObject({ state: 'Tidy', reclaimableBytes: 0, reclaimableItems: 0 });
  });

  it('offers cleanup for a stopped container that never wrote anything', () => {
    const model = deriveResourcesMastheadState(ready(usage({ reclaimableContainerCount: 1 })));
    expect(model).toMatchObject({ state: 'Cleanup available', tone: 'warn', reclaimableBytes: 0, reclaimableItems: 1 });
    expect(model.subtitle).toBe('1 stopped container');
  });

  it('splits managed and external bytes across images and volumes, and keeps reclaimable out of the metadata', () => {
    const model = deriveResourcesMastheadState(ready(usage({
      reclaimableImages: 10,
      managedImageBytes: 1000,
      managedVolumeBytes: 200,
      unmanagedImageBytes: 30,
      unmanagedVolumeBytes: 4,
    })));
    expect(model.metadata).toEqual([
      { label: 'MANAGED', value: formatBytes(1200) },
      { label: 'EXTERNAL', value: formatBytes(34) },
    ]);
  });
});
