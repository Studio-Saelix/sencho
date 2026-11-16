/**
 * Display copy for detected exposure: the conflict chip for a declared intent
 * and the proof line. The copy never claims reachability, verified routing or
 * safety; the last test asserts that over every string this module builds.
 */
import { describe, it, expect } from 'vitest';
import { conflictChip, conflictChipText, exposureAnswer, proofLine, runtimeUnchecked, strongestConflict } from './detectedExposure';
import type { DetectedPath, DetectedServiceExposure, ExposureIntent, IntentConflict } from '@/types/networking';

const EMPTY_CONFLICTS: Record<ExposureIntent, IntentConflict[]> = {
  internal: [], 'same-node': [], lan: [], 'reverse-proxy': [], public: [], temporary: [], unknown: [],
};

function detected(over: Partial<DetectedServiceExposure> & { paths?: DetectedPath[] } = {}): DetectedServiceExposure {
  return {
    status: 'paths',
    paths: [],
    incomplete: [],
    externalNetworks: [],
    runtimeChecked: true,
    conflicts: EMPTY_CONFLICTS,
    suggestedIntent: null,
    answer: 'no known exposure path',
    ...over,
  } as DetectedServiceExposure;
}

const broadPort: DetectedPath = {
  kind: 'host-port', scope: 'host-published', bind: 'all-interfaces',
  hostIp: '0.0.0.0', startPort: 8080, endPort: 8080, protocol: 'tcp',
};
const loopbackPort: DetectedPath = {
  kind: 'host-port', scope: 'host-loopback', bind: 'loopback',
  hostIp: '127.0.0.1', startPort: 3000, endPort: 3000, protocol: 'tcp',
};
const unverifiedTunnel: DetectedPath = {
  kind: 'tunnel', scope: 'public-edge', provider: 'cloudflared', connector: 'cf', path: 'shared-network', certain: false,
};
const certainTunnel: DetectedPath = {
  kind: 'tunnel', scope: 'private-overlay', provider: 'tailscale', connector: 'ts', path: 'shared-namespace', certain: true,
};
const viaPort: DetectedPath = { ...broadPort, via: 'app' };
const viaHost: DetectedPath = { kind: 'host-network', scope: 'host-published', via: 'app' };
const tailscaleNode: DetectedPath = { kind: 'connector', scope: 'private-overlay', provider: 'tailscale' };

