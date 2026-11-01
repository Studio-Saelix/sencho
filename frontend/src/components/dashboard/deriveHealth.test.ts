import { describe, it, expect } from 'vitest';
import { deriveHealth } from './deriveHealth';
import type { Stats, SystemStats, NotificationItem } from './types';

const stats = (over: Partial<Stats> = {}): Stats => ({
  active: 5, managed: 5, unmanaged: 0, exited: 0, total: 5, ...over,
});

// deriveHealth only reads cpu.usage, memory.effectiveUsagePercent (falling back
// to memory.usagePercent) and disk?.usagePercent.
const sys = (cpu: string, ram: string, disk: string | null): SystemStats => ({
  cpu: { usage: cpu, cores: 8 },
  memory: { total: 100, used: 50, free: 50, usagePercent: ram },
  disk: disk === null ? null : { fs: '/', mount: '/', total: 100, used: 50, free: 50, usagePercent: disk },
});

const note = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 1, level: 'error', message: 'x', timestamp: 0, is_read: 0, ...over,
});

describe('deriveHealth', () => {
  it('reports healthy when all metrics are low and nothing is wrong', () => {
    const r = deriveHealth(stats(), sys('10', '20', '30'), []);
    expect(r.level).toBe('healthy');
    expect(r.reasons).toEqual(['All systems nominal']);
  });

  it('escalates to degraded at the 80 boundary but not at 79', () => {
    expect(deriveHealth(stats(), sys('80', '20', '30'), []).level).toBe('degraded');
    expect(deriveHealth(stats(), sys('79', '20', '30'), []).level).toBe('healthy');
  });

  it('escalates to critical at the 90 boundary', () => {
    expect(deriveHealth(stats(), sys('20', '90', '30'), []).level).toBe('critical');
  });

  it('treats exited containers as degraded with a reason', () => {
    const r = deriveHealth(stats({ exited: 2 }), sys('10', '20', '30'), []);
    expect(r.level).toBe('degraded');
    expect(r.reasons).toContain('2 exited');
  });

  it('escalates to critical when exits AND unread errors coincide below 90', () => {
    const r = deriveHealth(stats({ exited: 1 }), sys('10', '20', '30'), [note()]);
    expect(r.level).toBe('critical');
  });

  it('counts only unread error-level notifications, with pluralization', () => {
    // A read error and an unread warning must both be ignored.
    const ignored = deriveHealth(stats(), sys('10', '20', '30'), [
      note({ is_read: 1 }),
      note({ level: 'warning' }),
    ]);
    expect(ignored.level).toBe('healthy');

    const single = deriveHealth(stats(), sys('10', '20', '30'), [note()]);
    expect(single.level).toBe('degraded');
    expect(single.reasons).toContain('1 unread error');

    const many = deriveHealth(stats(), sys('10', '20', '30'), [note(), note({ id: 2 })]);
    expect(many.reasons).toContain('2 unread errors');
  });

  it('treats missing system stats and disk as zero usage', () => {
    expect(deriveHealth(stats(), null, []).level).toBe('healthy');
    expect(deriveHealth(stats(), sys('10', '20', null), []).level).toBe('healthy');
  });

  it('prefers the balloon-adjusted percent so health matches the Memory tile', () => {
    const system = sys('10', '90', '30');
    const r = deriveHealth(
      stats(),
      {
        ...system,
        memory: {
          ...system.memory,
          ballooned: 76,
          effectiveUsed: 14,
          effectiveTotal: 100,
          effectiveUsagePercent: '14',
        },
      },
      [],
    );
    expect(r.level).toBe('healthy');
    expect(r.reasons).toEqual(['All systems nominal']);
  });

  it('escalates on a high balloon-adjusted percent and reports the adjusted number', () => {
    const system = sys('10', '20', '30');
    const r = deriveHealth(
      stats(),
      {
        ...system,
        memory: {
          ...system.memory,
          ballooned: 10,
          effectiveUsed: 95,
          effectiveTotal: 100,
          effectiveUsagePercent: '95',
        },
      },
      [],
    );
    expect(r.level).toBe('critical');
    expect(r.reasons).toContain('RAM 95%');
  });

  it('falls back to raw usagePercent when balloon fields are absent', () => {
    const r = deriveHealth(stats(), sys('10', '90', '30'), []);
    expect(r.level).toBe('critical');
    expect(r.reasons).toContain('RAM 90%');
  });
});

// Unknown host usage (Sencho inside an LXC with no cgroup mount) is not 0%: it
// must never move the verdict, and it must stay visible as a reason.
const unknownSys = (over: Partial<SystemStats> = {}): SystemStats => ({
  cpu: { usage: null, cores: 2 },
  memory: { total: 4 * 1024 ** 3, used: null, free: null, usagePercent: null },
  disk: { fs: '/', mount: '/', total: 100, used: 10, free: 90, usagePercent: '10' },
  ...over,
});

describe('deriveHealth with unknown host usage', () => {
  it('stays healthy and names both unknown dimensions', () => {
    const r = deriveHealth(stats(), unknownSys(), []);
    expect(r.level).toBe('healthy');
    expect(r.reasons).toEqual(['CPU and memory usage unknown']);
  });

  it('names a single unknown dimension', () => {
    expect(deriveHealth(stats(), unknownSys({ cpu: { usage: '12.0', cores: 2 } }), []).reasons)
      .toEqual(['memory usage unknown']);
    expect(deriveHealth(stats(), unknownSys({ memory: { total: 4, used: 1, free: 3, usagePercent: '25' } }), []).reasons)
      .toEqual(['CPU usage unknown']);
  });

  it('never lets an unknown reading change the level', () => {
    const healthy = deriveHealth(stats(), unknownSys(), []);
    expect(healthy.level).toBe('healthy');
    // A real breach elsewhere still escalates, regardless of the unknowns.
    const diskHigh = deriveHealth(stats(), unknownSys({
      disk: { fs: '/', mount: '/', total: 100, used: 95, free: 5, usagePercent: '95' },
    }), []);
    expect(diskHigh.level).toBe('critical');
    expect(diskHigh.reasons).toContain('Disk 95%');
    expect(diskHigh.reasons.join(' ')).not.toContain('usage unknown');
  });

  it('keeps the neutral verdict when the sample has not loaded yet', () => {
    expect(deriveHealth(stats(), null, []).reasons).toEqual(['All systems nominal']);
  });
});
