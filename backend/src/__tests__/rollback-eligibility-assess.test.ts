/**
 * Integration coverage for assessGenerationEligibility: structural services_json
 * refusal and opaque hold-tag presence checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInspectByRef = vi.fn(async (_ref: string) => ({ Id: 'ok' }));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getImage: (ref: string) => ({
          inspect: () => mockInspectByRef(ref),
        }),
      }),
    }),
  },
}));

vi.mock('../services/RollbackGenerationStore', () => ({
  RollbackGenerationStore: {
    verifyGenerationContent: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../services/PolicyEnforcement', () => ({
  enforcePolicyForImageRefs: vi.fn().mockResolvedValue({ ok: true, bypassed: false, violations: [] }),
}));

import { assessGenerationEligibility } from '../services/rollbackEligibility';
import type { StackUpdateRecoveryGenerationRow } from '../services/DatabaseService';

const HOLD_TAG = 'sencho-rb/aaaaaaaaaaaa/web:hold';
const IMAGE_ID = 'sha256:aaa';

function baseRow(over: Partial<StackUpdateRecoveryGenerationRow> = {}): StackUpdateRecoveryGenerationRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    node_id: 1,
    stack_name: 'my-stack',
    status: 'active',
    phase: 'reconciling',
    is_current: 1,
    backup_slot_id: '11111111-1111-4111-8111-111111111111',
    content_path: '11111111-1111-4111-8111-111111111111',
    operation_kind: 'update',
    override_path: null,
    services_json: JSON.stringify([{
      serviceName: 'web',
      scale: 1,
      hasBuild: false,
      declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag',
      replicas: [{
        containerId: 'c1',
        imageId: IMAGE_ID,
        repoDigest: null,
        state: 'running',
        rollbackTag: HOLD_TAG,
      }],
    }]),
    health_gate_id: null,
    gate_retain_until: null,
    artifact_expires_at: null,
    operation_lease_expires_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    created_by: null,
    artifacts_retired: 0,
    released_at: null,
    released_by: null,
    ...over,
  };
}

describe('assessGenerationEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInspectByRef.mockResolvedValue({ Id: 'ok' });
  });

  it('prohibits structurally malformed services_json such as [{}]', async () => {
    await expect(assessGenerationEligibility(baseRow({ services_json: '[{}]' }))).resolves.toBe('prohibited');
  });

  it('returns eligible_with_warning when an opaque hold tag is missing', async () => {
    mockInspectByRef.mockImplementation(async (ref: string) => {
      if (ref === HOLD_TAG) {
        throw Object.assign(new Error('No such image'), { statusCode: 404 });
      }
      return { Id: 'ok' };
    });

    await expect(assessGenerationEligibility(baseRow())).resolves.toBe('eligible_with_warning');
    expect(mockInspectByRef).toHaveBeenCalledWith(IMAGE_ID);
    expect(mockInspectByRef).toHaveBeenCalledWith(HOLD_TAG);
  });

  it('returns eligible when image ids and hold tags both resolve', async () => {
    await expect(assessGenerationEligibility(baseRow())).resolves.toBe('eligible');
  });
});