describe('conflictChip', () => {
  it('names a real contradiction', () => {
    const chip = conflictChip(detected({
      paths: [broadPort],
      conflicts: { ...EMPTY_CONFLICTS, internal: [{ level: 'conflict', reason: 'host-port', paths: [0] }] },
    }), 'internal');
    expect(chip).toEqual({ level: 'conflict', text: 'conflicts with internal: published port' });
  });

  it('softens an unverified tunnel to a possible conflict', () => {
    const chip = conflictChip(detected({
      paths: [unverifiedTunnel],
      conflicts: { ...EMPTY_CONFLICTS, internal: [{ level: 'possible', reason: 'tunnel', paths: [0] }] },
    }), 'internal');
    expect(chip).toEqual({ level: 'possible', text: 'may conflict with internal: tunnel' });
  });

  it('notes a broad bind under reverse-proxy and temporary', () => {
    const conflicts = { ...EMPTY_CONFLICTS, 'reverse-proxy': [{ level: 'note' as const, reason: 'broad-bind' as const, paths: [0] }], temporary: [{ level: 'note' as const, reason: 'broad-bind' as const, paths: [0] }] };
    expect(conflictChip(detected({ paths: [broadPort], conflicts }), 'reverse-proxy')?.text).toBe('broad bind alongside reverse-proxy');
    expect(conflictChip(detected({ paths: [broadPort], conflicts }), 'temporary')?.text).toBe('broad bind alongside temporary');
  });

  it('names the namespace a via path comes from', () => {
    expect(conflictChipText(
      detected({ paths: [viaPort] }),
      { level: 'note', reason: 'shared-namespace', paths: [0] },
      'internal',
    )).toBe('shared namespace with app');
    expect(conflictChipText(
      detected({ paths: [viaHost] }),
      { level: 'note', reason: 'host-network', paths: [0] },
      'internal',
    )).toBe('host network through app');
  });

  it('names a private-overlay node without inventing a conflict', () => {
    expect(conflictChipText(
      detected({ paths: [tailscaleNode] }),
      { level: 'note', reason: 'tunnel', paths: [0] },
      'internal',
    )).toBe('Tailscale node alongside internal');
  });

  it('shows nothing for an intent the facts agree with', () => {
    expect(conflictChip(detected({ paths: [unverifiedTunnel] }), 'public')).toBeNull();
  });

  it('treats a loopback-only port as a conflict for internal but not same-node', () => {
    const value = detected({
      paths: [loopbackPort],
      conflicts: { ...EMPTY_CONFLICTS, internal: [{ level: 'conflict', reason: 'loopback-port', paths: [0] }] },
    });
    expect(conflictChip(value, 'internal')?.text).toBe('conflicts with internal: published port');
    expect(conflictChip(value, 'same-node')).toBeNull();
  });

  it('picks the strongest level when several apply', () => {
    const paths = [unverifiedTunnel, broadPort];
    const conflicts = {
      ...EMPTY_CONFLICTS,
      internal: [
        { level: 'possible' as const, reason: 'tunnel' as const, paths: [0] },
        { level: 'conflict' as const, reason: 'host-port' as const, paths: [1] },
      ],
    };
    const value = detected({ paths, conflicts });
    expect(strongestConflict(value, 'internal')).toEqual({ level: 'conflict', reason: 'host-port', paths: [1] });
    expect(conflictChip(value, 'internal')?.text).toBe('conflicts with internal: published port');
  });
});

describe('proofLine', () => {
  it('names why a detection could not be made', () => {
    const line = proofLine(detected({
      status: 'undetermined', paths: [], reasons: ['foreign-namespace'], answer: 'could not be determined',
    }));
    expect(line).toBe('could not be determined: it shares a network namespace with a container outside this stack.');
  });

  it('names the direction of a runtime port difference, in both directions', () => {
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-missing'] })))
      .toBe('partly undetermined: the Compose file declares a port the running container does not publish.');
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-extra'] })))
      .toBe('partly undetermined: a running container publishes a port the Compose file does not.');
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-missing', 'runtime-ports-extra'] })))
      .toBe('partly undetermined: the Compose file declares a port the running container does not publish; a running container publishes a port the Compose file does not.');
  });

  it('keeps a readable sentence for a reason from another build', () => {
    // The reason set travels with the node, so another build may send the name
    // this set replaced, or one this build has never had.
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-differ'] as never })))
      .toBe('partly undetermined: the running container and the Compose file disagree about the published ports.');
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['some-future-reason'] as never })))
      .toBe('partly undetermined: the node reported a reason this version of Sencho does not recognize.');
  });

  it('reads the reasons in a fixed order whatever order the node sends them', () => {
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-extra', 'runtime-ports-missing'] })))
      .toBe('partly undetermined: the Compose file declares a port the running container does not publish; a running container publishes a port the Compose file does not.');
  });

  it('names the namespace root, the external networks and the unchecked runtime', () => {
    const line = proofLine(detected({
      paths: [viaPort],
      externalNetworks: ['shared', 'edge'],
      runtimeChecked: false,
    }));
    expect(line).toBe('the host path comes from "app", whose network namespace it shares; a connector in another stack on "shared" and "edge" could reach it; runtime not checked, so a running container may reach more than the file says.');
  });

  it('is null for a clean, checked detection', () => {
    expect(proofLine(detected({ paths: [broadPort] }))).toBeNull();
  });
});

