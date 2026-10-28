import { describe, expect, it } from 'vitest';
import {
  createOptionsFromSnapshot,
  helperFiles,
  HELPER_DATA_DIR,
  parseOutcome,
  replaceProvider,
  stageProviderReplacement,
  type ContainerSnapshot,
  type HelperDeps,
  type ProviderReplacePlan,
} from '../helpers/endpointProviderReplace';

const OP = '3f2b8c1e-5a4d-4e7f-9b2a-1c3d5e7f9a0b';

function plan(overrides: Partial<ProviderReplacePlan> = {}): ProviderReplacePlan {
  return {
    schemaVersion: 1,
    operationId: OP,
    mode: 'reapply',
    project: 'stack',
    workingDir: '/srv/stack',
    configFiles: ['/srv/stack/compose.yaml'],
    providerService: 'socket-proxy',
    senchoService: 'sencho',
    providerContainerId: 'old-proxy-id-0000000000',
    composeCopy: null,
    pruneOnUpdate: false,
    providerReadySeconds: 60,
    ackSeconds: 180,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ContainerSnapshot> = {}): ContainerSnapshot {
  return {
    Id: 'old-proxy-id-0000000000',
    Name: '/stack-socket-proxy-1',
    Image: 'sha256:previous',
    Config: {
      Image: 'tecnativa/docker-socket-proxy:0.3',
      Hostname: 'old-proxy-id',
      Env: ['CONTAINERS=1'],
      Labels: { 'com.docker.compose.project': 'stack', 'com.docker.compose.service': 'socket-proxy' },
    },
    HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'], RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: {
      Networks: {
        stack_default: { Aliases: ['socket-proxy', 'old-proxy-id'], IPAMConfig: null },
        stack_edge: { Aliases: ['proxy'], IPAMConfig: { IPv4Address: '172.30.0.9' } },
      },
    },
    State: { Running: true, Status: 'running' },
    ...overrides,
  };
}

interface Fake {
  deps: HelperDeps;
  files: Map<string, unknown>;
  composeCalls: string[][];
  created: Array<Record<string, unknown>>;
  removed: string[];
  removedFiles: string[];
  connected: Array<[string, string]>;
  pruned: string[];
  log: string[];
}

/**
 * A scripted Docker host. `compose` answers by the first argument (and, for
 * `up`, the service), the clock advances on every sleep, and an `onSleep`
 * hook lets a test write the new Sencho's ack at a chosen moment.
 */
function fake(options: {
  ping?: () => Promise<void>;
  inspect?: (id: string) => ContainerSnapshot | null;
  compose?: Partial<Record<string, { ok: boolean; output: string }>>;
  create?: () => Promise<string>;
  onSleep?: (files: Map<string, unknown>, now: number) => void;
} = {}): Fake {
  let now = 0;
  const files = new Map<string, unknown>();
  const state: Omit<Fake, 'deps'> = { files, composeCalls: [], created: [], removed: [], removedFiles: [], connected: [], pruned: [], log: [] };
  const deps: HelperDeps = {
    docker: {
      ping: options.ping ?? (async () => undefined),
      inspect: async (id) => (options.inspect ? options.inspect(id) : (id === 'restored-id'
        ? snapshot({ Id: 'restored-id', State: { Running: true, Status: 'running' } })
        : snapshot())),
      serviceContainers: async () => ['new-proxy-id'],
      remove: async (id) => { state.removed.push(id); },
      create: async (opts) => {
        state.created.push(opts);
        return options.create ? options.create() : 'restored-id';
      },
      connect: async (network, id) => { state.connected.push([network, id]); },
      start: async () => undefined,
      pruneDanglingImages: async () => { state.pruned.push('dangling'); },
    },
    compose: async (args) => {
      state.composeCalls.push(args);
      const key = args[0] === 'up' ? `up:${args[args.length - 1]}` : args[0];
      const scripted = options.compose?.[key];
      if (scripted) return scripted;
      if (args[0] === 'config') {
        return { ok: true, output: JSON.stringify({ services: { 'socket-proxy': { image: 'tecnativa/docker-socket-proxy:0.4' }, sencho: { image: 'saelix/sencho:0.99.0' } } }) };
      }
      return { ok: true, output: '' };
    },
    readJson: async (path) => files.get(path) ?? null,
    writeJson: async (path, value) => { files.set(path, value); },
    removeFile: async (path) => { files.delete(path); state.removedFiles.push(path); },
    copyFile: async (from, to) => { files.set(to, files.get(from) ?? 'copied'); },
    sleep: async (ms) => {
      now += ms;
      options.onSleep?.(files, now);
    },
    now: () => now,
    log: (message) => { state.log.push(message); },
  };
  return { deps, ...state };
}

