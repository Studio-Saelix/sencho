/**
 * Doctor networking findings adapter: reads ONLY cached Compose Doctor reports
 * (never triggers a fresh preflight run), merges overlapping findings into the
 * matching live card, and surfaces Doctor-only rules as standalone findings.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ComposeDoctorService } from '../services/ComposeDoctorService';
import { applyDoctorNetworkingFindings } from '../services/network/doctorNetworkingFindings';
import type { NetworkingFinding } from '../services/network/networkingTypes';
import type { StackNetworkFacts } from '../services/network/types';
import type { PreflightReport } from '../services/preflight/types';

function stubReport(overrides: Partial<PreflightReport> & { findings: PreflightReport['findings'] }): PreflightReport {
  return {
    stack: 'stack1',
    ranAt: Date.now(),
    ranBy: 'admin',
    renderable: true,
    renderError: null,
    status: 'high',
    highestSeverity: 'high',
    sourceHash: 'h', renderedHash: 'h',
    activeStatus: 'high', activeHighestSeverity: 'high', activeCount: overrides.findings.length, acknowledgedCount: 0,
    ...overrides,
  };
}

function stubFacts(overrides: Partial<StackNetworkFacts> = {}): StackNetworkFacts {
  return {
    stack: 'stack1',
    renderable: true,
    renderError: null,
    runtime: 'available',
    networks: [],
    services: [{ name: 'web', networks: [], publishedPorts: [], extraHosts: [] }],
    drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] },
    missingExternalNetworks: [],
    ...overrides,
  };
}

function liveHostFinding(stack: string, service: string): NetworkingFinding {
  return {
    id: 'live-host-1',
    kind: 'network-mode-host',
    severity: 'medium',
    title: 'Host network mode',
    message: `Service "${service}" uses network_mode: host.`,
    stack,
    service,
    evidence: [],
    recommendedActions: [{ kind: 'open-stack-networking', label: 'Open stack networking', stack }],
    sources: ['live'],
    doctorFindings: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyDoctorNetworkingFindings', () => {
  it('never calls runPreflight; reads only getLatest', () => {
    const getLatest = vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({ stack: 'stack1', findings: [] })),
    } as unknown as ComposeDoctorService);

    applyDoctorNetworkingFindings([], { nodeId: 1, stackNames: ['stack1'], stackFacts: [stubFacts()], snapshot: null });

    expect(getLatest).toHaveBeenCalled();
    const instance = getLatest.mock.results[0].value as { getLatest: unknown; runPreflight?: unknown };
    expect(instance.runPreflight).toBeUndefined();
  });

  it('merges a Doctor host-mode finding into the matching live card instead of duplicating it', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({
        stack: 'stack1',
        findings: [{
          ruleId: 'network-mode-host', severity: 'high', title: 'Host mode', message: 'uses host networking',
          service: 'web', sourcePath: 'services.web.network_mode',
        }],
      })),
    } as unknown as ComposeDoctorService);

    const live = [liveHostFinding('stack1', 'web')];
    const result = applyDoctorNetworkingFindings(live, {
      nodeId: 1, stackNames: ['stack1'], stackFacts: [stubFacts()], snapshot: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0].sources).toEqual(['live', 'doctor']);
    expect(result[0].doctorFindings).toHaveLength(1);
    expect(result[0].severity).toBe('medium'); // canonical severity stays the live one
    expect(result[0].doctorFindings[0].severity).toBe('high'); // Doctor's own severity is preserved
    expect(result[0].recommendedActions.some((a) => a.kind === 'open-stack-doctor')).toBe(true);
  });

  it('surfaces a Doctor-only rule (no live counterpart) as a standalone finding', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({
        stack: 'stack1',
        findings: [{
          ruleId: 'sensitive-service-broad-exposure', severity: 'high',
          title: 'Sensitive service broadly exposed', message: 'db is broadly exposed', service: 'db',
        }],
      })),
    } as unknown as ComposeDoctorService);

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['stack1'],
      stackFacts: [stubFacts({ services: [{ name: 'db', networks: [], publishedPorts: [], extraHosts: [] }] })],
      snapshot: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0].sources).toEqual(['doctor']);
    expect(result[0].kind).toBe('sensitive-service-broad-exposure');
    expect(result[0].recommendedActions.some((a) => a.kind === 'open-stack-doctor')).toBe(true);
    expect(result[0].recommendedActions.some((a) => a.kind === 'open-stack-networking')).toBe(true);
  });

  it('collapses two occurrences on the SAME service into one merged card (one-to-many)', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({
        stack: 'stack1',
        findings: [
          { ruleId: 'port-conflict-internal', severity: 'warning', title: 'Port conflict', message: 'port 80 conflicts', service: 'web' },
          { ruleId: 'port-conflict-internal', severity: 'blocker', title: 'Port conflict', message: 'port 443 conflicts', service: 'web' },
        ],
      })),
    } as unknown as ComposeDoctorService);

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['stack1'], stackFacts: [stubFacts()], snapshot: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0].doctorFindings).toHaveLength(2);
    // Mixed severities: the merged card takes the worst (blocker -> critical).
    expect(result[0].severity).toBe('critical');
  });

  it('gives distinct services distinct cards, never collapsing them together', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({
        stack: 'stack1',
        findings: [
          { ruleId: 'port-conflict-internal', severity: 'blocker', title: 'Port conflict', message: 'port 80 conflicts', service: 'web' },
          { ruleId: 'port-conflict-internal', severity: 'blocker', title: 'Port conflict', message: 'port 90 conflicts', service: 'api' },
        ],
      })),
    } as unknown as ComposeDoctorService);

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['stack1'],
      stackFacts: [stubFacts({ services: [
        { name: 'web', networks: [], publishedPorts: [], extraHosts: [] },
        { name: 'api', networks: [], publishedPorts: [], extraHosts: [] },
      ] })],
      snapshot: null,
    });

    expect(result).toHaveLength(2);
    expect(new Set(result.map((f) => f.id)).size).toBe(2);
  });

  it('excludes acknowledged findings', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({
        stack: 'stack1',
        findings: [{
          ruleId: 'sensitive-service-broad-exposure', severity: 'high', title: 't', message: 'm',
          service: 'db', acknowledged: true,
        }],
      })),
    } as unknown as ComposeDoctorService);

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['stack1'], stackFacts: [stubFacts()], snapshot: null,
    });
    expect(result).toHaveLength(0);
  });

  it('discards a stale finding when the referenced service no longer exists', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({
        stack: 'stack1',
        findings: [{
          ruleId: 'sensitive-service-broad-exposure', severity: 'high', title: 't', message: 'm', service: 'removed-service',
        }],
      })),
    } as unknown as ComposeDoctorService);

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['stack1'], stackFacts: [stubFacts()], snapshot: null,
    });
    expect(result).toHaveLength(0);
  });

  it('is fail-soft: a getLatest() failure for one stack does not throw and other stacks still contribute', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockImplementation((_nodeId: number, stack: string) => {
        if (stack === 'broken') throw new Error('db unavailable');
        return stubReport({
          stack,
          findings: [{ ruleId: 'sensitive-service-broad-exposure', severity: 'high', title: 't', message: 'm', service: 'web' }],
        });
      }),
    } as unknown as ComposeDoctorService);

    expect(() => applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['broken', 'stack1'], stackFacts: [stubFacts({ stack: 'stack1' })], snapshot: null,
    })).not.toThrow();

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['broken', 'stack1'], stackFacts: [stubFacts({ stack: 'stack1' })], snapshot: null,
    });
    expect(result).toHaveLength(1);
    expect(result[0].stack).toBe('stack1');
  });

  it('never-run stacks are absent (no "never ran" nagging finding)', () => {
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue(stubReport({ stack: 'stack1', status: 'never-run', findings: [] })),
    } as unknown as ComposeDoctorService);

    const result = applyDoctorNetworkingFindings([], {
      nodeId: 1, stackNames: ['stack1'], stackFacts: [stubFacts()], snapshot: null,
    });
    expect(result).toHaveLength(0);
  });
});
