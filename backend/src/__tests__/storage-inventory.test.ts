/**
 * Storage inventory core: the pure mount builder, the portability classifier
 * (every verdict and its edge cases), and the assembler's renderable/stateful
 * handling. These are pure functions over fixtures, so no filesystem or docker
 * is touched here (the live probe is covered by storage-probe-host-path.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { buildMounts, classifyPortability, assembleStorageInventory } from '../services/storage/inventory';
import type { HostPathProbe, StorageMount } from '../services/storage/types';
import type { EffectiveModel } from '../services/preflight/effectiveModel';

function probe(over: Partial<HostPathProbe> = {}): HostPathProbe {
  return {
    lexicalWithinStackDir: true, withinStackDir: true, exists: true, kind: 'directory',
    escapes: false, uid: null, gid: null, mode: null, ...over,
  };
}

/** A bind whose source resolves inside the stack directory. */
function withinBind(over: Partial<StorageMount> = {}): StorageMount {
  return { type: 'bind', source: '/app/stack/data', target: '/data', readOnly: false, service: 'app', probe: probe(), externalNamed: false, ...over };
}
/** A bind whose source is an external absolute host path (unprobed view). */
function externalBind(over: Partial<StorageMount> = {}): StorageMount {
  return {
    type: 'bind', source: '/mnt/media', target: '/media', readOnly: false, service: 'app',
    probe: probe({ lexicalWithinStackDir: false, withinStackDir: false, exists: false, kind: 'unknown' }),
    externalNamed: false, ...over,
  };
}
function socketBind(over: Partial<StorageMount> = {}): StorageMount {
  return {
    type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false, service: 'app',
    probe: probe({ lexicalWithinStackDir: false, withinStackDir: false, exists: false, kind: 'unknown' }),
    externalNamed: false, ...over,
  };
}
function namedVol(over: Partial<StorageMount> = {}): StorageMount {
  return { type: 'named', source: 'db', target: '/db', readOnly: false, service: 'app', probe: null, externalNamed: false, ...over };
}
function anonVol(over: Partial<StorageMount> = {}): StorageMount {
  return { type: 'anonymous', target: '/anon', readOnly: false, service: 'app', probe: null, externalNamed: false, ...over };
}
function tmpfsMount(over: Partial<StorageMount> = {}): StorageMount {
  return { type: 'tmpfs', target: '/run', readOnly: false, service: 'app', probe: null, externalNamed: false, ...over };
}

const verdict = (mounts: StorageMount[]) => classifyPortability(mounts, true);
const status = (mounts: StorageMount[]) => verdict(mounts).status;

describe('classifyPortability', () => {
  it('is node-bound when the Docker socket is mounted', () => {
    const v = verdict([socketBind()]);
    expect(v.status).toBe('node-bound');
    expect(v.reasons.some(r => r.includes('Docker socket'))).toBe(true);
  });

  it('is node-bound for an external bind, read-only or not', () => {
    expect(status([externalBind()])).toBe('node-bound');
    expect(status([externalBind({ readOnly: true })])).toBe('node-bound');
    expect(verdict([externalBind()]).reasons.some(r => r.includes('outside the stack directory'))).toBe(true);
  });

  it('detects a Docker socket mounted by target alone and reports it once', () => {
    const v = verdict([socketBind({ source: '/host/custom', target: '/var/run/docker.sock' })]);
    expect(v.status).toBe('node-bound');
    expect(v.reasons.filter(r => r.includes('Docker socket'))).toHaveLength(1);
    expect(v.reasons.some(r => r.includes('outside the stack directory'))).toBe(false);
  });

  it('accumulates every node-bound reason (socket and external bind together)', () => {
    const v = verdict([socketBind(), externalBind()]);
    expect(v.status).toBe('node-bound');
    expect(v.reasons.some(r => r.includes('Docker socket'))).toBe(true);
    expect(v.reasons.some(r => r.includes('outside the stack directory'))).toBe(true);
  });

  it('is node-bound for a within-stack symlink that resolves outside the stack dir', () => {
    const escaping = withinBind({ probe: probe({ kind: 'symlink', escapes: true, withinStackDir: false }) });
    const v = verdict([escaping]);
    expect(v.status).toBe('node-bound');
    expect(v.reasons.some(r => r.includes('symlink'))).toBe(true);
  });

  it('treats a broken symlink that escapes as node-bound, but one that stays inside as portable', () => {
    const brokenEscape = withinBind({ probe: probe({ kind: 'symlink', exists: true, escapes: true, withinStackDir: false }) });
    expect(status([brokenEscape])).toBe('node-bound');
    const brokenInside = withinBind({ probe: probe({ kind: 'symlink', exists: true, escapes: false, withinStackDir: true }) });
    expect(status([brokenInside])).toBe('portable');
  });

  it('is portable for within-stack binds only, including a bind that is the stack dir itself', () => {
    expect(status([withinBind()])).toBe('portable');
    expect(status([withinBind({ source: '/app/stack', target: '/app' })])).toBe('portable');
  });

  it('is partially portable for named or anonymous volumes', () => {
    expect(status([namedVol()])).toBe('partially-portable');
    expect(status([anonVol()])).toBe('partially-portable');
  });

  it('adds a distinct reason for an external named volume but stays partially portable', () => {
    const v = verdict([namedVol({ externalNamed: true })]);
    expect(v.status).toBe('partially-portable');
    expect(v.reasons.some(r => r.includes('pre-existing'))).toBe(true);
  });

  it('is portable for tmpfs-only and for no mounts at all', () => {
    expect(status([tmpfsMount()])).toBe('portable');
    expect(status([])).toBe('portable');
  });

  it('is partially portable for a mix of within-stack bind and named volume', () => {
    expect(status([withinBind(), namedVol()])).toBe('partially-portable');
  });

  it('is unknown when the model is unrenderable', () => {
    const v = classifyPortability([], false);
    expect(v.status).toBe('unknown');
    expect(v.reasons[0]).toContain('could not render');
  });
});

