/**
 * Unit tests for FleetSyncService: the service that replicates security
 * configuration from a control Sencho instance to every registered remote.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetNodes,
  mockGetNode,
  mockGetLocalScanPolicies,
  mockGetLocalCveSuppressions,
  mockReplaceReplicatedScanPolicies,
  mockReplaceReplicatedCveSuppressions,
  mockClearOrphanPolicyEvaluations,
  mockClearReplicatedRows,
  mockInsertAuditLog,
  mockRecordFleetSyncSuccess,
  mockRecordFleetSyncFailure,
  mockSetFleetSyncSticky,
  mockGetFleetSyncStickyCode,
  mockGetSystemState,
  mockSetSystemState,
  mockTransaction,
  mockDispatchAlert,
  mockAxiosPost,
} = vi.hoisted(() => ({
  mockGetNodes: vi.fn().mockReturnValue([]),
  mockGetNode: vi.fn(),
  mockGetLocalScanPolicies: vi.fn().mockReturnValue([]),
  mockGetLocalCveSuppressions: vi.fn().mockReturnValue([]),
  mockReplaceReplicatedScanPolicies: vi.fn(),
  mockReplaceReplicatedCveSuppressions: vi.fn(),
  mockClearOrphanPolicyEvaluations: vi.fn(),
  mockClearReplicatedRows: vi.fn(),
  mockInsertAuditLog: vi.fn(),
  mockRecordFleetSyncSuccess: vi.fn(),
  mockRecordFleetSyncFailure: vi.fn(),
  mockSetFleetSyncSticky: vi.fn(),
  mockGetFleetSyncStickyCode: vi.fn().mockReturnValue(null),
  mockGetSystemState: vi.fn().mockReturnValue(null),
  mockSetSystemState: vi.fn(),
  mockTransaction: vi.fn().mockImplementation((fn: () => unknown) => fn()),
  mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
  mockAxiosPost: vi.fn().mockResolvedValue({ data: { success: true } }),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getNodes: mockGetNodes,
      getLocalScanPolicies: mockGetLocalScanPolicies,
      getLocalCveSuppressions: mockGetLocalCveSuppressions,
      replaceReplicatedScanPolicies: mockReplaceReplicatedScanPolicies,
      replaceReplicatedCveSuppressions: mockReplaceReplicatedCveSuppressions,
      clearOrphanPolicyEvaluations: mockClearOrphanPolicyEvaluations,
      clearReplicatedRows: mockClearReplicatedRows,
      insertAuditLog: mockInsertAuditLog,
      recordFleetSyncSuccess: mockRecordFleetSyncSuccess,
      recordFleetSyncFailure: mockRecordFleetSyncFailure,
      setFleetSyncSticky: mockSetFleetSyncSticky,
      getFleetSyncStickyCode: mockGetFleetSyncStickyCode,
      getSystemState: mockGetSystemState,
      setSystemState: mockSetSystemState,
      transaction: mockTransaction,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getNode: mockGetNode,
    }),
  },
}));

vi.mock('../services/NotificationService', () => ({
  NotificationService: {
    getInstance: () => ({ dispatchAlert: mockDispatchAlert }),
  },
}));

vi.mock('../utils/debug', () => ({
  isDebugEnabled: () => false,
}));

vi.mock('axios', () => ({
  default: { post: mockAxiosPost },
  AxiosError: class AxiosError extends Error {
    response?: { status: number; statusText: string; data: unknown };
  },
}));

import { FleetSyncService, LOCAL_IDENTITY_SENTINEL } from '../services/FleetSyncService';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemState.mockReturnValue(null);
  mockGetFleetSyncStickyCode.mockReturnValue(null);
});

describe('FleetSyncService.getRole', () => {
  it('returns control when no fleet_role is set in system_state', () => {
    mockGetSystemState.mockReturnValue(null);
    expect(FleetSyncService.getRole()).toBe('control');
  });

  it('returns replica when fleet_role system_state is "replica"', () => {
    mockGetSystemState.mockImplementation((key: string) => (key === 'fleet_role' ? 'replica' : null));
    expect(FleetSyncService.getRole()).toBe('replica');
  });
});

describe('FleetSyncService.getSelfIdentity', () => {
  it('returns LOCAL_IDENTITY_SENTINEL on control nodes', () => {
    mockGetSystemState.mockReturnValue(null);
    expect(FleetSyncService.getSelfIdentity()).toBe(LOCAL_IDENTITY_SENTINEL);
  });

  it('returns the cached target identity on replicas', () => {
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_role') return 'replica';
      if (key === 'fleet_self_identity') return 'https://sencho.example.com';
      return null;
    });
    expect(FleetSyncService.getSelfIdentity()).toBe('https://sencho.example.com');
  });
});

describe('FleetSyncService.resolveIdentityForNodeId', () => {
  it('returns empty string when nodeId is null (fleet-wide policy)', () => {
    expect(FleetSyncService.resolveIdentityForNodeId(null)).toBe('');
  });

  it('returns LOCAL_IDENTITY_SENTINEL when the node is local', () => {
    mockGetNode.mockReturnValue({ id: 1, type: 'local', api_url: '', api_token: '' });
    expect(FleetSyncService.resolveIdentityForNodeId(1)).toBe(LOCAL_IDENTITY_SENTINEL);
  });

  it('returns the remote api_url for remote nodes', () => {
    mockGetNode.mockReturnValue({ id: 2, type: 'remote', api_url: 'https://remote.example.com', api_token: 'tok' });
    expect(FleetSyncService.resolveIdentityForNodeId(2)).toBe('https://remote.example.com');
  });
});

describe('FleetSyncService.pushResource', () => {
  it('does not push when this instance is a replica', async () => {
    mockGetSystemState.mockImplementation((key: string) => (key === 'fleet_role' ? 'replica' : null));
    await FleetSyncService.getInstance().pushResource('scan_policies');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('skips nodes without api_url or api_token', async () => {
    mockGetNodes.mockReturnValue([
      { id: 1, type: 'local', api_url: '', api_token: '' },
      { id: 2, type: 'remote', api_url: '', api_token: 'tok' },
      { id: 3, type: 'remote', api_url: 'https://good.example', api_token: '' },
    ]);
    await FleetSyncService.getInstance().pushResource('scan_policies');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('pushes to every configured remote with local rows only', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://a.example', api_token: 'tokA', name: 'A' },
      { id: 3, type: 'remote', api_url: 'https://b.example', api_token: 'tokB', name: 'B' },
    ]);
    // getLocalScanPolicies() filters out replicated rows at SQL time.
    mockGetLocalScanPolicies.mockReturnValue([
      { id: 1, name: 'local-1', node_identity: '', replicated_from_control: 0, created_at: 1, updated_at: 1 },
    ]);
    await FleetSyncService.getInstance().pushResource('scan_policies');

    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    const firstCall = mockAxiosPost.mock.calls[0];
    expect(firstCall[0]).toBe('https://a.example/api/fleet/sync/scan_policies');
    expect(firstCall[1].rows).toHaveLength(1);
    expect(firstCall[1].rows[0].name).toBe('local-1');
    expect(firstCall[1].targetIdentity).toBe('https://a.example');
    expect(firstCall[2].headers.Authorization).toBe('Bearer tokA');
    expect(mockRecordFleetSyncSuccess).toHaveBeenCalledWith(2, 'scan_policies');
    expect(mockRecordFleetSyncSuccess).toHaveBeenCalledWith(3, 'scan_policies');
  });

  it('records per-node failure without throwing when one remote errors', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://fail.example', api_token: 'tok', name: 'fail' },
      { id: 3, type: 'remote', api_url: 'https://ok.example', api_token: 'tok2', name: 'ok' },
    ]);
    mockAxiosPost.mockImplementation((url: string) => {
      if (url.includes('fail.example')) return Promise.reject(new Error('network error'));
      return Promise.resolve({ data: { success: true } });
    });
    await expect(FleetSyncService.getInstance().pushResource('scan_policies')).resolves.not.toThrow();
    expect(mockRecordFleetSyncFailure).toHaveBeenCalledWith(2, 'scan_policies', expect.stringContaining('network error'));
    expect(mockRecordFleetSyncSuccess).toHaveBeenCalledWith(3, 'scan_policies');
  });
});

describe('FleetSyncService.applyIncomingSync', () => {
  it('promotes this instance to replica and caches target identity', () => {
    const rows = [{
      id: 0, name: 'from-control', node_id: null, node_identity: '',
      stack_pattern: null, max_severity: 'CRITICAL' as const,
      block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0, enabled: 1, replicated_from_control: 1,
      created_at: 1, updated_at: 1,
    }];
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', rows, 'https://me.example');
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_role', 'replica');
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_self_identity', 'https://me.example');
    expect(mockReplaceReplicatedScanPolicies).toHaveBeenCalledWith(rows);
  });

  it('skips identity caching when targetIdentity is empty', () => {
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [], '');
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_role', 'replica');
    expect(mockSetSystemState).not.toHaveBeenCalledWith('fleet_self_identity', expect.anything());
  });
});

describe('FleetSyncService payload schema', () => {
  it('includes pushedAt and controlIdentity in every push body', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://a.example', api_token: 'tokA', name: 'A' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([
      { id: 1, name: 'one', node_identity: '', replicated_from_control: 0, created_at: 1, updated_at: 1 },
    ]);
    await FleetSyncService.getInstance().pushResource('scan_policies');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(typeof body.pushedAt).toBe('number');
    expect(body.pushedAt).toBeGreaterThan(0);
    expect(body).toHaveProperty('controlIdentity');
    expect(typeof body.controlIdentity).toBe('string');
  });

  it('emits strictly increasing pushedAt across consecutive pushes', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://a.example', api_token: 'tokA', name: 'A' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    await FleetSyncService.getInstance().pushResource('scan_policies');
    await FleetSyncService.getInstance().pushResource('scan_policies');
    await FleetSyncService.getInstance().pushResource('scan_policies');
    const stamps = mockAxiosPost.mock.calls.map((c) => c[1].pushedAt);
    expect(stamps).toHaveLength(3);
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
    expect(stamps[2]).toBeGreaterThan(stamps[1]);
  });
});

describe('FleetSyncService per-node push serialization', () => {
  it('serializes pushes to the same node so a second push waits for the first', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://a.example', api_token: 'tokA', name: 'A' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);

    let resolveFirst: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolveStart) => {
      mockAxiosPost.mockImplementationOnce(() => {
        resolveStart();
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ data: { success: true } });
        });
      });
    });
    mockAxiosPost.mockImplementationOnce(() => Promise.resolve({ data: { success: true } }));

    const first = FleetSyncService.getInstance().pushResource('scan_policies');
    await firstStarted;

    const second = FleetSyncService.getInstance().pushResource('scan_policies');
    // After awaiting a tick, only the first push should have hit axios.
    await Promise.resolve();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await Promise.all([first, second]);
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
  });
});

describe('FleetSyncService row cap', () => {
  it('truncates to MAX_SYNC_ROWS and emits a warning notification', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://a.example', api_token: 'tokA', name: 'A' },
    ]);
    const huge = Array.from({ length: 5005 }, (_, i) => ({
      id: i + 1,
      name: `p${i}`,
      node_identity: '',
      replicated_from_control: 0,
      created_at: 1,
      updated_at: 1,
    }));
    mockGetLocalScanPolicies.mockReturnValue(huge);
    await FleetSyncService.getInstance().pushResource('scan_policies');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.rows).toHaveLength(5000);
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'warning',
      'system',
      expect.stringContaining('truncated'),
    );
  });

  it('throttles repeat truncation alerts via fleet_sync_truncation_alert_at watermark', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://a.example', api_token: 'tokA', name: 'A' },
    ]);
    const huge = Array.from({ length: 5005 }, (_, i) => ({
      id: i + 1,
      name: `p${i}`,
      node_identity: '',
      replicated_from_control: 0,
      created_at: 1,
      updated_at: 1,
    }));
    mockGetLocalScanPolicies.mockReturnValue(huge);
    // Simulate that an alert was emitted 1 minute ago (well within the cooldown).
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_sync_truncation_alert_at:scan_policies') return String(Date.now() - 60_000);
      return null;
    });
    await FleetSyncService.getInstance().pushResource('scan_policies');
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });
});

describe('FleetSyncService stale-push handling', () => {
  it('does not record a fleet sync failure for STALE_SYNC_PUSH 409 responses', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://stale.example', api_token: 'tok', name: 'stale' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    mockAxiosPost.mockImplementation(async () => {
      const { AxiosError } = await import('axios');
      const err = new AxiosError('Request failed with status code 409');
      (err as unknown as { response: unknown }).response = {
        status: 409,
        statusText: 'Conflict',
        data: { error: 'stale', code: 'STALE_SYNC_PUSH' },
      };
      throw err;
    });
    await FleetSyncService.getInstance().pushResource('scan_policies');
    expect(mockRecordFleetSyncFailure).not.toHaveBeenCalled();
    expect(mockRecordFleetSyncSuccess).not.toHaveBeenCalled();
  });

  it('still records fleet sync failure for non-STALE 409 responses', async () => {
    mockGetNodes.mockReturnValue([
      { id: 2, type: 'remote', api_url: 'https://other.example', api_token: 'tok', name: 'other' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    mockAxiosPost.mockImplementation(async () => {
      const { AxiosError } = await import('axios');
      const err = new AxiosError('Request failed with status code 409');
      (err as unknown as { response: unknown }).response = {
        status: 409,
        statusText: 'Conflict',
        data: { error: 'something else', code: 'CONTROL_IDENTITY_MISMATCH' },
      };
      throw err;
    });
    await FleetSyncService.getInstance().pushResource('scan_policies');
    expect(mockRecordFleetSyncFailure).toHaveBeenCalled();
  });
});

describe('FleetSyncService.applyIncomingSync transactional', () => {
  it('runs inside DatabaseService.transaction so apply and watermark commit atomically', () => {
    FleetSyncService.getInstance().applyIncomingSync(
      'scan_policies',
      [],
      'https://me.example',
      1_700_000_000_000,
    );
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_role', 'replica');
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_self_identity', 'https://me.example');
    expect(mockSetSystemState).toHaveBeenCalledWith('received_pushed_at:scan_policies', '1700000000000');
  });

  it('omits the watermark write when pushedAt is undefined (legacy back-compat)', () => {
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [], 'https://me.example');
    const watermarkWrites = mockSetSystemState.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('received_pushed_at:'),
    );
    expect(watermarkWrites).toHaveLength(0);
  });
});

/** Reset the static fingerprint cache between tests; the static field is private. */
function resetControlIdentityCache(): void {
  (FleetSyncService as unknown as { cachedControlIdentity: string | null }).cachedControlIdentity = null;
}

