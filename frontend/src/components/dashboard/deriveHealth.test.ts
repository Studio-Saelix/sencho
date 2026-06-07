import { describe, it, expect } from 'vitest';
import { deriveHealth } from './deriveHealth';
import type { Stats, SystemStats, NotificationItem } from './types';

const stats = (over: Partial<Stats> = {}): Stats => ({
  active: 5, managed: 5, unmanaged: 0, exited: 0, total: 5, ...over,
});

// deriveHealth only reads cpu.usage, memory.usagePercent and disk?.usagePercent.
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
});