const ackPath = helperFiles.ack(HELPER_DATA_DIR, OP);
const outcomePath = helperFiles.outcome(HELPER_DATA_DIR, OP);
const snapshotPath = helperFiles.snapshot(HELPER_DATA_DIR, OP);

/** Writes a positive ack once the clock passes `atMs` (the new Sencho checking in). */
function ackAt(atMs: number, ok = true) {
  return (files: Map<string, unknown>, now: number) => {
    if (now >= atMs && !files.has(ackPath)) files.set(ackPath, { operationId: OP, ok, detail: ok ? null : 'ping refused' });
  };
}

describe('stageProviderReplacement', () => {
  it('refuses before anything stops when the mounted socket does not answer', async () => {
    const f = fake({ ping: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); } });
    const result = await stageProviderReplacement(plan(), f.deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('could not reach Docker through the host socket') });
    expect(f.composeCalls).toEqual([]);
    expect(f.files.has(snapshotPath)).toBe(false);
  });

  it('refuses when the socket belongs to a different engine (the provider container is not visible)', async () => {
    const f = fake({ inspect: () => null });
    const result = await stageProviderReplacement(plan(), f.deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('different Docker engine') });
    expect(f.composeCalls).toEqual([]);
  });

  it('refuses when the visible container is not the provider service of the project', async () => {
    const f = fake({ inspect: () => snapshot({ Config: { Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'socket-proxy' } } }) });
    expect((await stageProviderReplacement(plan(), f.deps)).ok).toBe(false);
  });

  it('refuses when the provider has no declared image (build-only service)', async () => {
    const f = fake({ compose: { config: { ok: true, output: JSON.stringify({ services: { 'socket-proxy': { build: '.' }, sencho: { image: 's' } } }) } } });
    const result = await stageProviderReplacement(plan(), f.deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('does not declare an image') });
  });

  it('refuses when the Compose project does not render', async () => {
    const f = fake({ compose: { config: { ok: false, output: 'service "socket-proxy" refers to undefined network edge' } } });
    const result = await stageProviderReplacement(plan(), f.deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('undefined network edge') });
  });

  it('refuses when the provider image cannot be pulled, before anything stops', async () => {
    const f = fake({ compose: { pull: { ok: false, output: 'manifest unknown' } } });
    const result = await stageProviderReplacement(plan(), f.deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('manifest unknown') });
    expect(f.composeCalls.some(args => args[0] === 'up')).toBe(false);
    expect(f.files.has(snapshotPath)).toBe(false);
  });

  it('pulls only a missing image on Reapply and always on Update', async () => {
    const reapply = fake();
    await stageProviderReplacement(plan({ mode: 'reapply' }), reapply.deps);
    expect(reapply.composeCalls).toContainEqual(['pull', '--quiet', '--policy', 'missing', 'socket-proxy']);
    const update = fake();
    await stageProviderReplacement(plan({ mode: 'update' }), update.deps);
    expect(update.composeCalls).toContainEqual(['pull', '--quiet', '--policy', 'always', 'socket-proxy']);
  });

  it('snapshots the running provider by image ID for rollback', async () => {
    const f = fake();
    const result = await stageProviderReplacement(plan(), f.deps);
    expect(result).toEqual({ ok: true, providerImage: 'tecnativa/docker-socket-proxy:0.4', previousImageId: 'sha256:previous', previousImageRef: 'tecnativa/docker-socket-proxy:0.3' });
    expect((f.files.get(snapshotPath) as ContainerSnapshot).Image).toBe('sha256:previous');
  });
});

