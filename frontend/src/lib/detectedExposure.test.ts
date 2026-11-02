/**
 * Display copy for detected exposure: the conflict chip for a declared intent
 * and the proof line. The copy never claims reachability, verified routing or
 * safety; the last test asserts that over every string this module builds.
 */
import { describe, it, expect } from 'vitest';
import { conflictChip, conflictChipText, proofLine, strongestConflict } from './detectedExposure';
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

  it('marks a known path as only partly determined, with the reason', () => {
    expect(proofLine(detected({ paths: [broadPort], incomplete: ['runtime-ports-differ'] })))
      .toBe('partly undetermined: a running container publishes ports the Compose file does not.');
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
    for (const text of texts) {
      expect(text.toLowerCase()).not.toMatch(/\b(?:internet reachable|internet-reachable|safe|isolated)\b/);
      expect(text.toLowerCase().replace(/unverified/g, '')).not.toMatch(/verified/);
    }
  });
});