describe('never claims more than Sencho can see', () => {
  it('uses no reachability, safety or verified-routing language', () => {
    const intensities: IntentConflict['level'][] = ['conflict', 'possible', 'note'];
    const reasons: IntentConflict['reason'][] = ['host-port', 'loopback-port', 'host-network', 'tunnel', 'broad-bind', 'shared-namespace'];
    const texts: string[] = [];
    for (const level of intensities) {
      for (const reason of reasons) {
        texts.push(conflictChipText(detected({ paths: [broadPort, viaPort, viaHost, tailscaleNode, certainTunnel] }), { level, reason, paths: [0, 1, 2, 3, 4] }, 'internal'));
      }
    }
    texts.push(proofLine(detected({ status: 'undetermined', paths: [], reasons: ['hidden-connector'], answer: 'could not be determined' })) ?? '');
    texts.push(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-attachment'], externalNetworks: ['shared'], runtimeChecked: false })) ?? '');
    texts.push(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-missing', 'runtime-ports-extra'] })) ?? '');
    texts.push(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-differ'] as never })) ?? '');
    for (const text of texts) {
      expect(text.toLowerCase()).not.toMatch(/\b(?:internet reachable|internet-reachable|safe|isolated)\b/);
      expect(text.toLowerCase().replace(/unverified/g, '')).not.toMatch(/verified/);
    }
  });
});

describe('exposureAnswer', () => {
  const withConflict = (level: 'conflict' | 'possible' | 'note') => detected({
    paths: [broadPort],
    conflicts: { ...EMPTY_CONFLICTS, internal: [{ level, reason: 'host-port', paths: [0] }] },
  });

  it('is null when the node reports no detection', () => {
    expect(exposureAnswer([{ effectiveIntent: 'internal' }])).toBeNull();
  });

  it('counts conflicting services and leaves each reason to its chip', () => {
    const answer = exposureAnswer([
      { detected: withConflict('conflict'), effectiveIntent: 'internal' },
      { detected: withConflict('possible'), effectiveIntent: 'internal' },
      { detected: detected(), effectiveIntent: 'internal' },
    ]);
    expect(answer).toMatchObject({ tone: 'warning', title: 'conflict', line: '1 service conflicts and 1 may conflict with the declared exposure intent.' });
  });

  it('reads a lone possible conflict as may conflict', () => {
    expect(exposureAnswer([{ detected: withConflict('possible'), effectiveIntent: 'internal' }]))
      .toMatchObject({ title: 'may conflict', line: '1 service may conflict with the declared exposure intent.' });
  });

  it('does not raise an informational note to an Answer', () => {
    expect(exposureAnswer([{ detected: withConflict('note'), effectiveIntent: 'internal' }])?.tone).toBe('success');
  });

  it('says no intent is set when a detected service has none', () => {
    expect(exposureAnswer([{ detected: detected(), effectiveIntent: null }]))
      .toMatchObject({ tone: 'neutral', title: 'no intent set', line: '1 service has no exposure intent, so only the detected exposure is shown.' });
  });

  it('reads matches intent when every detected service has an agreeing intent', () => {
    expect(exposureAnswer([{ detected: detected(), effectiveIntent: 'public' }])?.title).toBe('matches intent');
  });

  it('reports an unread runtime separately from the answer', () => {
    expect(runtimeUnchecked([{ detected: detected({ runtimeChecked: false }) }, { detected: detected() }])).toBe(true);
    expect(runtimeUnchecked([{ detected: detected() }, {}])).toBe(false);
  });

  it('never claims a match for an undetermined or partly determined service', () => {
    const undetermined = detected({ status: 'undetermined', reasons: ['foreign-namespace'], paths: [] } as Partial<DetectedServiceExposure>);
    expect(exposureAnswer([{ detected: undetermined, effectiveIntent: 'public' }]))
      .toMatchObject({ tone: 'neutral', title: 'partly determined' });
    expect(exposureAnswer([{ detected: detected({ incomplete: ['runtime-ports-missing'] }), effectiveIntent: 'public' }]))
      .toMatchObject({ title: 'partly determined' });
  });

  it('does not claim a match while a connector in another stack could reach the service', () => {
    expect(exposureAnswer([{ detected: detected({ externalNetworks: ['shared'] }), effectiveIntent: 'public' }]))
      .toMatchObject({ title: 'partly determined' });
  });

  it('never claims a match for a service whose runtime was not read', () => {
    expect(exposureAnswer([{ detected: detected({ runtimeChecked: false }), effectiveIntent: 'public' }]))
      .toMatchObject({ tone: 'neutral', title: 'partly determined' });
    expect(exposureAnswer([
      { detected: detected(), effectiveIntent: 'public' },
      { detected: detected({ status: 'none-known', paths: [], runtimeChecked: false } as Partial<DetectedServiceExposure>), effectiveIntent: 'internal' },
    ])).toMatchObject({ tone: 'neutral', title: 'partly determined', line: '1 service has exposure that could not be fully determined, so no match is claimed.' });
  });

  it('still puts a conflict before an unread runtime', () => {
    const d = detected({
      runtimeChecked: false,
      paths: [broadPort],
      conflicts: { ...EMPTY_CONFLICTS, internal: [{ level: 'conflict', reason: 'host-port', paths: [0] }] },
    });
    expect(exposureAnswer([{ detected: d, effectiveIntent: 'internal' }])).toMatchObject({ tone: 'warning', title: 'conflict' });
  });

  it('reads a fully determined service with no known path and an intent as a match', () => {
    expect(exposureAnswer([{ detected: detected({ status: 'none-known', paths: [] } as Partial<DetectedServiceExposure>), effectiveIntent: 'internal' }]))
      .toMatchObject({ tone: 'success', title: 'matches intent' });
  });

  it('answers nothing for a stack with no services', () => {
    expect(exposureAnswer([])).toBeNull();
    expect(runtimeUnchecked([])).toBe(false);
  });

  it('does not claim a match when only some services report detection', () => {
    expect(exposureAnswer([{ detected: detected(), effectiveIntent: 'public' }, { effectiveIntent: 'public' }]))
      .toMatchObject({ title: 'partly determined' });
  });

  it('counts the unknown intent as unset', () => {
    expect(exposureAnswer([{ detected: detected(), effectiveIntent: 'unknown' }])).toMatchObject({ title: 'no intent set' });
  });

  it('puts a conflict before partial detection and unset intent', () => {
    expect(exposureAnswer([
      { detected: withConflict('conflict'), effectiveIntent: 'internal' },
      { detected: detected({ incomplete: ['runtime-ports-missing'] }), effectiveIntent: null },
    ])).toMatchObject({ title: 'conflict', line: '1 service conflicts with the declared exposure intent.' });
  });

  it('words a mix of conflicts and possible conflicts without overstating', () => {
    expect(exposureAnswer([
      { detected: withConflict('conflict'), effectiveIntent: 'internal' },
      { detected: withConflict('possible'), effectiveIntent: 'internal' },
      { detected: withConflict('possible'), effectiveIntent: 'internal' },
    ])?.line).toBe('1 service conflicts and 2 may conflict with the declared exposure intent.');
    expect(exposureAnswer([
      { detected: withConflict('possible'), effectiveIntent: 'internal' },
      { detected: withConflict('possible'), effectiveIntent: 'internal' },
    ])?.line).toBe('2 services may conflict with the declared exposure intent.');
  });

  it('omits the runtime note from the proof line only when asked', () => {
    const d = detected({ runtimeChecked: false });
    expect(proofLine(d)).toContain('runtime not checked');
    expect(proofLine(d, { includeRuntimeNote: false })).toBeNull();
    const withOthers = detected({ runtimeChecked: false, externalNetworks: ['shared'] });
    expect(proofLine(withOthers, { includeRuntimeNote: false })).toContain('"shared"');
    expect(proofLine(withOthers, { includeRuntimeNote: false })).not.toContain('runtime not checked');
  });
});