describe('buildMounts', () => {
  function model(): EffectiveModel {
    return {
      projectName: 'app',
      services: [
        {
          name: 'web', image: 'nginx', ports: [], binds: [], namedVolumes: [],
          storageMounts: [
            { type: 'bind', source: '/app/stack/conf', target: '/conf', readOnly: true },
            { type: 'named', source: 'shared', target: '/s', readOnly: false },
          ],
          privileged: false, hasHealthcheck: true, envKeys: [], networks: [], extraHosts: [], labelKeys: [],
        },
      ],
      networks: {},
      volumes: { shared: { name: 'shared_vol', external: true, internal: false } },
    };
  }

  it('flattens mounts with their service, attaches bind probes, and marks external named volumes', () => {
    const probes = new Map<string, HostPathProbe>([['/app/stack/conf', probe({ kind: 'directory' })]]);
    const mounts = buildMounts(model(), probes);
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toMatchObject({ service: 'web', type: 'bind', probe: { kind: 'directory' } });
    expect(mounts[1]).toMatchObject({ service: 'web', type: 'named', probe: null, externalNamed: true });
  });
});

describe('assembleStorageInventory', () => {
  it('returns an unrenderable, stateless, unknown inventory when the model is null', () => {
    const inv = assembleStorageInventory('web', null, 'boom', new Map());
    expect(inv).toMatchObject({ renderable: false, renderError: 'boom', stateful: false, mounts: [] });
    expect(inv.portability.status).toBe('unknown');
  });

  it('marks a stack with persistent storage stateful and a tmpfs-only stack stateless', () => {
    const stateful: EffectiveModel = {
      projectName: 'a', services: [{
        name: 'app', ports: [], binds: [], namedVolumes: [],
        storageMounts: [{ type: 'named', source: 'db', target: '/db', readOnly: false }],
        privileged: false, hasHealthcheck: true, envKeys: [], networks: [], extraHosts: [], labelKeys: [],
      }], networks: {}, volumes: {},
    };
    expect(assembleStorageInventory('a', stateful, null, new Map()).stateful).toBe(true);

    const ephemeral: EffectiveModel = {
      ...stateful,
      services: [{ ...stateful.services[0], storageMounts: [{ type: 'tmpfs', target: '/run', readOnly: false }] }],
    };
    expect(assembleStorageInventory('a', ephemeral, null, new Map()).stateful).toBe(false);
  });

  it('does not mark a docker-socket-only stack as stateful (the socket holds no data)', () => {
    const socketOnly: EffectiveModel = {
      projectName: 'a', services: [{
        name: 'app', ports: [], binds: [], namedVolumes: [],
        storageMounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false }],
        privileged: false, hasHealthcheck: true, envKeys: [], networks: [], extraHosts: [], labelKeys: [],
      }], networks: {}, volumes: {},
    };
    expect(assembleStorageInventory('a', socketOnly, null, new Map()).stateful).toBe(false);
  });
});
