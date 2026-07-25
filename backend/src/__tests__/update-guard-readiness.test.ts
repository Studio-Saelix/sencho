import { describe, it, expect } from 'vitest';
import {
  aggregateVerdict,
  backupSlotSignal,
  containersSignal,
  diskSignal,
  driftSignal,
  healthchecksSignal,
  preflightSignal,
  updatePreviewSignal,
  buildServicesSignal,
} from '../services/updateGuard/readiness';
import type { ContainerProbe, ReadinessSignal } from '../services/updateGuard/types';
import type { UpdatePreviewSummary } from '../services/UpdatePreviewService';

const NOW = 1_750_000_000_000;

const probe = (over: Partial<ContainerProbe> = {}): ContainerProbe => ({
  name: 'app-web-1',
  state: 'running',
  health: null,
  exitCode: null,
  hasHealthcheck: false,
  restartPolicy: 'unless-stopped',
  mounts: [],
  ...over,
});

const summary = (over: Partial<UpdatePreviewSummary> = {}): UpdatePreviewSummary => ({
  has_update: false,
  primary_image: null,
  current_tag: null,
  next_tag: null,
  semver_bump: 'none',
  update_kind: 'none',
  blocked: false,
  blocked_reason: null,
  has_build_services: false,
  rebuild_available: false,
  verification_failed: false,
  verification_error: null,
  ...over,
});

describe('preflightSignal', () => {
  const cases = [
    { activeStatus: 'never-run', expected: 'unknown', affects: false },
    { activeStatus: 'blocker', expected: 'blocked', affects: true },
    { activeStatus: 'unrenderable', expected: 'attention', affects: true },
    { activeStatus: 'high', expected: 'attention', affects: true },
    { activeStatus: 'warning', expected: 'warning', affects: true },
    { activeStatus: 'pass', expected: 'ok', affects: true },
    { activeStatus: 'info', expected: 'ok', affects: true },
  ] as const;

  it.each(cases)('maps preflight activeStatus $activeStatus to $expected', ({ activeStatus, expected, affects }) => {
    const signal = preflightSignal({ activeStatus });
    expect(signal.status).toBe(expected);
    expect(signal.affectsVerdict).toBe(affects);
  });

  it('degrades a read failure to a non-verdict-affecting unknown', () => {
    const signal = preflightSignal('error');
    expect(signal.status).toBe('unknown');
    expect(signal.affectsVerdict).toBe(false);
  });
});

describe('driftSignal', () => {
  it('warns on open findings and is ok at zero', () => {
    expect(driftSignal(2).status).toBe('warning');
    expect(driftSignal(0).status).toBe('ok');
    expect(driftSignal('error')).toMatchObject({ status: 'unknown', affectsVerdict: false });
  });
});

describe('containersSignal', () => {
  it('is ok when all containers run normally', () => {
    expect(containersSignal([probe(), probe({ name: 'app-db-1' })]).status).toBe('ok');
  });

  it('warns when the stack is not running', () => {
    const signal = containersSignal([]);
    expect(signal.status).toBe('warning');
    expect(signal.detail).toContain('not running');
  });

  it('flags unhealthy, restarting, and crashed containers for review', () => {
    expect(containersSignal([probe({ health: 'unhealthy' })]).status).toBe('attention');
    expect(containersSignal([probe({ state: 'restarting' })]).status).toBe('attention');
    expect(containersSignal([probe({ state: 'exited', exitCode: 1 })]).status).toBe('attention');
  });

  it('does not flag a cleanly exited container', () => {
    expect(containersSignal([probe(), probe({ state: 'exited', exitCode: 0 })]).status).toBe('ok');
  });

  it('treats a docker error as a verdict-affecting unknown', () => {
    expect(containersSignal('error')).toMatchObject({ status: 'unknown', affectsVerdict: true });
  });
});

describe('healthchecksSignal', () => {
  it('is informational and never affects the verdict', () => {
    for (const input of [[probe()], [probe({ hasHealthcheck: true })], [], 'error'] as const) {
      const signal = healthchecksSignal(input as ContainerProbe[] | 'error');
      expect(signal.status).toBe('ok');
      expect(signal.affectsVerdict).toBe(false);
    }
  });

  it('states coverage and missing restart policies', () => {
    const signal = healthchecksSignal([
      probe({ hasHealthcheck: true }),
      probe({ name: 'app-db-1', restartPolicy: null }),
    ]);
    expect(signal.detail).toContain('1 of 2');
    expect(signal.detail).toContain('no restart policy');
  });
});

