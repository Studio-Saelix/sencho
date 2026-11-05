/**
 * Mixed fleet: a hub-driven unattended update to a node whose build evaluates the
 * installed image instead of the image an update would pull.
 *
 * The decision belongs on the hub, because the hub holds the policy and the
 * target cannot see the candidate at all. Both remote node kinds take the same
 * path: `probeRemoteCapability` serves a proxy node and a Pilot node alike.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const probe = vi.hoisted(() => ({ probeRemoteCapability: vi.fn() }));
/** The matching-policy answer, and the rule the settings resolve to. */
const state = vi.hoisted(() => ({
  policy: null as null | Record<string, unknown>,
  settings: {} as Record<string, string>,
}));

vi.mock('../helpers/remoteCapabilities', () => ({ probeRemoteCapability: probe.probeRemoteCapability }));
vi.mock('../services/NotificationService', () => ({
  NotificationService: { getInstance: () => ({ dispatchAlert: vi.fn(), broadcastEvent: vi.fn() }) },
}));
vi.mock('../services/FleetSyncService', () => ({ FleetSyncService: { getSelfIdentity: () => 'self-node' } }));
vi.mock('../services/ComposeService', () => ({ ComposeService: { getInstance: () => ({}) } }));
vi.mock('../services/TrivyService', () => ({
  default: { getInstance: () => ({ isTrivyAvailable: () => true }), DIGEST_CACHE_TTL_MS: 1 },
}));
vi.mock('../services/registry-api', () => ({ parseImageRef: vi.fn(), selectLocalRepoDigests: vi.fn() }));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getMatchingPolicy: () => state.policy,
      getGlobalSettings: () => state.settings,
      insertAuditLog: vi.fn(),
    }),
  },
}));

import { remoteCandidateGateRefusal } from '../helpers/policyGate';
import { CAPABILITIES, CANDIDATE_IMAGE_GATE_CAPABILITY } from '../services/CapabilityRegistry';

const BLOCKING_POLICY = {
  id: 1,
  name: 'prod-gate',
  enabled: 1,
  block_on_deploy: 1,
  max_severity: 'HIGH',
  block_on_severity: 1,
  block_on_kev: 0,
  block_on_fixable: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.policy = BLOCKING_POLICY;
  state.settings = { security_candidate_unproven: 'block' };
});

describe.each(['proxy', 'pilot'])('%s node', () => {
  it('probes the candidate-image capability before forwarding', async () => {
    probe.probeRemoteCapability.mockResolvedValue({ kind: 'supported' });
    await expect(remoteCandidateGateRefusal(2, 'web', { bypass: false, actor: 'system:scheduler' }))
      .resolves.toBeNull();
    expect(probe.probeRemoteCapability).toHaveBeenCalledWith(2, CANDIDATE_IMAGE_GATE_CAPABILITY);
  });

  it('holds the update when the node cannot evaluate a candidate and a blocking policy matches', async () => {
    probe.probeRemoteCapability.mockResolvedValue({ kind: 'unsupported' });
    const refusal = await remoteCandidateGateRefusal(2, 'web', { bypass: false, actor: 'system:scheduler' });
    expect(refusal).toContain('prod-gate');
    expect(refusal).toContain('checks the image already installed');
  });

  it('proceeds when no policy matches the stack on that node', async () => {
    probe.probeRemoteCapability.mockResolvedValue({ kind: 'unsupported' });
    state.policy = null;
    await expect(remoteCandidateGateRefusal(2, 'web', { bypass: false, actor: 'system:scheduler' }))
      .resolves.toBeNull();
  });

  it('proceeds when the matching policy is not a block-on-deploy policy', async () => {
    probe.probeRemoteCapability.mockResolvedValue({ kind: 'unsupported' });
    state.policy = { ...BLOCKING_POLICY, block_on_deploy: 0 };
    await expect(remoteCandidateGateRefusal(2, 'web', { bypass: false, actor: 'system:scheduler' }))
      .resolves.toBeNull();
  });

  it('proceeds when Candidate not evaluated is set to allow', async () => {
    probe.probeRemoteCapability.mockResolvedValue({ kind: 'unsupported' });
    state.settings = { security_candidate_unproven: 'allow' };
    await expect(remoteCandidateGateRefusal(2, 'web', { bypass: false, actor: 'system:scheduler' }))
      .resolves.toBeNull();
  });

  it('leaves an unreachable node to the forward attempt, which already fails on its own', async () => {
    probe.probeRemoteCapability.mockResolvedValue({ kind: 'unreachable', detail: 'transport_failure' });
    await expect(remoteCandidateGateRefusal(2, 'web', { bypass: false, actor: 'system:scheduler' }))
      .resolves.toBeNull();
  });
});

describe('capability advertisement', () => {
  it('is advertised by this build, so a hub can decide who can see a candidate', () => {
    expect(CANDIDATE_IMAGE_GATE_CAPABILITY).toBe('candidate-image-gate-v1');
    expect(CAPABILITIES).toContain('candidate-image-gate-v1');
  });
});
