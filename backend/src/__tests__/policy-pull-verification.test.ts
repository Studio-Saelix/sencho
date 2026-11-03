/**
 * Post-pull verification: the image that landed must be the image that was
 * proven.
 *
 * A tag can move between the gate and the pull. The pulled image is local by
 * then and not yet running, so it is re-evaluated as an installed image, and a
 * refusal stops the update with the previous containers intact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const INDEX = `sha256:${'a'.repeat(64)}`;
const PLATFORM_DIGEST = `sha256:${'b'.repeat(64)}`;
const MOVED = `sha256:${'c'.repeat(64)}`;

const enforcement = vi.hoisted(() => ({
  enforcePolicyForImageRefs: vi.fn(),
  enforcePolicyPreDeploy: vi.fn(),
  evaluateRemoteCandidateSupport: vi.fn(),
}));
const docker = vi.hoisted(() => ({ repoDigests: [] as string[] }));

vi.mock('../services/PolicyEnforcement', async () => {
  const actual = await vi.importActual<typeof import('../services/PolicyEnforcement')>('../services/PolicyEnforcement');
  return { ...actual, ...enforcement };
});
vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getImage: () => ({ inspect: async () => ({ RepoDigests: docker.repoDigests }) }),
      }),
    }),
  },
}));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({ getMatchingPolicy: vi.fn(), insertAuditLog: vi.fn(), getGlobalSettings: vi.fn() }),
  },
}));

import { PulledCandidateBlockedError, verifyPulledCandidates } from '../helpers/policyGate';

const CANDIDATES = [{
  ref: 'registry.example.com/web:latest',
  indexDigest: INDEX,
  platformDigest: PLATFORM_DIGEST,
}];
const OPTIONS = { bypass: false, actor: 'u' };

beforeEach(() => {
  vi.clearAllMocks();
  docker.repoDigests = [`registry.example.com/web@${INDEX}`];
});

describe('verifyPulledCandidates', () => {
  it('accepts the pulled image when it matches the evaluated digest', async () => {
    await verifyPulledCandidates('web', 1, CANDIDATES, OPTIONS);
    expect(enforcement.enforcePolicyForImageRefs).not.toHaveBeenCalled();
  });

  it('accepts the platform child as a match too, because that is the manifest that ran', async () => {
    docker.repoDigests = [`registry.example.com/web@${PLATFORM_DIGEST}`];
    await verifyPulledCandidates('web', 1, CANDIDATES, OPTIONS);
    expect(enforcement.enforcePolicyForImageRefs).not.toHaveBeenCalled();
  });

  it('re-evaluates the pulled image when the tag moved, and stops on a block', async () => {
    docker.repoDigests = [`registry.example.com/web@${MOVED}`];
    enforcement.enforcePolicyForImageRefs.mockResolvedValue({
      ok: false,
      bypassed: false,
      policy: { name: 'prod-gate' },
      violations: [{ imageRef: 'registry.example.com/web:latest', severity: 'CRITICAL', criticalCount: 1, highCount: 0, kevCount: 0, fixableCount: 0, reasons: ['severity'], scanId: 9 }],
      evidence: { outcome: 'block', records: [], applications: [], summary: 'Proven by severity' },
    });

    await expect(verifyPulledCandidates('web', 1, CANDIDATES, OPTIONS))
      .rejects.toBeInstanceOf(PulledCandidateBlockedError);
    expect(enforcement.enforcePolicyForImageRefs).toHaveBeenCalledWith(
      'web', 1, ['registry.example.com/web:latest'],
      // The pulled image is installed by then, so it is evaluated as one.
      expect.objectContaining({ imageSource: 'installed' }),
    );
  });

  it('lets the re-gate through when an admin bypass is in play', async () => {
    docker.repoDigests = [`registry.example.com/web@${MOVED}`];
    enforcement.enforcePolicyForImageRefs.mockResolvedValue({
      ok: true, bypassed: true, violations: [], policy: { name: 'prod-gate' },
    });
    await expect(verifyPulledCandidates('web', 1, CANDIDATES, { ...OPTIONS, bypass: true }))
      .resolves.toBeUndefined();
  });

  it('keeps candidate semantics on an unattended re-gate', async () => {
    docker.repoDigests = [`registry.example.com/web@${MOVED}`];
    enforcement.enforcePolicyForImageRefs.mockResolvedValue({ ok: true, bypassed: false, violations: [] });

    await verifyPulledCandidates('web', 1, CANDIDATES, { ...OPTIONS, unattended: true, imageSource: 'registry' });

    expect(enforcement.enforcePolicyForImageRefs).toHaveBeenCalledWith(
      'web', 1, ['registry.example.com/web:latest'],
      expect.objectContaining({
        unattended: true,
        imageSource: 'installed',
        // Without this the unattended rule would be swapped for the attended one
        // and a scanner outage could let the moved image through.
        pulledCandidate: true,
      }),
    );
  });

  it('treats an image that is not on the node after the pull as moved', async () => {
    docker.repoDigests = [];
    enforcement.enforcePolicyForImageRefs.mockResolvedValue({
      ok: true, bypassed: false, violations: [],
    });
    await verifyPulledCandidates('web', 1, CANDIDATES, OPTIONS);
    expect(enforcement.enforcePolicyForImageRefs).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the gate evaluated no candidate', async () => {
    await verifyPulledCandidates('web', 1, undefined, OPTIONS);
    expect(enforcement.enforcePolicyForImageRefs).not.toHaveBeenCalled();
  });
});