describe('updatePreviewSignal', () => {
  it('reflects a policy block as blocked', () => {
    const signal = updatePreviewSignal(summary({ blocked: true, blocked_reason: 'Policy "prod" blocks critical CVEs' }));
    expect(signal.status).toBe('blocked');
    expect(signal.detail).toContain('prod');
  });

  it('flags a major bump for review', () => {
    expect(updatePreviewSignal(summary({ has_update: true, semver_bump: 'major', current_tag: '1.9.0', next_tag: '2.0.0' })).status).toBe('attention');
  });

  it('warns on an unclassifiable pending update', () => {
    expect(updatePreviewSignal(summary({ has_update: true, semver_bump: 'unknown' })).status).toBe('warning');
  });

  it('is ok for patch and digest updates and for no update', () => {
    expect(updatePreviewSignal(summary({ has_update: true, semver_bump: 'patch', update_kind: 'tag' })).status).toBe('ok');
    expect(updatePreviewSignal(summary({ has_update: true, update_kind: 'digest' })).status).toBe('ok');
    expect(updatePreviewSignal(summary()).status).toBe('ok');
  });

  it('warns when only local build services need a rebuild', () => {
    const signal = updatePreviewSignal(summary({ rebuild_available: true, has_build_services: true }));
    expect(signal.status).toBe('warning');
    expect(signal.detail).toContain('rebuild');
  });

  it('notes build services on a pending registry update', () => {
    const signal = updatePreviewSignal(summary({
      has_update: true,
      semver_bump: 'patch',
      update_kind: 'tag',
      has_build_services: true,
    }));
    expect(signal.detail).toContain('Local build services');
  });

  it('degrades a preview failure to a non-verdict-affecting unknown', () => {
    expect(updatePreviewSignal('error')).toMatchObject({ status: 'unknown', affectsVerdict: false });
  });
});

describe('buildServicesSignal', () => {
  it('is ok when no build services are declared', () => {
    expect(buildServicesSignal([]).status).toBe('ok');
  });

  it('warns with service names when build services exist', () => {
    const signal = buildServicesSignal(['app', 'worker']);
    expect(signal.status).toBe('warning');
    expect(signal.affectsVerdict).toBe(false);
    expect(signal.detail).toContain('app, worker');
  });

  it('degrades read failures to unknown', () => {
    expect(buildServicesSignal('error')).toMatchObject({ status: 'unknown', affectsVerdict: false });
  });
});

describe('backupSlotSignal', () => {
  it('is ok with an existing backup and warns without one', () => {
    expect(backupSlotSignal({ exists: true, timestamp: NOW - 60_000 }, NOW).status).toBe('ok');
    expect(backupSlotSignal({ exists: false, timestamp: null }, NOW).status).toBe('warning');
    expect(backupSlotSignal('error', NOW)).toMatchObject({ status: 'unknown', affectsVerdict: false });
  });
});

describe('diskSignal', () => {
  it('grades disk pressure against the alert threshold', () => {
    expect(diskSignal({ usePercent: 50, limitPercent: 90 }).status).toBe('ok');
    expect(diskSignal({ usePercent: 86, limitPercent: 90 }).status).toBe('warning');
    expect(diskSignal({ usePercent: 90, limitPercent: 90 }).status).toBe('attention');
    expect(diskSignal({ usePercent: 97, limitPercent: 90 }).status).toBe('attention');
    expect(diskSignal(null)).toMatchObject({ status: 'unknown', affectsVerdict: false });
    expect(diskSignal('error')).toMatchObject({ status: 'unknown', affectsVerdict: false });
  });
});

describe('aggregateVerdict', () => {
  const signal = (status: ReadinessSignal['status'], affectsVerdict = true): ReadinessSignal => ({
    id: 'drift',
    status,
    title: 't',
    detail: 'd',
    affectsVerdict,
  });

  it('orders blocked > attention > unknown > warning > ready', () => {
    expect(aggregateVerdict([signal('ok'), signal('blocked'), signal('attention'), signal('unknown'), signal('warning')])).toBe('blocked');
    expect(aggregateVerdict([signal('ok'), signal('attention'), signal('unknown'), signal('warning')])).toBe('review_required');
    expect(aggregateVerdict([signal('ok'), signal('unknown'), signal('warning')])).toBe('unknown');
    expect(aggregateVerdict([signal('ok'), signal('warning')])).toBe('ready_with_warnings');
    expect(aggregateVerdict([signal('ok'), signal('ok')])).toBe('ready');
  });

  it('ignores informational unknowns', () => {
    expect(aggregateVerdict([signal('ok'), signal('unknown', false)])).toBe('ready');
    expect(aggregateVerdict([signal('warning'), signal('unknown', false)])).toBe('ready_with_warnings');
  });

  it('reaches every verdict from realistic signal sets', () => {
    expect(aggregateVerdict([preflightSignal({ activeStatus: 'blocker' }), driftSignal(0)])).toBe('blocked');
    expect(aggregateVerdict([preflightSignal({ activeStatus: 'high' }), driftSignal(0)])).toBe('review_required');
    expect(aggregateVerdict([containersSignal('error'), driftSignal(0)])).toBe('unknown');
    expect(aggregateVerdict([driftSignal(1), preflightSignal({ activeStatus: 'pass' })])).toBe('ready_with_warnings');
    expect(aggregateVerdict([driftSignal(0), preflightSignal({ activeStatus: 'pass' }), healthchecksSignal([probe()])])).toBe('ready');
  });
});

describe('updatePreviewSignal verification failure', () => {
  it('does not claim no pending update when digest verification failed', () => {
    const signal = updatePreviewSignal(summary({
      verification_failed: true,
      verification_error: 'Registry unreachable',
    }));
    expect(signal.status).toBe('unknown');
    expect(signal.detail).toMatch(/Digest verification failed/);
    expect(signal.detail).toMatch(/Registry unreachable/);
    expect(signal.detail).not.toMatch(/No pending image update detected/);
  });
});