describe('FleetSyncService control anchor', () => {
  it('persists controlIdentity on first sync (no cached fingerprint)', () => {
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_control_identity') return null;
      return null;
    });
    FleetSyncService.getInstance().applyIncomingSync(
      'scan_policies',
      [],
      'https://me.example',
      undefined,
      'fingerprint-aaa',
    );
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_control_identity', 'fingerprint-aaa');
  });

  it('rejects with ControlIdentityMismatchError when cached fingerprint differs', async () => {
    const { ControlIdentityMismatchError } = await import('../services/FleetSyncService');
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_control_identity') return 'fingerprint-original';
      return null;
    });
    expect(() => {
      FleetSyncService.getInstance().applyIncomingSync(
        'scan_policies',
        [],
        'https://me.example',
        undefined,
        'fingerprint-different',
      );
    }).toThrow(ControlIdentityMismatchError);
  });

  it('accepts subsequent push when controlIdentity matches the cached fingerprint', () => {
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_control_identity') return 'fingerprint-aaa';
      return null;
    });
    expect(() => {
      FleetSyncService.getInstance().applyIncomingSync(
        'scan_policies',
        [],
        'https://me.example',
        undefined,
        'fingerprint-aaa',
      );
    }).not.toThrow();
    // Cached identity is not re-written when matching to avoid noisy churn.
    const writes = mockSetSystemState.mock.calls.filter((c) => c[0] === 'fleet_control_identity');
    expect(writes).toHaveLength(0);
  });

  it('treats empty incoming controlIdentity as legacy and accepts (back-compat)', () => {
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_control_identity') return 'fingerprint-aaa';
      return null;
    });
    expect(() => {
      FleetSyncService.getInstance().applyIncomingSync(
        'scan_policies',
        [],
        'https://me.example',
        undefined,
        '',
      );
    }).not.toThrow();
  });

  it('treats empty cached fingerprint (post-reanchor) as un-anchored', () => {
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_control_identity') return '';
      return null;
    });
    expect(() => {
      FleetSyncService.getInstance().applyIncomingSync(
        'scan_policies',
        [],
        'https://me.example',
        undefined,
        'fingerprint-new-control',
      );
    }).not.toThrow();
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_control_identity', 'fingerprint-new-control');
  });
});

