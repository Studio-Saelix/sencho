/**
 * The projection contract: exactly the documented fields, built from an
 * allowlist, with bounds.
 *
 * The canary cases are the point of the file. Each source object carries a
 * unique marker in every field the projection must NOT publish (node paths and
 * URLs, free-text reasons, image ids, finding prose, fingerprints), so a future
 * spread of a source object fails here instead of shipping Compose content or
 * operator prose to an AI client.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTAINER_LIMIT,
  FINDINGS_LIMIT,
  NODE_NAME_MAX_LENGTH,
  projectFleetHealth,
  projectNode,
  projectStackList,
  projectStackReadiness,
  projectStackStatus,
  projectUnavailableStackStatus,
} from '../services/observation/projections';
import { READINESS_DOMAINS, type FleetReadinessResponse } from '../services/readiness/types';
import type { Node } from '../services/DatabaseService';
import type { StackStatusEntry } from '../services/observation/projections';
import type { StackContainerFact } from '../services/health/stackHealthFacts';

const CANARY = 'CANARY_DO_NOT_LEAK';

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 3,
    name: 'edge-node',
    type: 'remote',
    mode: 'proxy',
    compose_dir: `/srv/${CANARY}/compose`,
    is_default: false,
    status: 'online',
    created_at: 1,
    api_url: `https://${CANARY}.example.com`,
    api_token: CANARY,
    pilot_last_seen: null,
    pilot_agent_version: CANARY,
    last_successful_contact: 1_700_000_000,
    cordoned: true,
    cordoned_at: 2,
    cordoned_reason: CANARY,
    ...overrides,
  };
}

function container(overrides: Partial<StackContainerFact> = {}): StackContainerFact {
  return {
    id: 'abcdef'.padEnd(64, '0'),
    name: 'web-1',
    service: 'web',
    state: 'running',
    health: 'healthy',
    restartCount: 1,
    startedAt: '2026-01-01T00:00:00Z',
    imageId: `sha256:${CANARY}`,
    exitCode: 0,
    restartPolicy: 'unless-stopped',
    ...overrides,
  };
}

describe('node projection', () => {
  it('publishes exactly the documented fields', () => {
    const projected = projectNode(node());
    expect(keysOf(projected)).toEqual([
      'cordoned', 'id', 'lastContactAt', 'name', 'status', 'transport', 'type',
    ]);
    expect(projected.transport).toBe('proxy');
  });

  it('publishes lastContactAt in epoch ms for every transport', () => {
    // `last_successful_contact` is stored in whole seconds, `pilot_last_seen` in ms.
    expect(projectNode(node()).lastContactAt).toBe(1_700_000_000_000);
    expect(projectNode(node({ type: 'local', last_successful_contact: 1_700_000_000 })).lastContactAt)
      .toBe(1_700_000_000_000);
    expect(projectNode(node({ mode: 'pilot_agent', pilot_last_seen: 1_700_000_000_000 })).lastContactAt)
      .toBe(1_700_000_000_000);
    // Same contact moment on both transports gives the same published value.
    expect(projectNode(node({ last_successful_contact: 1_700_000_123 })).lastContactAt)
      .toBe(projectNode(node({ mode: 'pilot_agent', pilot_last_seen: 1_700_000_123_000 })).lastContactAt);
  });

  it('keeps a zero contact as zero, not null', () => {
    expect(projectNode(node({ last_successful_contact: 0 })).lastContactAt).toBe(0);
    expect(projectNode(node({ mode: 'pilot_agent', pilot_last_seen: 0 })).lastContactAt).toBe(0);
  });

  it('keeps an absent contact null on every transport', () => {
    expect(projectNode(node({ last_successful_contact: null })).lastContactAt).toBeNull();
    expect(projectNode(node({ last_successful_contact: undefined })).lastContactAt).toBeNull();
    expect(projectNode(node({ mode: 'pilot_agent', pilot_last_seen: null })).lastContactAt).toBeNull();
  });

  it('never carries paths, URLs, credentials, reasons or the agent version', () => {
    expect(JSON.stringify(projectNode(node()))).not.toContain(CANARY);
  });

  it('classifies transport from the node mode', () => {
    expect(projectNode(node({ type: 'local', mode: 'proxy' })).transport).toBe('local');
    expect(projectNode(node({ mode: 'pilot_agent', pilot_last_seen: 42 })).transport).toBe('pilot');
    expect(projectNode(node({ mode: 'pilot_agent', pilot_last_seen: 42 })).lastContactAt).toBe(42);
  });

  it('truncates a long name', () => {
    const projected = projectNode(node({ name: 'n'.repeat(400) }));
    expect(projected.name).toHaveLength(NODE_NAME_MAX_LENGTH);
  });
});

describe('stack list projection', () => {
  const entries: StackStatusEntry[] = ['beta', 'alpha', 'gamma'].map((name) => ({
    name,
    info: {
      status: 'running',
      mainPort: 8080,
      mainPortService: 'web',
      runningSince: 1,
      running: 2,
      total: 3,
      networks: [`${CANARY}_net`],
    },
    source: 'local',
    isSelf: false,
  }));

  it('publishes exactly the documented fields', () => {
    const page = projectStackList(entries, null, 10, false);
    expect(keysOf(page)).toEqual(['degraded', 'nextCursor', 'stacks', 'total']);
    expect(keysOf(page.stacks[0])).toEqual(['isSelf', 'name', 'running', 'source', 'status', 'total']);
    expect(page.stacks.map((s) => s.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('never carries ports, networks or uptime', () => {
    expect(JSON.stringify(projectStackList(entries, null, 10, false))).not.toContain(CANARY);
  });

  it('pages by the last returned name and stops at the end', () => {
    const first = projectStackList(entries, null, 2, false);
    expect(first.stacks.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(first.nextCursor).toBe('beta');
    expect(first.total).toBe(3);

    const second = projectStackList(entries, first.nextCursor, 2, false);
    expect(second.stacks.map((s) => s.name)).toEqual(['gamma']);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps a stable page when the cursor stack was deleted', () => {
    const remaining = entries.filter((entry) => entry.name !== 'alpha');
    const page = projectStackList(remaining, 'alpha', 2, false);
    expect(page.stacks.map((s) => s.name)).toEqual(['beta', 'gamma']);
  });

  it('passes degraded through', () => {
    expect(projectStackList(entries, null, 10, true).degraded).toBe(true);
  });

  describe('very long stack names (130 characters and up)', () => {
    const long = 'q'.repeat(130);
    const longer = `${long}z`;
    const withNames = (names: string[]): StackStatusEntry[] => names.map((name) => ({ ...entries[0], name }));

    it('lists them whole, so the name round-trips as a cursor', () => {
      const all = withNames([longer, long, 'alpha']);
      const first = projectStackList(all, null, 1, false);
      expect(first.stacks[0].name).toBe('alpha');
      const second = projectStackList(all, first.nextCursor, 1, false);
      expect(second.stacks[0].name).toBe(long);
      expect(second.nextCursor).toBe(long);
      const third = projectStackList(all, second.nextCursor, 1, false);
      expect(third.stacks[0].name).toBe(longer);
      expect(third.nextCursor).toBeNull();
    });
  });

  it('leaves out a directory no observation route can address', () => {
    const all = (['alpha', 'my.stack', 'with space', 'beta'] as const).map((name) => ({ ...entries[0], name }));
    const page = projectStackList(all, null, 10, false);
    expect(page.stacks.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(page.total).toBe(2);
  });
});

describe('stack status projection', () => {
  it('publishes exactly the documented fields', () => {
    const projected = projectStackStatus('web', [container()]);
    expect(keysOf(projected)).toEqual(['containers', 'outcome', 'stack', 'truncated']);
    expect(keysOf(projected.containers[0])).toEqual([
      'exitCode', 'health', 'name', 'restartCount', 'service', 'startedAt', 'state',
    ]);
    expect(projected.outcome).toBe('ok');
  });

  it('never carries image ids, ids, restart policy or labels', () => {
    expect(JSON.stringify(projectStackStatus('web', [container()]))).not.toContain(CANARY);
  });

  it('maps an unknown Docker state to other rather than dropping the container', () => {
    const projected = projectStackStatus('web', [container({ state: 'deadlocked' })]);
    expect(projected.containers).toHaveLength(1);
    expect(projected.containers[0].state).toBe('other');
  });

  it('keeps a null health null and an unknown health none', () => {
    expect(projectStackStatus('web', [container({ health: null })]).containers[0].health).toBeNull();
    expect(projectStackStatus('web', [container({ health: 'weird' })]).containers[0].health).toBe('none');
  });

  it('bounds the container list and flags truncation', () => {
    const facts = Array.from({ length: CONTAINER_LIMIT + 1 }, (_, i) => container({ name: `c-${i}` }));
    const projected = projectStackStatus('web', facts);
    expect(projected.containers).toHaveLength(CONTAINER_LIMIT);
    expect(projected.truncated).toBe(true);
  });

  it('echoes a very long stack name unchanged', () => {
    const long = 'q'.repeat(130);
    expect(projectStackStatus(long, [container()]).stack).toBe(long);
    expect(projectUnavailableStackStatus(long).stack).toBe(long);
  });

  describe('container order under the cap', () => {
    it('keeps the containers that need attention when the list is cut', () => {
      const healthy = Array.from({ length: CONTAINER_LIMIT }, (_, i) => container({ name: `a-${String(i).padStart(3, '0')}` }));
      const exited = container({ name: 'z-exited', state: 'exited', exitCode: 137 });
      const unhealthy = container({ name: 'z-unhealthy', health: 'unhealthy' });
      const projected = projectStackStatus('web', [...healthy, exited, unhealthy]);

      expect(projected.truncated).toBe(true);
      expect(projected.containers).toHaveLength(CONTAINER_LIMIT);
      expect(projected.containers.slice(0, 2).map((c) => c.name)).toEqual(['z-exited', 'z-unhealthy']);
    });

    it('orders attention, then starting, then healthy, each by name', () => {
      const projected = projectStackStatus('web', [
        container({ name: 'b-ok' }),
        container({ name: 'c-starting', health: 'starting' }),
        container({ name: 'a-ok' }),
        container({ name: 'd-restarting', state: 'restarting' }),
        container({ name: 'e-weird', state: 'deadlocked' }),
      ]);
      expect(projected.containers.map((c) => c.name)).toEqual([
        'd-restarting', 'e-weird', 'c-starting', 'a-ok', 'b-ok',
      ]);
    });

    it('orders equal-rank names by code point, not by locale', () => {
      const names = ['a_1', 'B-1', 'a-2', '0', 'a-1'];
      const projected = projectStackStatus('web', names.map((name) => container({ name })));
      expect(projected.containers.map((c) => c.name)).toEqual(['0', 'B-1', 'a-1', 'a-2', 'a_1']);
    });

    it('treats a running container with no healthcheck like a healthy one', () => {
      const projected = projectStackStatus('web', [
        container({ name: 'a-starting', health: 'starting' }),
        container({ name: 'b-none', health: 'none' }),
        container({ name: 'c-null', health: null }),
        container({ name: 'd-exited', state: 'exited' }),
        container({ name: 'e-paused', state: 'paused' }),
        container({ name: 'f-dead', state: 'dead' }),
        container({ name: 'g-created', state: 'created' }),
      ]);
      expect(projected.containers.map((c) => c.name)).toEqual([
        'd-exited', 'e-paused', 'f-dead', 'g-created', 'a-starting', 'b-none', 'c-null',
      ]);
    });

    it('gives the same list whatever order Docker returned', () => {
      const facts = ['m-3', 'm-7', 'm-14', 'm-1'].map((name) => container({ name }));
      const forward = projectStackStatus('web', facts).containers.map((c) => c.name);
      const reversed = projectStackStatus('web', [...facts].reverse()).containers.map((c) => c.name);
      expect(forward).toEqual(reversed);
      expect(forward).toEqual(['m-1', 'm-14', 'm-3', 'm-7']);
    });
  });

  it('answers unavailable as a 200-shaped payload with no containers', () => {
    expect(projectUnavailableStackStatus('web')).toEqual({
      stack: 'web',
      outcome: 'unavailable',
      containers: [],
      truncated: false,
    });
  });
});

describe('stack readiness projection', () => {
  const row = {
    stack: 'web',
    update: {
      verdict: 'review_required' as const,
      topReason: CANARY,
      topReasonId: 'containers' as const,
      hasUpdate: true,
      computedAt: 7,
    },
    rollback: {
      overall: 'partial' as const,
      topReason: CANARY,
      topReasonId: 'env_keys' as const,
      computedAt: 8,
    },
    unavailableReason: null,
  };

  it('publishes exactly the documented fields and drops the prose', () => {
    const projected = projectStackReadiness(row);
    expect(keysOf(projected)).toEqual(['rollback', 'stack', 'unavailableReason', 'update']);
    expect(keysOf(projected.update!)).toEqual(['computedAt', 'hasUpdate', 'topReasonId', 'verdict']);
    expect(keysOf(projected.rollback!)).toEqual(['computedAt', 'overall', 'topReasonId']);
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it('narrows unavailableReason to the two codes a per-stack compute produces', () => {
    expect(projectStackReadiness({ ...row, update: null, rollback: null, unavailableReason: 'summary_truncated' })
      .unavailableReason).toBe('summary_truncated');
    expect(projectStackReadiness({ ...row, update: null, rollback: null, unavailableReason: 'domain_error' })
      .unavailableReason).toBe('domain_error');
    expect(projectStackReadiness({ ...row, update: null, rollback: null, unavailableReason: 'summary_stale' })
      .unavailableReason).toBeNull();
  });
});

describe('fleet health projection', () => {
  function response(): FleetReadinessResponse {
    return {
      generatedAt: 1_700_000_000_000,
      domains: READINESS_DOMAINS.filter((domain) => domain !== 'control'),
      domainsOmitted: ['control'],
      summary: {
        nodes: { attention: 1, degraded: 0, unavailable: 0, unknown: 0, healthy: 0 },
        findings: { attention: 1, degraded: 0, unavailable: 0, unknown: 0 },
      },
      nodes: [
        {
          id: 1,
          name: 'hub',
          type: 'local',
          mode: 'proxy',
          transport: 'local',
          state: 'attention',
          reachability: {
            status: 'online',
            contactAt: 5,
            contactSource: 'local',
            note: 'Local node',
            probedLive: true,
            latencyMs: 4,
          },
          cells: {
            workloads: {
              state: 'attention',
              reasonCode: 'workloads_exited',
              counts: { exited: 1 },
              evidenceAgeMs: 100,
              source: 'live',
            },
          },
          stackCount: 2,
        },
      ],
      findings: [
        {
          id: 'workloads:1:web:workloads_exited',
          domain: 'workloads',
          nodeId: 1,
          stack: 'web',
          code: 'workloads_exited',
          severity: 'attention',
          count: 1,
          verdict: null,
          detail: CANARY,
          target: { surface: 'stack', nodeId: 1, stackName: 'web' },
          fingerprint: CANARY,
          dismissPolicy: 'timed',
        },
      ],
      dismissals: [],
    };
  }

  it('publishes exactly the documented fields', () => {
    const projected = projectFleetHealth(response(), false);
    expect(keysOf(projected)).toEqual([
      'domains', 'domainsOmitted', 'findings', 'findingsTruncated', 'nodes', 'stale', 'summary',
    ]);
    expect(keysOf(projected.nodes[0])).toEqual([
      'cells', 'id', 'name', 'reachability', 'stackCount', 'state', 'transport',
    ]);
    expect(keysOf(projected.nodes[0].reachability)).toEqual([
      'contactAt', 'latencyMs', 'probedLive', 'status',
    ]);
    expect(keysOf(projected.nodes[0].cells.workloads!)).toEqual([
      'evidenceAgeMs', 'reasonCode', 'source', 'state',
    ]);
    expect(keysOf(projected.findings[0])).toEqual([
      'code', 'count', 'domain', 'id', 'nodeId', 'severity', 'stack',
    ]);
  });

  it('never carries finding prose, fingerprints, targets, dismiss policies or dismissals', () => {
    expect(JSON.stringify(projectFleetHealth(response(), false))).not.toContain(CANARY);
  });

  it('keeps control omitted rather than inventing a column', () => {
    const projected = projectFleetHealth(response(), false);
    expect(projected.domains).not.toContain('control');
    expect(projected.domainsOmitted).toContain('control');
  });

  it('passes stale through', () => {
    expect(projectFleetHealth(response(), true).stale).toBe(true);
  });

  it('keeps the aggregate order, caps the tail and flags truncation', () => {
    // The aggregator supplies worst-first order; this projection must not sort
    // or interleave, and the cap must drop the tail (the least severe rows).
    const base = response();
    const findings = Array.from({ length: FINDINGS_LIMIT + 1 }, (_, i) => ({
      ...base.findings[0],
      id: `f-${i}`,
      severity: i === FINDINGS_LIMIT ? ('unknown' as const) : ('attention' as const),
    }));
    const projected = projectFleetHealth({ ...base, findings }, false);
    expect(projected.findings).toHaveLength(FINDINGS_LIMIT);
    expect(projected.findings.map((finding) => finding.id)).toEqual(
      findings.slice(0, FINDINGS_LIMIT).map((finding) => finding.id),
    );
    expect(projected.findingsTruncated).toBe(true);
  });
});
