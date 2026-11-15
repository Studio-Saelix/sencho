import { describe, it, expect } from 'vitest';
import { parseReadinessReport, READINESS_CONTRACT_VERSION, type PilotReadinessReport } from '../pilot/readinessContract';
import {
  evaluateReadiness,
  readinessWithoutReport,
  sameHubUrl,
  MAX_CLOCK_SKEW_MS,
  type ReadinessExpectation,
  type ReadinessGate,
} from '../services/nodeBootstrap/readinessGates';

/**
 * The hub's readiness verdict. Every gate fails closed: a fact that is
 * missing, unknown or contradicts what the hub expects keeps the node from
 * Ready, and every failing gate names its own cause and a remediation.
 */

const NOW = 1_762_300_000_000;
const NONCE = 'a'.repeat(32);

function report(overrides: Partial<PilotReadinessReport> = {}): PilotReadinessReport {
  return {
    contract: READINESS_CONTRACT_VERSION,
    nonce: NONCE,
    generatedAt: NOW,
    agent: { version: '0.98.2', enrolledNodeId: 7, primaryUrl: 'https://hub.example.com', caBundle: false, capabilities: ['stacks', 'containers', 'cross-node-rbac', 'fleet'] },
    docker: { serverVersion: '28.1.1', apiVersion: '1.49' },
    composeDir: '/opt/docker/sencho',
    checks: [
      { id: 'docker_socket', status: 'pass', detail: 'Docker answered.', remediation: null },
      { id: 'docker_compose', status: 'pass', detail: 'Compose v2.35.1.', remediation: null },
      { id: 'compose_dir', status: 'pass', detail: 'Writable.', remediation: null },
      { id: 'self_stack_location', status: 'pass', detail: 'Outside.', remediation: null },
      { id: 'path_mapping', status: 'pass', detail: 'Same path.', remediation: null },
      { id: 'disk_space', status: 'pass', detail: '40% used.', remediation: null },
    ],
    inventory: { listed: true, containers: 3, agentContainer: true, agentDataVolume: true },
    ...overrides,
  };
}

function expected(overrides: Partial<ReadinessExpectation> = {}): ReadinessExpectation {
  return {
    nodeId: 7,
    nonce: NONCE,
    hubUrl: 'https://hub.example.com',
    composeDir: '/opt/docker/sencho',
    tunnelAgentVersion: '0.98.2',
    hubVersion: '0.98.2',
    tunnelConfidential: true,
    requestedAt: NOW - 100,
    receivedAt: NOW + 100,
    ...overrides,
  };
}

function gate(gates: ReadinessGate[], id: ReadinessGate['id']): ReadinessGate {
  const found = gates.find((entry) => entry.id === id);
  if (!found) throw new Error(`gate ${id} missing`);
  return found;
}

function withCheck(id: PilotReadinessReport['checks'][number]['id'], status: 'pass' | 'warn' | 'fail' | 'unknown', detail = 'observed'): PilotReadinessReport {
  const base = report();
  return { ...base, checks: base.checks.map((check) => check.id === id ? { id, status, detail, remediation: status === 'pass' ? null : `fix ${id}` } : check) };
}

describe('readiness report parser', () => {
  it('accepts a report of this contract', () => {
    expect(parseReadinessReport(JSON.parse(JSON.stringify(report())))).toEqual(report());
  });

  it('keeps a check the agent could not measure as unknown', () => {
    const measured = withCheck('disk_space', 'unknown', 'Disk usage could not be determined.');
    expect(parseReadinessReport(JSON.parse(JSON.stringify(measured)))?.checks.find((check) => check.id === 'disk_space')?.status).toBe('unknown');
  });

  const broken: Array<[string, unknown]> = [
    ['not an object', 'ready'],
    ['an array', [report()]],
    ['another contract', { ...report(), contract: 2 }],
    ['no nonce', { ...report(), nonce: '' }],
    ['a fractional clock', { ...report(), generatedAt: NOW + 0.5 }],
    ['an agent without a version', { ...report(), agent: { ...report().agent, version: 7 } }],
    ['a string node id', { ...report(), agent: { ...report().agent, enrolledNodeId: '7' } }],
    ['a missing CA flag', { ...report(), agent: { enrolledNodeId: 7, version: '1', primaryUrl: null } }],
    ['an unknown check', { ...report(), checks: [...report().checks.slice(1), { id: 'tls', status: 'pass', detail: 'x', remediation: null }] }],
    ['a check reported twice', { ...report(), checks: [report().checks[0], report().checks[0]] }],
    ['a check with an unrecognized status', { ...report(), checks: [{ ...report().checks[0], status: 'ok' }] }],
    ['no capability list', { ...report(), agent: { ...report().agent, capabilities: undefined } }],
    ['capabilities that are not a list', { ...report(), agent: { ...report().agent, capabilities: 'stacks' } }],
    ['a capability that is not text', { ...report(), agent: { ...report().agent, capabilities: ['stacks', 7] } }],
    ['a capability listed twice', { ...report(), agent: { ...report().agent, capabilities: ['stacks', 'stacks'] } }],
    ['an oversized capability list', { ...report(), agent: { ...report().agent, capabilities: Array.from({ length: 300 }, (_, index) => `cap-${index}`) } }],
    ['too many checks', { ...report(), checks: [...report().checks, report().checks[0]] }],
    ['a negative container count', { ...report(), inventory: { ...report().inventory, containers: -1 } }],
    ['an inventory flag as a string', { ...report(), inventory: { ...report().inventory, agentContainer: 'yes' } }],
    ['an oversized detail', { ...report(), checks: [{ ...report().checks[0], detail: 'x'.repeat(5000) }] }],
  ];
  it.each(broken)('refuses %s', (_label, value) => {
    expect(parseReadinessReport(value)).toBeNull();
  });
});