describe('FleetSyncService.reanchor', () => {
  it('clears cached fingerprint, watermarks, and replicated rows in one transaction', () => {
    FleetSyncService.getInstance().reanchor();
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockSetSystemState).toHaveBeenCalledWith('fleet_control_identity', '');
    expect(mockSetSystemState).toHaveBeenCalledWith('received_pushed_at:scan_policies', '');
    expect(mockSetSystemState).toHaveBeenCalledWith('received_pushed_at:cve_suppressions', '');
    expect(mockClearReplicatedRows).toHaveBeenCalled();
  });
});

describe('FleetSyncService.getControlIdentity', () => {
  it('returns a stable 16-hex-char fingerprint derived from instance_id', () => {
    mockGetSystemState.mockImplementation((key: string) => (key === 'instance_id' ? 'uuid-abc-def' : null));
    resetControlIdentityCache();
    const fp1 = FleetSyncService.getControlIdentity();
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
    resetControlIdentityCache();
    const fp2 = FleetSyncService.getControlIdentity();
    expect(fp2).toBe(fp1);
  });

  it('returns empty string when instance_id is missing', () => {
    resetControlIdentityCache();
    mockGetSystemState.mockImplementation(() => null);
    expect(FleetSyncService.getControlIdentity()).toBe('');
  });
});