describe('replaceProvider', () => {
  function staged(f: Fake) {
    f.files.set(snapshotPath, snapshot());
    return f;
  }

  it('recreates the provider then Sencho with targeted Compose and succeeds only after a positive ack', async () => {
    const f = staged(fake({ onSleep: ackAt(20_000) }));
    const outcome = await replaceProvider(plan(), f.deps);
    expect(outcome).toEqual({ operationId: OP, ok: true });
    expect(f.composeCalls).toEqual([
      ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '60', 'socket-proxy'],
      ['up', '-d', '--no-deps', '--force-recreate', 'sencho'],
    ]);
    expect(f.files.get(outcomePath)).toEqual({ operationId: OP, ok: true });
    expect(f.created).toEqual([]);
  });

  it('recreates only the provider when the plan is provider-scoped, and still waits for the ack', async () => {
    const f = staged(fake({ onSleep: ackAt(20_000) }));
    const outcome = await replaceProvider(plan({ scope: 'provider' }), f.deps);
    expect(outcome).toEqual({ operationId: OP, ok: true });
    expect(f.composeCalls).toEqual([
      ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '60', 'socket-proxy'],
    ]);
    expect(f.log).toContain('Sencho stays running; waiting for it to reconnect through the new Docker endpoint');
    // The phase marker is durable and written before the ack window opens, so a
    // Sencho that stayed alive knows when to verify.
    expect(f.files.get(helperFiles.recreated(HELPER_DATA_DIR, OP))).toMatchObject({ operationId: OP });
    expect(f.files.get(outcomePath)).toEqual({ operationId: OP, ok: true });
  });

  it('restores the provider-only replacement when Sencho does not confirm Docker access', async () => {
    const f = staged(fake());
    const outcome = await replaceProvider(plan({ scope: 'provider' }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', rollback: { attempted: true, restored: true, error: null } });
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.created).toHaveLength(1);
    // A restored endpoint must not leave the "replacement installed" marker
    // behind for a later Sencho to acknowledge.
    expect(f.files.has(helperFiles.recreated(HELPER_DATA_DIR, OP))).toBe(false);
    expect(f.removedFiles).toContain(helperFiles.recreated(HELPER_DATA_DIR, OP));
    expect(f.composeCalls).toEqual([
      ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '60', 'socket-proxy'],
    ]);
  });

  it('accepts an ack that arrives late but inside the deadline', async () => {
    const f = staged(fake({ onSleep: ackAt(170_000) }));
    expect((await replaceProvider(plan(), f.deps)).ok).toBe(true);
  });

  it('prunes dangling images only after a verified success, and only when enabled', async () => {
    const enabled = staged(fake({ onSleep: ackAt(10_000) }));
    await replaceProvider(plan({ pruneOnUpdate: true }), enabled.deps);
    expect(enabled.pruned).toEqual(['dangling']);
    const failed = staged(fake());
    await replaceProvider(plan({ pruneOnUpdate: true }), failed.deps);
    expect(failed.pruned).toEqual([]);
  });

  it('restores the previous provider when its recreate fails (unhealthy or bad config) and never touches Sencho', async () => {
    const f = staged(fake({ compose: { 'up:socket-proxy': { ok: false, output: 'container stack-socket-proxy-1 is unhealthy' } } }));
    const outcome = await replaceProvider(plan(), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'provider', rollback: { restored: true, error: null } });
    expect(f.composeCalls.some(args => args.includes('sencho'))).toBe(false);
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.created[0]).toMatchObject({ name: 'stack-socket-proxy-1', Image: 'sha256:previous' });
    expect(f.files.get(outcomePath)).toMatchObject({ ok: false, phase: 'provider' });
  });

  it('restores the provider when recreating Sencho fails', async () => {
    const f = staged(fake({ compose: { 'up:sencho': { ok: false, output: 'pull access denied' } } }));
    const outcome = await replaceProvider(plan(), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'sencho', rollback: { restored: true } });
  });

  it('restores the provider when the new Sencho never confirms Docker access (missing ack)', async () => {
    const f = staged(fake());
    const outcome = await replaceProvider(plan({ ackSeconds: 30 }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', error: expect.stringContaining('within 30 seconds'), rollback: { restored: true } });
  });

  it('treats an ack that arrives after the deadline as missing', async () => {
    const f = staged(fake({ onSleep: ackAt(40_000) }));
    const outcome = await replaceProvider(plan({ ackSeconds: 30 }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify' });
  });

  it('restores the provider when the new Sencho reports Docker unreachable through it', async () => {
    const f = staged(fake({ onSleep: ackAt(10_000, false) }));
    const outcome = await replaceProvider(plan(), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', error: expect.stringContaining('ping refused'), rollback: { restored: true } });
  });

  it('ignores an ack written for another operation', async () => {
    const f = staged(fake({ onSleep: (files) => files.set(ackPath, { operationId: 'other', ok: true, detail: null }) }));
    expect((await replaceProvider(plan({ ackSeconds: 10 }), f.deps)).ok).toBe(false);
  });

  it('reports recovery required when the rollback itself fails', async () => {
    const f = staged(fake({
      compose: { 'up:socket-proxy': { ok: false, output: 'boom' } },
      create: async () => { throw new Error('image sha256:previous not found'); },
    }));
    const outcome = await replaceProvider(plan(), f.deps);
    expect(outcome).toMatchObject({ ok: false, rollback: { restored: false, error: 'image sha256:previous not found' } });
    expect(f.files.get(outcomePath)).toMatchObject({ rollback: { restored: false } });
  });

  it('reports recovery required when the restored container does not come up', async () => {
    const f = staged(fake({
      compose: { 'up:socket-proxy': { ok: false, output: 'boom' } },
      inspect: (id) => (id === 'restored-id' ? snapshot({ Id: 'restored-id', State: { Running: false, Status: 'exited' } }) : snapshot()),
    }));
    const outcome = await replaceProvider(plan({ providerReadySeconds: 6 }), f.deps);
    expect(outcome).toMatchObject({ ok: false, rollback: { restored: false, error: expect.stringContaining('exited') } });
  });

  it('reports recovery required when the snapshot is missing', async () => {
    const f = fake({ compose: { 'up:socket-proxy': { ok: false, output: 'boom' } } });
    const outcome = await replaceProvider(plan(), f.deps);
    expect(outcome).toMatchObject({ ok: false, rollback: { restored: false, error: 'the rollback snapshot is missing' } });
  });

  it('copies a staged Sencho repin before recreating and stops untouched when the copy fails', async () => {
    const ok = staged(fake({ onSleep: ackAt(5_000) }));
    ok.files.set('/app/data/.sencho-compose-patch', 'patched');
    await replaceProvider(plan({ mode: 'update', composeCopy: { stagedPath: '/app/data/.sencho-compose-patch', targetPath: '/srv/stack/compose.yaml' } }), ok.deps);
    expect(ok.files.get('/srv/stack/compose.yaml')).toBe('patched');

    const failing = staged(fake());
    failing.deps.copyFile = async () => { throw new Error('read-only file system'); };
    const outcome = await replaceProvider(plan({ composeCopy: { stagedPath: 'a', targetPath: 'b' } }), failing.deps);
    expect(outcome).toMatchObject({
      ok: false,
      phase: 'provider',
      error: expect.stringContaining('read-only'),
      rollback: { attempted: false },
    });
    expect(failing.composeCalls).toEqual([]);
    expect(failing.removed).toEqual([]);
    expect(failing.created).toEqual([]);
  });

  it.each(['provider', 'stack'] as const)(
    'restores the snapshot when publishing the recreation marker fails after the %s-scope replacement',
    async (scope) => {
      const f = staged(fake());
      const writeJson = f.deps.writeJson;
      f.deps.writeJson = async (path, value) => {
        if (path === helperFiles.recreated(HELPER_DATA_DIR, OP)) throw new Error('ENOSPC: no space left on device');
        await writeJson(path, value);
      };
      const outcome = await replaceProvider(plan({ scope }), f.deps);
      expect(outcome).toMatchObject({
        ok: false,
        phase: 'verify',
        error: expect.stringContaining('ENOSPC'),
        rollback: { restored: true, error: null },
      });
      expect(f.removed).toEqual(['new-proxy-id']);
      expect(f.created).toHaveLength(1);
      expect(f.created[0]).toMatchObject({ name: 'stack-socket-proxy-1', Image: 'sha256:previous' });
      expect(f.files.get(outcomePath)).toMatchObject({ ok: false, rollback: { restored: true } });
      expect(f.composeCalls.some(args => args.includes('sencho'))).toBe(false);
    },
  );

  it('restores the snapshot when the marker fails after a repin copy was applied', async () => {
    const f = staged(fake());
    f.files.set('/app/data/.sencho-compose-patch', 'patched');
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = async (path, value) => {
      if (path === helperFiles.recreated(HELPER_DATA_DIR, OP)) throw new Error('ENOSPC: no space left on device');
      await writeJson(path, value);
    };
    const outcome = await replaceProvider(plan({
      mode: 'update',
      composeCopy: { stagedPath: '/app/data/.sencho-compose-patch', targetPath: '/srv/stack/compose.yaml' },
    }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', rollback: { restored: true } });
    expect(f.files.get('/srv/stack/compose.yaml')).toBe('patched');
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.created).toHaveLength(1);
  });

  it('restores the snapshot when the failure outcome cannot be written', async () => {
    const f = staged(fake());
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = async (path, value) => {
      if (path === outcomePath) throw new Error('ENOSPC: no space left on device');
      await writeJson(path, value);
    };
    const outcome = await replaceProvider(plan({ scope: 'provider', ackSeconds: 10 }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', rollback: { restored: true, error: null } });
    // Recovery does not depend on the verdict file: the old container is back,
    // and the stale "replacement installed" marker is gone even though the
    // outcome could not be published.
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.created).toHaveLength(1);
    expect(f.files.has(outcomePath)).toBe(false);
    expect(f.files.has(helperFiles.recreated(HELPER_DATA_DIR, OP))).toBe(false);
    expect(f.log).toContainEqual(expect.stringContaining('could not write the outcome file'));
  });

  it('recovers when a verified success cannot publish its outcome', async () => {
    const f = staged(fake({ onSleep: ackAt(10_000) }));
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = async (path, value) => {
      if (path === outcomePath) throw new Error('ENOSPC: no space left on device');
      await writeJson(path, value);
    };
    const outcome = await replaceProvider(plan({ scope: 'provider' }), f.deps);
    expect(outcome).toMatchObject({
      ok: false,
      phase: 'verify',
      error: expect.stringContaining('could not be recorded'),
      rollback: { restored: true, error: null },
    });
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.created).toHaveLength(1);
  });

  it('restores the snapshot when reading the ack throws after the replacement', async () => {
    const f = staged(fake());
    const readJson = f.deps.readJson;
    f.deps.readJson = async (path) => {
      if (path === ackPath) throw new Error('EIO: read failed');
      return readJson(path);
    };
    const outcome = await replaceProvider(plan({ scope: 'provider', ackSeconds: 10 }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', error: expect.stringContaining('EIO'), rollback: { attempted: true, restored: true } });
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.created).toHaveLength(1);
  });

  it('restores the provider after an ack-read exception in stack scope once Sencho was recreated', async () => {
    const f = staged(fake());
    const readJson = f.deps.readJson;
    f.deps.readJson = async (path) => {
      if (path === ackPath) throw new Error('EIO: read failed');
      return readJson(path);
    };
    const outcome = await replaceProvider(plan({ ackSeconds: 10 }), f.deps);
    expect(outcome).toMatchObject({ ok: false, phase: 'verify', error: expect.stringContaining('EIO'), rollback: { attempted: true, restored: true } });
    expect(f.composeCalls).toContainEqual(['up', '-d', '--no-deps', '--force-recreate', 'sencho']);
    expect(f.removed).toEqual(['new-proxy-id']);
    expect(f.files.has(helperFiles.recreated(HELPER_DATA_DIR, OP))).toBe(false);
    expect(f.removedFiles).toContain(helperFiles.recreated(HELPER_DATA_DIR, OP));
  });
});

describe('createOptionsFromSnapshot', () => {
  it('recreates by image ID with the old name, config and host config, dropping the old short id', () => {
    const { options, extraNetworks } = createOptionsFromSnapshot(snapshot({ Id: 'old-proxy-id-0000000000', Config: { ...snapshot().Config, Hostname: 'old-proxy-id' } }));
    expect(options).toMatchObject({
      name: 'stack-socket-proxy-1',
      Image: 'sha256:previous',
      Env: ['CONTAINERS=1'],
      HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'] },
      NetworkingConfig: { EndpointsConfig: { stack_default: { Aliases: ['socket-proxy'] } } },
    });
    expect(options).not.toHaveProperty('Hostname');
    expect((options.Labels as Record<string, string>)['com.docker.compose.service']).toBe('socket-proxy');
    expect(extraNetworks).toEqual([['stack_edge', { Aliases: ['proxy'], IPAMConfig: { IPv4Address: '172.30.0.9' } }]]);
  });

  it('keeps an explicit hostname', () => {
    const { options } = createOptionsFromSnapshot(snapshot({ Config: { ...snapshot().Config, Hostname: 'docker-proxy' } }));
    expect(options.Hostname).toBe('docker-proxy');
  });
});

describe('parseOutcome', () => {
  it('accepts only an outcome for the same operation', () => {
    expect(parseOutcome({ operationId: OP, ok: true }, OP)).toEqual({ operationId: OP, ok: true });
    expect(parseOutcome({ operationId: 'other', ok: true }, OP)).toBeNull();
    expect(parseOutcome({ operationId: OP }, OP)).toBeNull();
    expect(parseOutcome(null, OP)).toBeNull();
  });

  it('reads a failure without a rollback flag as attempted and not restored', () => {
    expect(parseOutcome({ operationId: OP, ok: false, error: 'x' }, OP)).toEqual({
      operationId: OP, ok: false, phase: 'provider', error: 'x', rollback: { attempted: true, restored: false, error: null },
    });
  });

  it('keeps a replacement that never reached rollback as not attempted', () => {
    expect(parseOutcome({ operationId: OP, ok: false, error: 'x', rollback: { attempted: false } }, OP)).toEqual({
      operationId: OP, ok: false, phase: 'provider', error: 'x', rollback: { attempted: false },
    });
  });

  it('recognises the legacy explicit "not attempted" marker', () => {
    expect(parseOutcome({ operationId: OP, ok: false, error: 'x', rollback: { restored: false, error: 'not attempted' } }, OP)).toEqual({
      operationId: OP, ok: false, phase: 'provider', error: 'x', rollback: { attempted: false },
    });
  });
});