describe('readiness gates', () => {
  it('passes a fresh, matching report on a TLS tunnel', () => {
    const result = evaluateReadiness(report(), expected());
    expect(result.verdict).toBe('ready');
    expect(result.gates.every((entry) => entry.status === 'pass')).toBe(true);
    expect(result.gates.map((entry) => entry.id)).toEqual([
      'tunnel', 'contract', 'identity', 'hub_url', 'transport', 'clock', 'agent_version', 'release_match',
      'capabilities', 'docker_daemon', 'docker_compose', 'compose_dir', 'path_mapping', 'self_stack_location', 'disk_space', 'inventory',
    ]);
  });

  const failures: Array<[string, PilotReadinessReport, Partial<ReadinessExpectation>, ReadinessGate['id'], RegExp]> = [
    ['a replayed or relayed report', report({ nonce: 'b'.repeat(32) }), {}, 'contract', /nonce differs/],
    ['a Pilot enrolled as another node', report({ agent: { ...report().agent, enrolledNodeId: 9 } }), {}, 'identity', /enrolled as node 9, not node 7/],
    ['a Pilot with no saved credential', report({ agent: { ...report().agent, enrolledNodeId: null } }), {}, 'identity', /no saved hub credential/],
    ['a Pilot dialling another hub', report({ agent: { ...report().agent, primaryUrl: 'https://other.example.com' } }), {}, 'hub_url', /^The Pilot dials https:\/\/other\.example\.com, not the hub URL/],
    ['a Pilot with no hub URL', report({ agent: { ...report().agent, primaryUrl: null } }), {}, 'hub_url', /no hub URL/],
    ['an HTTPS hub reached without TLS', report(), { tunnelConfidential: false }, 'transport', /did not arrive over TLS/],
    ['a clock far off the hub', report({ generatedAt: NOW + MAX_CLOCK_SKEW_MS + 60_000 }), {}, 'clock', /off the hub/],
    ['an agent that changed version under the tunnel', report(), { tunnelAgentVersion: '0.98.1' }, 'agent_version', /tunnel announced 0\.98\.1/],
    ['a tunnel that announced no version', report(), { tunnelAgentVersion: null }, 'agent_version', /did not announce/],
    ['a Docker socket that refuses', withCheck('docker_socket', 'fail', 'Permission denied on the socket.'), {}, 'docker_daemon', /Permission denied/],
    ['a Compose plugin that is missing', withCheck('docker_compose', 'fail', 'docker compose not found.'), {}, 'docker_compose', /not found/],
    ['a Compose directory that is read-only', withCheck('compose_dir', 'fail', 'Not writable.'), {}, 'compose_dir', /Not writable/],
    ['a Compose directory other than the node\'s', report({ composeDir: '/srv/other' }), {}, 'compose_dir', /manages \/srv\/other/],
    ['a Compose directory mount that cannot be confirmed', withCheck('path_mapping', 'warn', 'Mounts unreadable.'), {}, 'path_mapping', /Mounts unreadable/],
    ['a Pilot project inside the Compose directory', withCheck('self_stack_location', 'fail', 'Inside.'), {}, 'self_stack_location', /Inside/],
    ['a disk that is full', withCheck('disk_space', 'fail', 'No space.'), {}, 'disk_space', /No space/],
    ['a disk whose usage could not be read', withCheck('disk_space', 'unknown', 'Disk usage could not be determined.'), {}, 'disk_space', /could not be determined/],
    ['a Pilot that advertises no capabilities', report({ agent: { ...report().agent, capabilities: [] } }), {}, 'capabilities', /does not advertise stacks, containers, cross-node-rbac/],
    ['a Pilot missing one required capability', report({ agent: { ...report().agent, capabilities: ['stacks', 'cross-node-rbac'] } }), {}, 'capabilities', /does not advertise containers\b/],
    ['a container listing that failed', report({ inventory: { listed: false, containers: null, agentContainer: null, agentDataVolume: null } }), {}, 'inventory', /could not list/],
    ['a listing without the canonical Pilot', report({ inventory: { listed: true, containers: 2, agentContainer: false, agentDataVolume: null } }), {}, 'inventory', /not the canonical Pilot/],
    ['a Pilot without its data volume', report({ inventory: { listed: true, containers: 2, agentContainer: true, agentDataVolume: false } }), {}, 'inventory', /sencho-agent-data/],
  ];

  it.each(failures)('keeps the node from Ready for %s', (_label, value, expectation, id, summary) => {
    const result = evaluateReadiness(value, expected(expectation));
    expect(result.verdict).toBe('not_ready');
    const failed = gate(result.gates, id);
    expect(['fail', 'unknown']).toContain(failed.status);
    expect(failed.summary).toMatch(summary);
    if (failed.status !== 'pass') expect(failed.remediation.length).toBeGreaterThan(10);
  });

  it('reads a Docker version it could not get as unknown, never as working', () => {
    const result = evaluateReadiness(report({ docker: { serverVersion: null, apiVersion: null } }), expected());
    expect(result.verdict).toBe('not_ready');
    expect(gate(result.gates, 'docker_daemon')).toMatchObject({ status: 'unknown' });
  });

  it('treats a check the Pilot did not report as unknown', () => {
    const result = evaluateReadiness(report({ checks: report().checks.filter((check) => check.id !== 'docker_compose') }), expected());
    expect(result.verdict).toBe('not_ready');
    expect(gate(result.gates, 'docker_compose')).toMatchObject({ status: 'unknown', summary: 'The Pilot did not report this check.' });
  });

  it('lets a plain-HTTP hub and a filling disk pass with a warning', () => {
    const result = evaluateReadiness(withCheck('disk_space', 'warn', '92% used.'), expected({ hubUrl: 'http://hub.lan:1852', tunnelConfidential: false }));
    const httpReport = { ...withCheck('disk_space', 'warn', '92% used.'), agent: { ...report().agent, primaryUrl: 'http://hub.lan:1852' } };
    const httpResult = evaluateReadiness(httpReport, expected({ hubUrl: 'http://hub.lan:1852', tunnelConfidential: false }));
    expect(result.verdict).toBe('not_ready');
    expect(httpResult.verdict).toBe('ready');
    expect(gate(httpResult.gates, 'transport')).toMatchObject({ status: 'warn' });
    expect(gate(httpResult.gates, 'disk_space')).toMatchObject({ status: 'warn', remediation: 'fix disk_space' });
  });

  it('lets a Pilot that advertises more than the baseline pass the capability gate', () => {
    const result = evaluateReadiness(report(), expected());
    expect(gate(result.gates, 'capabilities')).toMatchObject({ status: 'pass' });
  });

  it('warns, without blocking, when the Pilot runs another release than the hub', () => {
    const result = evaluateReadiness(report(), expected({ hubVersion: '0.99.0' }));
    expect(gate(result.gates, 'release_match')).toMatchObject({ status: 'warn', summary: expect.stringMatching(/0\.98\.2.*0\.99\.0/) });
    expect(result.verdict).toBe('ready');
  });

  it('compares hub URLs by origin and path', () => {
    expect(sameHubUrl('https://Hub.Example.com/', 'https://hub.example.com')).toBe(true);
    expect(sameHubUrl('https://hub.example.com/sencho/', 'https://hub.example.com/sencho')).toBe(true);
    expect(sameHubUrl('https://hub.example.com:8443', 'https://hub.example.com')).toBe(false);
    expect(sameHubUrl('http://hub.example.com', 'https://hub.example.com')).toBe(false);
    expect(sameHubUrl('not a url', 'https://hub.example.com')).toBe(false);
  });

  it('names its own cause when the Pilot could not be asked', () => {
    const cases = [
      [readinessWithoutReport({ kind: 'not_connected' }), 'tunnel', 'fail', /no refused attempt from it reached the hub/],
      [readinessWithoutReport({ kind: 'not_connected', refusal: 'enrollment_expired' }), 'tunnel', 'fail', /refused, because its enrollment had expired/],
      [readinessWithoutReport({ kind: 'not_connected', refusal: 'enrollment_used' }), 'tunnel', 'fail', /already used or replaced/],
      [readinessWithoutReport({ kind: 'not_connected', refusal: 'credential_expired' }), 'tunnel', 'fail', /refused, because its saved credential had expired/],
      [readinessWithoutReport({ kind: 'unsupported', status: 404 }), 'contract', 'fail', /does not provide the readiness report/],
      [readinessWithoutReport({ kind: 'refused', status: 403 }), 'contract', 'fail', /refused/],
      [readinessWithoutReport({ kind: 'malformed' }), 'contract', 'unknown', /not a readiness report/],
      [readinessWithoutReport({ kind: 'unreachable', message: 'no answer within 15s.' }), 'tunnel', 'unknown', /no answer within 15s/],
    ] as const;
    for (const [result, id, status, summary] of cases) {
      expect(result.verdict).toBe('not_ready');
      const blocking = result.gates.at(-1);
      expect(blocking).toMatchObject({ id, status });
      expect(blocking?.summary).toMatch(summary);
    }
  });
});