describe('FleetSyncService incoming-sync side effects', () => {
  it('writes a system audit log entry on every applied sync', () => {
    FleetSyncService.getInstance().applyIncomingSync(
      'scan_policies',
      [],
      'https://me.example',
      1_700_000_000_000,
      'fingerprint-aaa',
    );
    expect(mockInsertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      username: 'system',
      method: 'POST',
      path: '/api/fleet/sync/scan_policies',
      ip_address: 'control',
      summary: expect.stringContaining('Replicated scan_policies from fingerprint-aaa'),
    }));
  });

  it('emits an identity-drift notification when the targetIdentity changes', () => {
    mockGetSystemState.mockImplementation((key: string) => {
      if (key === 'fleet_self_identity') return 'https://old.example';
      return null;
    });
    FleetSyncService.getInstance().applyIncomingSync(
      'scan_policies',
      [],
      'https://new.example',
    );
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'warning',
      'system',
      expect.stringContaining('Fleet self-identity changed'),
    );
  });

  it('does not emit identity-drift when there is no prior identity (first sync)', () => {
    mockGetSystemState.mockImplementation(() => null);
    FleetSyncService.getInstance().applyIncomingSync(
      'scan_policies',
      [],
      'https://first.example',
    );
    const driftCalls = mockDispatchAlert.mock.calls.filter((c) =>
      typeof c[2] === 'string' && c[2].includes('self-identity changed'),
    );
    expect(driftCalls).toHaveLength(0);
  });
});

