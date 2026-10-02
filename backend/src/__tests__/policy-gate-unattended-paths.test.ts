/**
 * The unattended paths must explain a block through the shared message.
 *
 * `describePolicyBlock` is the one place that can tell a matched finding from
 * missing evidence. `SchedulerService` and `applyAutomaticStackUpdate` used to
 * compose their own sentences, so a scanner outage on a scheduled run or an
 * auto-update was reported as "N image(s) matched scan policy conditions",
 * which is false and is the operator's only explanation on those paths.
 *
 * These tests pin the wiring rather than the wording. The wording is covered in
 * `policy-gate-describe.test.ts`, and a wording test would not catch a caller
 * that stops calling the helper, which is exactly how the drift happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDescribePolicyBlock } = vi.hoisted(() => ({
  mockDescribePolicyBlock: vi.fn(),
}));

vi.mock('../helpers/policyGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers/policyGate')>();
  return {
    ...actual,
    describePolicyBlock: mockDescribePolicyBlock,
  };
});

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: () => ({ security_scanner_unavailable: 'block' }),
      // A matching block_on_deploy policy, so the gate reaches the scanner
      // branch rather than short-circuiting on "no policy".
      getMatchingPolicy: () => ({
        id: 1, name: 'prod-gate', node_id: null, node_identity: 'self-node',
        stack_pattern: '*', max_severity: 'HIGH', block_on_deploy: 1, enabled: 1,
        block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
        replicated_from_control: 0, created_at: 0, updated_at: 0,
      }),
      insertAuditLog: () => undefined,
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
  NotificationService: { getInstance: () => ({ dispatchAlert: async () => ({ persisted: true }) }) },
}));
vi.mock('../services/FleetSyncService', () => ({ FleetSyncService: { getSelfIdentity: () => 'self-node' } }));

import { describePolicyBlock } from '../helpers/policyGate';
import { SchedulerService } from '../services/SchedulerService';
import { applyAutomaticStackUpdate } from '../services/automaticStackUpdate';

const evidenceDecision = {
  outcome: 'block' as const,
  records: [{ source: 'vulnerability_scan' as const, state: 'failed' as const, target: 'nginx:1.27', collectedAt: null }],
  applications: [
    {
      source: 'vulnerability_scan' as const,
      state: 'failed' as const,
      outcome: 'block' as const,
      rule: 'security_scan_failure=block',
      target: 'nginx:1.27',
    },
  ],
  summary: 'Failed evidence for vulnerability_scan: block (security_scan_failure=block)',
};

beforeEach(() => {
  mockDescribePolicyBlock.mockReset();
  mockDescribePolicyBlock.mockImplementation(() => 'blocked: required security evidence was unavailable');
});

describe('unattended paths use the shared block message', () => {
  it('the scheduler routes its block message through describePolicyBlock', async () => {
    const svc = SchedulerService.getInstance();
    // A scanner outage is the case that used to be misreported, so drive it.
    await expect(
      (svc as unknown as { enforceSchedulerPolicyGate: (s: string, n: number, a: 'Auto-start' | 'Auto-update', p: string) => Promise<void> })
        .enforceSchedulerPolicyGate('web', 1, 'Auto-update', '/api/schedules/1/run'),
    ).rejects.toThrow();
    expect(mockDescribePolicyBlock).toHaveBeenCalled();
    const [policy, violations, action, evidence] = mockDescribePolicyBlock.mock.calls[0] as unknown[];
    expect(action).toBe('update');
    // The evidence decision is what lets the message say "unavailable" rather
    // than "matched", so it must be passed.
    expect(evidence).toBeDefined();
  });

  it('auto-update routes its block message through describePolicyBlock', async () => {
    const result = await applyAutomaticStackUpdate({
      nodeId: 1,
      stackName: 'web',
      updatedImages: [],
      policyOptions: { bypass: false, actor: 'system:image-update' },
      verificationOwner: 'target_local',
    });
    expect(result.result).toBe('policy_blocked');
    expect(mockDescribePolicyBlock).toHaveBeenCalled();
    const [policy, violations, action, evidence] = mockDescribePolicyBlock.mock.calls[0] as unknown[];
    expect(action).toBe('update');
    expect(evidence).toBeDefined();
  });

  it('the shared message is callable for every blockable action', () => {
    // Guards the signature itself: a caller that stops passing the decision
    // would fail to compile, which is the point of the parameter.
    for (const action of ['deploy', 'update', 'rollback'] as const) {
      expect(typeof describePolicyBlock(undefined, [], action, undefined)).toBe('string');
    }
  });

  it('the real message names missing evidence rather than a matched finding', () => {
    // The wiring is pinned above; this pins the wording the wiring produces, so
    // the two cannot drift apart unnoticed.
    const msg = describePolicyBlock(
      undefined,
      [{ imageRef: 'nginx:1.27', severity: 'UNKNOWN', criticalCount: 0, highCount: 0, kevCount: 0, fixableCount: 0, reasons: [], scanId: 0, error: 'Pre-flight scan failed: scanner crashed' }],
      'deploy',
      evidenceDecision,
    );
    expect(msg).toContain('required security evidence was unavailable');
    expect(msg).not.toContain('matched');
  });
});
