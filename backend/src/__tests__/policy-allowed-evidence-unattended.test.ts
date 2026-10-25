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
  _resetTrivyMissingNotificationStateForTests();
  settings.current = { security_scanner_unavailable: 'allow' };
});

describe('unattended operations allowed on a missing scanner', () => {
  it('leaves an audit row attributed to the scheduled task', async () => {
    const svc = SchedulerService.getInstance() as unknown as SchedulerGate;
    await svc.enforceSchedulerPolicyGate('web', 1, 'Auto-update', '/api/schedules/7/run');

    expect(insertAuditLog).toHaveBeenCalledTimes(1);
    const entry = insertAuditLog.mock.calls[0][0] as { username: string; path: string; summary: string };
    expect(entry.username).toBe('scheduler:auto-update');
    expect(entry.path).toBe('/api/schedules/7/run');
    expect(entry.summary).toContain('policy.evidence_allowed');
    expect(entry.summary).toContain('scanner_availability:unavailable');
    expect(entry.summary).toContain('security_scanner_unavailable=allow');
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