describe('FleetSyncService.pushResource pilot-agent skip', () => {
  it('skips pilot-agent nodes and logs warn-once per node id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetNodes.mockReturnValue([
      { id: 50, type: 'remote', mode: 'pilot_agent', api_url: '', api_token: '', name: 'PilotNode' },
    ]);
    await FleetSyncService.getInstance().pushResource('scan_policies');
    await FleetSyncService.getInstance().pushResource('scan_policies');
    const pilotWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('pilot-agent') && c[0].includes('PilotNode'),
    );
    expect(pilotWarns).toHaveLength(1);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('FleetSyncService.formatError redaction', () => {
  it('redacts Bearer tokens and JWT-shaped values from error messages', async () => {
    mockGetNodes.mockReturnValue([
      { id: 51, type: 'remote', api_url: 'https://leak.example', api_token: 'tok', name: 'leak' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    mockAxiosPost.mockImplementation(async () => {
      const { AxiosError } = await import('axios');
      const err = new AxiosError('Request failed');
      (err as unknown as { response: unknown }).response = {
        status: 500,
        statusText: 'Server Error',
        data: { error: 'Authorization: Bearer abc.def-_~+/=secrettoken denied; jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturePart' },
      };
      throw err;
    });
    await FleetSyncService.getInstance().pushResource('scan_policies');
    const failure = mockRecordFleetSyncFailure.mock.calls[0];
    expect(failure[2]).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(failure[2]).toContain('[redacted]');
    expect(failure[2]).toContain('[redacted-jwt]');
  });
});

describe('FleetSyncService CONTROL_IDENTITY_MISMATCH sticky handling', () => {
  function makeMismatchError(expected: string, got: string) {
    return async () => {
      const { AxiosError } = await import('axios');
      const err = new AxiosError('Request failed with status code 409');
      (err as unknown as { response: unknown }).response = {
        status: 409,
        statusText: 'Conflict',
        data: {
          error: `Control identity mismatch: replica is anchored to "${expected}", push from "${got}"`,
          code: 'CONTROL_IDENTITY_MISMATCH',
          expected,
          got,
        },
      };
      throw err;
    };
  }

  it('sets the sticky flag carrying the expected/got fingerprints on first mismatch', async () => {
    mockGetNodes.mockReturnValue([
      { id: 7, type: 'remote', api_url: 'https://peer.example', api_token: 'tok', name: 'peer', mode: 'proxy' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    mockGetFleetSyncStickyCode.mockReturnValue(null);
    mockAxiosPost.mockImplementation(makeMismatchError('cb45a2eff9db81d8', '555f8d1f7e7e71e3'));

    await FleetSyncService.getInstance().pushResource('scan_policies');

    expect(mockRecordFleetSyncFailure).toHaveBeenCalledTimes(1);
    expect(mockSetFleetSyncSticky).toHaveBeenCalledTimes(1);
    expect(mockSetFleetSyncSticky).toHaveBeenCalledWith(
      7,
      'scan_policies',
      'CONTROL_IDENTITY_MISMATCH',
      'cb45a2eff9db81d8',
      '555f8d1f7e7e71e3',
    );
  });

  it('short-circuits subsequent pushes when sticky is already set; no HTTP call, no failure record', async () => {
    mockGetNodes.mockReturnValue([
      { id: 7, type: 'remote', api_url: 'https://peer.example', api_token: 'tok', name: 'peer', mode: 'proxy' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    // Sticky already set from a prior push.
    mockGetFleetSyncStickyCode.mockReturnValue('CONTROL_IDENTITY_MISMATCH');

    await FleetSyncService.getInstance().pushResource('scan_policies');

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockRecordFleetSyncFailure).not.toHaveBeenCalled();
    expect(mockRecordFleetSyncSuccess).not.toHaveBeenCalled();
    expect(mockSetFleetSyncSticky).not.toHaveBeenCalled();
  });

  it('tolerates a missing expected/got payload (passes null through)', async () => {
    mockGetNodes.mockReturnValue([
      { id: 7, type: 'remote', api_url: 'https://peer.example', api_token: 'tok', name: 'peer', mode: 'proxy' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    mockGetFleetSyncStickyCode.mockReturnValue(null);
    mockAxiosPost.mockImplementation(async () => {
      const { AxiosError } = await import('axios');
      const err = new AxiosError('Request failed with status code 409');
      (err as unknown as { response: unknown }).response = {
        status: 409,
        statusText: 'Conflict',
        data: { error: 'mismatch', code: 'CONTROL_IDENTITY_MISMATCH' },
      };
      throw err;
    });

    await FleetSyncService.getInstance().pushResource('scan_policies');

    expect(mockSetFleetSyncSticky).toHaveBeenCalledWith(
      7,
      'scan_policies',
      'CONTROL_IDENTITY_MISMATCH',
      null,
      null,
    );
  });

  it('does not set sticky for non-mismatch failures (network errors, 500s)', async () => {
    mockGetNodes.mockReturnValue([
      { id: 7, type: 'remote', api_url: 'https://peer.example', api_token: 'tok', name: 'peer', mode: 'proxy' },
    ]);
    mockGetLocalScanPolicies.mockReturnValue([]);
    mockGetFleetSyncStickyCode.mockReturnValue(null);
    mockAxiosPost.mockRejectedValue(new Error('ECONNREFUSED'));

    await FleetSyncService.getInstance().pushResource('scan_policies');

    expect(mockRecordFleetSyncFailure).toHaveBeenCalledTimes(1);
    expect(mockSetFleetSyncSticky).not.toHaveBeenCalled();
  });
});
