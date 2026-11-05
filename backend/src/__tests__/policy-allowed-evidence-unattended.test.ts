/**
 * The unattended paths have no response to put an allowed-on-incomplete-evidence
 * decision in, so the durable audit row is the only record they can leave.
 *
 * Drives the real scheduler gate and the shared `assertPolicyGateAllows` through
 * the real engine, with only the stores and the scanner stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertAuditLog, dispatchAlert, settings } = vi.hoisted(() => ({
  insertAuditLog: vi.fn(),
  dispatchAlert: vi.fn(),
  settings: { current: {} as Record<string, string> },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: () => settings.current,
      getMatchingPolicy: () => ({
        id: 1, name: 'prod-gate', node_id: null, node_identity: 'self-node',
        stack_pattern: '*', max_severity: 'HIGH', block_on_deploy: 1, enabled: 1,
        block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
        replicated_from_control: 0, created_at: 0, updated_at: 0,
      }),
      insertAuditLog,
      getCveSuppressions: () => [],
      getCveIntel: () => new Map(),
      getAllVulnerabilityDetails: () => [],
    }),
  },
}));
vi.mock('../services/TrivyService', () => ({
  default: { getInstance: () => ({ isTrivyAvailable: () => false }) },
}));
vi.mock('../services/NotificationService', () => ({
  NotificationService: { getInstance: () => ({ dispatchAlert }) },
}));
vi.mock('../services/FleetSyncService', () => ({ FleetSyncService: { getSelfIdentity: () => 'self-node' } }));

import { assertPolicyGateAllows, buildSystemPolicyGateOptions } from '../helpers/policyGate';
import { _resetTrivyMissingNotificationStateForTests } from '../services/PolicyEnforcement';
import { SchedulerService } from '../services/SchedulerService';

type SchedulerGate = { enforceSchedulerPolicyGate: (s: string, n: number, a: 'Auto-start' | 'Auto-update', p: string) => Promise<void> };

beforeEach(() => {
  insertAuditLog.mockReset();
  dispatchAlert.mockReset();
  // safeDispatch attaches a .catch to the returned promise.
  dispatchAlert.mockReturnValue(Promise.resolve());
  _resetTrivyMissingNotificationStateForTests();
  settings.current = { security_scanner_unavailable: 'allow' };
});

describe('unattended operations allowed on a missing scanner', () => {
  it('leaves an audit row attributed to the scheduled task', async () => {
    // A scheduled auto-update pulls without a person present, so the Candidate
    // not evaluated rule decides it. Set to allow, the decision is recorded like
    // any other allow-on-incomplete-evidence.
    settings.current = { security_scanner_unavailable: 'allow', security_candidate_unproven: 'allow' };
    const svc = SchedulerService.getInstance() as unknown as SchedulerGate;
    await svc.enforceSchedulerPolicyGate('web', 1, 'Auto-update', '/api/schedules/7/run');

    expect(insertAuditLog).toHaveBeenCalledTimes(1);
    const entry = insertAuditLog.mock.calls[0][0] as { username: string; path: string; summary: string };
    expect(entry.username).toBe('scheduler:auto-update');
    expect(entry.path).toBe('/api/schedules/7/run');
    expect(entry.summary).toContain('policy.evidence_allowed');
    expect(entry.summary).toContain('scanner_availability:unavailable');
    expect(entry.summary).toContain('security_candidate_unproven=allow');
  });

  it('holds a scheduled auto-update on a missing scanner at the shipped defaults', async () => {
    // The documented behavior change: a scheduled run has nobody to ask, so a
    // scanner it cannot use leaves the image unproven and the run is held, even
    // though Scanner unavailable alone would have allowed it.
    const svc = SchedulerService.getInstance() as unknown as SchedulerGate;
    await expect(
      svc.enforceSchedulerPolicyGate('web', 1, 'Auto-update', '/api/schedules/7/run'),
    ).rejects.toThrow(/Candidate not evaluated/);
    expect(insertAuditLog).not.toHaveBeenCalled();
    expect(dispatchAlert).toHaveBeenCalledWith(
      'warning', 'scan_finding', expect.stringContaining('Auto-update blocked for "web"'), expect.anything(),
    );
  });

  it('hands the decision back from the shared helper, and the audit row is written either way', async () => {
    const allowed = await assertPolicyGateAllows('web', 1, buildSystemPolicyGateOptions('webhook:deploy'));

    expect(allowed.policyEvidence).toMatchObject({
      policy: { name: 'prod-gate' },
      bypassed: false,
      evidence: { outcome: 'allow', records: [expect.objectContaining({ state: 'unavailable' })] },
    });
    expect(insertAuditLog).toHaveBeenCalledTimes(1);
    expect((insertAuditLog.mock.calls[0][0] as { username: string }).username).toBe('webhook:deploy');
  });

  it('still warns once when the operator chose warn, and records the same decision', async () => {
    settings.current = { security_scanner_unavailable: 'warn' };
    const allowed = await assertPolicyGateAllows('web', 1, buildSystemPolicyGateOptions('webhook:deploy'));

    expect(allowed.policyEvidence?.evidence.outcome).toBe('warn');
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    expect((insertAuditLog.mock.calls[0][0] as { summary: string }).summary).toContain('evidence_outcome=warn');
  });
});
