import { describe, it, expect, vi } from 'vitest';
import type { ReadinessFinding, ReadinessReasonCode } from '@/types/readiness';
import { canRunVerb, resolveVerb } from './readinessVerbs';

function finding(code: ReadinessReasonCode, over: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: `x:${code}`,
    domain: 'workloads',
    nodeId: 2,
    stack: 'web',
    code,
    severity: 'attention',
    count: 1,
    verdict: null,
    detail: null,
    target: { surface: 'node-details', nodeId: 2 },
    fingerprint: 'fp',
    dismissPolicy: 'any',
    ...over,
  };
}

describe('resolveVerb', () => {
  it.each([
    ['node_unreachable', 'Test connection', 1],
    ['probe_timeout', 'Test connection', 1],
    ['contact_stale', 'Test connection', 1],
    ['workloads_exited', 'Start stack', 1],
    ['workloads_partial', 'Start stopped services', 1],
    ['workloads_unknown', 'Check again', 1],
    ['status_evidence_degraded', 'Check again', 1],
    ['status_evidence_stale', 'Check again', 1],
    ['stacks_unknown', 'Check again', 1],
    ['snapshot_failed', 'Take fleet snapshot', 1],
    ['scans_never_completed', 'Scan node', 1],
    ['scans_stale', 'Scan node', 1],
    ['scanner_unavailable', 'Install scanner', 2],
    ['control_paused', 'Re-anchor to this hub', 2],
  ] as const)('%s resolves with "%s" in %i click(s)', (code, label, clicks) => {
    expect(resolveVerb(finding(code))).toMatchObject({ label, clicks });
  });

  it.each([
    'pilot_disconnected',
    'capability_absent',
    'summary_truncated',
    'posture_partial',
    'posture_action_needed',
    'control_degraded',
    'control_unknown',
    'domain_error',
  ] as const)('%s keeps its named navigation', (code) => {
    expect(resolveVerb(finding(code))).toBeNull();
  });

  it('needs a stack to start one', () => {
    expect(resolveVerb(finding('workloads_exited', { stack: null }))).toBeNull();
  });

  it('reviews an update only when one is known and the verdict is not blocked', () => {
    const base = { stack: 'web', verdict: { kind: 'update', value: 'review_required' } } as const;
    expect(resolveVerb(finding('update_review_required', { ...base, hasUpdate: true }))).toMatchObject({ id: 'review-update', clicks: 2 });
    expect(resolveVerb(finding('update_review_required', { ...base, hasUpdate: false }))).toBeNull();
    // A peer that predates the field cannot say, so the verb is withheld.
    expect(resolveVerb(finding('update_review_required', base))).toBeNull();
    expect(resolveVerb(finding('update_blocked', { stack: 'web', hasUpdate: true, verdict: { kind: 'update', value: 'blocked' } }))).toBeNull();
  });

  it('captures a recovery point only for a missing compose source', () => {
    const rollback = { verdict: { kind: 'rollback', value: 'not_ready' } } as const;
    expect(resolveVerb(finding('rollback_not_ready', { ...rollback, topReasonId: 'compose_source' }))).toMatchObject({ id: 'capture-recovery' });
    expect(resolveVerb(finding('rollback_partial', { ...rollback, topReasonId: 'volume_data' }))).toBeNull();
    expect(resolveVerb(finding('rollback_not_ready', rollback))).toBeNull();
  });
});

describe('canRunVerb', () => {
  const verbOf = (code: ReadinessReasonCode, over: Partial<ReadinessFinding> = {}) => {
    const subject = finding(code, over);
    const verb = resolveVerb(subject);
    if (verb === null) throw new Error(`no verb for ${code}`);
    return { verb, subject };
  };

  it('checks deploy on the exact stack and node', () => {
    const can = vi.fn().mockReturnValue(true);
    const { verb, subject } = verbOf('workloads_exited');
    expect(canRunVerb(can, false, verb, subject)).toBe(true);
    expect(can).toHaveBeenCalledWith('stack:deploy', 'stack', 'web', 2);
  });

  it('checks node management on the finding\'s node, and globally for a node scan', () => {
    const can = vi.fn().mockReturnValue(true);
    const test = verbOf('node_unreachable', { stack: null });
    canRunVerb(can, false, test.verb, test.subject);
    expect(can).toHaveBeenLastCalledWith('node:manage', 'node', '2');
    const scan = verbOf('scans_stale', { stack: null });
    canRunVerb(can, false, scan.verb, scan.subject);
    expect(can).toHaveBeenLastCalledWith('node:manage');
  });

  it('requires an admin for snapshots, the scanner and re-anchoring', () => {
    const can = vi.fn().mockReturnValue(true);
    for (const code of ['snapshot_failed', 'scanner_unavailable', 'control_paused'] as const) {
      const { verb, subject } = verbOf(code, { stack: null });
      expect(canRunVerb(can, false, verb, subject)).toBe(false);
      expect(canRunVerb(can, true, verb, subject)).toBe(true);
    }
  });

  it('lets anyone check again', () => {
    const { verb, subject } = verbOf('workloads_unknown');
    expect(canRunVerb(() => false, false, verb, subject)).toBe(true);
  });
});
