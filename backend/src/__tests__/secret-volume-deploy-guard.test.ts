/**
 * The secret volume deploy guard. A Compose stack whose model reaches a volume
 * that holds a secret Sencho keeps on the node is refused before Compose runs:
 * by the reserved name, by the reserved label, by a volume the node labels, or
 * by `volumes_from` / `pid` naming a container that mounts one. The stack Sencho
 * recorded as the secret's consumer is exempt.
 *
 * The evaluator is covered as a pure function first. The ComposeService entry
 * points then run against a real database and real stack files, with Docker
 * faked at the process boundary: every `docker` spawn is answered by the test
 * (a `config` render returns the model the test chose) and the Docker API
 * answers the volume and container lists.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { makeRenderProc } from './helpers/mockComposeRender';
import { parseEffectiveModel } from '../services/preflight/effectiveModel';
import {
  evaluateSecretVolumeUse,
  modelReferencesContainers,
  type SecretVolumeNodeFacts,
} from '../services/preflight/secretVolumeUse';
import { SecretVolumeProtectedError } from '../helpers/secretVolume';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { LicenseService } from '../services/LicenseService';

const h = vi.hoisted(() => ({
  /** Answers every `docker` spawn while set; other commands run for real. */
  fakeDocker: null as null | ((args: string[]) => unknown),
  /** Whether the stand-in endpoint guard reads the render it is handed, as the real one does. */
  endpointReadsRender: true,
  endpointRenderReads: 0,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  function spawn(command: string, args: readonly string[] = [], options: import('child_process').SpawnOptions = {}) {
    if (command === 'docker' && h.fakeDocker) return h.fakeDocker([...args]);
    return actual.spawn(command, [...args], options);
  }
  return { ...actual, default: { ...actual, spawn }, spawn };
});

// The Docker endpoint guard has its own suites. Here it stands in as a reader of
// the render it is handed, so the tests can see whether both guards share one.
vi.mock('../helpers/dockerEndpointGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers/dockerEndpointGuard')>();
  return {
    ...actual,
    evaluateDockerEndpointGuard: async (input: Parameters<typeof actual.evaluateDockerEndpointGuard>[0]) => {
      if (h.endpointReadsRender) {
        h.endpointRenderReads += 1;
        await input.probes.renderConfig();
      }
      return null;
    },
  };
});

// The external network check renders the stack on its own and reads Docker
// networks; it runs after both guards and is not what these tests observe.
vi.mock('../services/network/resolveMissingExternalNetworks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/network/resolveMissingExternalNetworks')>()),
  resolveMissingExternalNetworks: async () => ({
    status: 'ok', autoCreateEnabled: false, stackName: '', networks: [], declaredExternalCount: 0,
  }),
}));

// The labels dry run runs the policy gate first; an allowing gate lets it reach the guards.
vi.mock('../services/PolicyEnforcement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/PolicyEnforcement')>()),
  enforcePolicyPreDeploy: async () => ({ ok: true }),
}));

const SECRET_VOLUME = 'sencho_edge_secret';
const CONSUMER_ID = 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890';

type Rendered = Record<string, unknown>;

/** The rendered model of an ordinary stack: one named volume, no secret anywhere. */
function ordinary(project: string): Rendered {
  return {
    name: project,
    services: { web: { image: 'alpine:3.20', volumes: [{ type: 'volume', source: 'data', target: '/data' }] } },
    volumes: { data: { name: `${project}_data` } },
  };
}

/** The rendered model of a stack that mounts the reserved secret volume. */
function reachesReserved(project: string): Rendered {
  return {
    name: project,
    services: { web: { image: 'alpine:3.20', volumes: [{ type: 'volume', source: 'secret', target: '/run/secret' }] } },
    volumes: { secret: { name: SECRET_VOLUME, external: true } },
  };
}

function modelOf(rendered: Rendered) {
  return parseEffectiveModel(rendered, 'proj');
}

const NO_FACTS: SecretVolumeNodeFacts = { labelledVolumeNames: new Set(), consumers: null };
const CONSUMER = { id: CONSUMER_ID, names: ['edge-consumer'] };

describe('evaluateSecretVolumeUse', () => {
  function withService(service: Record<string, unknown>, volumes: Record<string, unknown> = {}): Rendered {
    return { name: 'proj', services: { app: { image: 'alpine:3.20', ...service } }, volumes };
  }

  it('finds the reserved name, declared or external', () => {
    expect(evaluateSecretVolumeUse(modelOf(withService({}, { secret: { name: SECRET_VOLUME } })), NO_FACTS))
      .toEqual([{ kind: 'reserved-name', volumeKey: 'secret', volumeName: SECRET_VOLUME }]);
    expect(evaluateSecretVolumeUse(modelOf(withService({}, { edge: { name: SECRET_VOLUME, external: true } })), NO_FACTS))
      .toEqual([{ kind: 'reserved-name', volumeKey: 'edge', volumeName: SECRET_VOLUME }]);
  });

  it('finds the reserved label in map and list form, whatever its value', () => {
    const declared = [
      { name: 'proj_data', labels: { 'io.sencho.secret': 'edge-tunnel-run-token' } },
      { name: 'proj_data', labels: ['io.sencho.secret=edge-tunnel-run-token'] },
      { name: 'proj_data', labels: ['io.sencho.secret'] },
      { name: 'proj_data', labels: { 'io.sencho.secret': '' } },
    ];
    for (const volume of declared) {
      expect(evaluateSecretVolumeUse(modelOf(withService({}, { data: volume })), NO_FACTS))
        .toEqual([{ kind: 'declared-label', volumeKey: 'data', volumeName: 'proj_data' }]);
    }
  });

  it('does not take a label that only contains the reserved key for it', () => {
    const volumes = { data: { name: 'proj_data', labels: { 'io.sencho.secret.note': 'x', 'com.example': 'io.sencho.secret' } } };
    expect(evaluateSecretVolumeUse(modelOf(withService({}, volumes)), NO_FACTS)).toEqual([]);
  });

  it('reports one finding per volume, the reserved name first', () => {
    const volumes = { secret: { name: SECRET_VOLUME, labels: { 'io.sencho.secret': 'x' } } };
    expect(evaluateSecretVolumeUse(modelOf(withService({}, volumes)), {
      labelledVolumeNames: new Set([SECRET_VOLUME]), consumers: null,
    })).toEqual([{ kind: 'reserved-name', volumeKey: 'secret', volumeName: SECRET_VOLUME }]);
  });

  it('finds a volume whose resolved name the node labels as a secret volume', () => {
    const rendered = withService({}, { creds: { name: 'tunnel_creds', external: true } });
    expect(evaluateSecretVolumeUse(modelOf(rendered), { labelledVolumeNames: new Set(['tunnel_creds']), consumers: null }))
      .toEqual([{ kind: 'labelled-volume', volumeKey: 'creds', volumeName: 'tunnel_creds' }]);
    expect(evaluateSecretVolumeUse(modelOf(rendered), { labelledVolumeNames: new Set(['other']), consumers: null })).toEqual([]);
  });

  it('finds volumes_from naming a consumer, with or without an access mode', () => {
    const facts = { labelledVolumeNames: new Set<string>(), consumers: [CONSUMER] };
    for (const ref of ['container:edge-consumer', 'container:edge-consumer:ro', 'container:edge-consumer:rw']) {
      expect(evaluateSecretVolumeUse(modelOf(withService({ volumes_from: [ref] })), facts))
        .toEqual([{ kind: 'volumes-from', service: 'app', container: 'edge-consumer' }]);
    }
  });

  it('finds a consumer named with a leading slash, as the daemon resolves it', () => {
    const facts = { labelledVolumeNames: new Set<string>(), consumers: [CONSUMER] };
    expect(evaluateSecretVolumeUse(modelOf(withService({ volumes_from: ['container:/edge-consumer'] })), facts))
      .toEqual([{ kind: 'volumes-from', service: 'app', container: '/edge-consumer' }]);
    expect(evaluateSecretVolumeUse(modelOf(withService({ pid: 'container:/edge-consumer' })), facts))
      .toEqual([{ kind: 'pid', service: 'app', container: '/edge-consumer' }]);
  });

  it('finds pid naming a consumer by name and by id prefix', () => {
    const facts = { labelledVolumeNames: new Set<string>(), consumers: [CONSUMER] };
    expect(evaluateSecretVolumeUse(modelOf(withService({ pid: 'container:edge-consumer' })), facts))
      .toEqual([{ kind: 'pid', service: 'app', container: 'edge-consumer' }]);
    expect(evaluateSecretVolumeUse(modelOf(withService({ pid: 'container:abc123' })), facts))
      .toEqual([{ kind: 'pid', service: 'app', container: 'abc123' }]);
    expect(evaluateSecretVolumeUse(modelOf(withService({ volumes_from: ['container:ABC123DEF'] })), facts))
      .toEqual([{ kind: 'volumes-from', service: 'app', container: 'ABC123DEF' }]);
  });

  it('leaves alone a container that is not a consumer, a service reference, and a non-container pid', () => {
    const facts = { labelledVolumeNames: new Set<string>(), consumers: [CONSUMER] };
    const rendered = {
      name: 'proj',
      services: {
        a: { image: 'alpine:3.20', volumes_from: ['container:other', 'db'], pid: 'host' },
        b: { image: 'alpine:3.20', pid: 'container:def456' },
        // A name is not an id prefix, even when it is a prefix of a consumer's name.
        c: { image: 'alpine:3.20', volumes_from: ['container:edge'] },
      },
    };
    expect(evaluateSecretVolumeUse(modelOf(rendered), facts)).toEqual([]);
  });

  it('reports no container findings when consumers were not read', () => {
    const rendered = withService({ volumes_from: ['container:edge-consumer'], pid: 'container:edge-consumer' });
    expect(evaluateSecretVolumeUse(modelOf(rendered), NO_FACTS)).toEqual([]);
    expect(evaluateSecretVolumeUse(modelOf(rendered), { labelledVolumeNames: new Set(), consumers: [] })).toEqual([]);
  });

  it('finds nothing in an ordinary model, even with consumers on the node', () => {
    expect(evaluateSecretVolumeUse(modelOf(ordinary('proj')), {
      labelledVolumeNames: new Set(['tunnel_creds']), consumers: [CONSUMER],
    })).toEqual([]);
  });

  it('modelReferencesContainers is true only for a container: reference in volumes_from or pid', () => {
    expect(modelReferencesContainers(modelOf(withService({ volumes_from: ['container:x'] })))).toBe(true);
    expect(modelReferencesContainers(modelOf(withService({ volumes_from: ['container:x:ro'] })))).toBe(true);
    expect(modelReferencesContainers(modelOf(withService({ pid: 'container:x' })))).toBe(true);
    expect(modelReferencesContainers(modelOf(withService({ volumes_from: ['db', 'db:ro'], pid: 'host' })))).toBe(false);
    expect(modelReferencesContainers(modelOf(withService({ pid: 'container:' })))).toBe(false);
    expect(modelReferencesContainers(modelOf(ordinary('proj')))).toBe(false);
  });
});

describe('ComposeService secret volume guard', () => {
  let tmpDir: string;
  let composeDir: string;
  let nodeId: number;
  let app: import('express').Express;
  let cookie: string;

  /** What a `config` render answers for the given argv; null exits 1 with no model. */
  let renderFor: (args: string[]) => Rendered | null;
  /** Exit code of a `compose up`; a failing up stops a deploy before its post-deploy steps. */
  let upExit: number;
  /** Docker spawns and API list calls, in order. */
  let events: string[];
  let dockerSpawns: string[][];
  let labelledVolumes: string[];
  let containers: Array<{ Id: string; Names: string[]; Mounts: Array<{ Type: string; Name?: string }> }>;
  let listVolumes: ReturnType<typeof vi.fn>;
  let listContainers: ReturnType<typeof vi.fn>;

  const configSpawns = () => dockerSpawns.filter((args) => args.includes('config'));
  const mutations = () => dockerSpawns.filter((args) => !args.includes('config'));
  /** Events before the first Compose mutation, or all of them when none ran. */
  const beforeMutation = () => {
    const first = events.findIndex((event) => event.startsWith('mutation:'));
    return first === -1 ? events : events.slice(0, first);
  };
  /** Events while the secret volume check ran (the first run, when there were several). */
  const duringSecretCheck = () => events.slice(events.indexOf('secret-check:start') + 1, events.indexOf('secret-check:end'));
  /** What each secret volume check answered: null for a pass, else the refusal. */
  let secretVerdicts: Array<string | null>;

  function writeStack(name: string, files: Record<string, string> = {}): string {
    const dir = path.join(composeDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: alpine:3.20\n');
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
    return dir;
  }

  function recordManagedKind(stackName: string, kind: string) {
    DatabaseService.getInstance().getDb()
      .prepare('INSERT OR REPLACE INTO managed_stacks (stack_name, kind, template_version, created_at) VALUES (?, ?, ?, ?)')
      .run(stackName, kind, null, Date.now());
  }

  async function failureOf(run: Promise<unknown>): Promise<unknown> {
    return run.then(() => null, (error: unknown) => error);
  }

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    const local = DatabaseService.getInstance().getDefaultNode();
    if (!local?.id) throw new Error('missing default node');
    nodeId = local.id;
    ({ app } = await import('../index'));
    cookie = await loginAsTestAdmin(app);
  });

  afterAll(() => {
    h.fakeDocker = null;
    cleanupTestDb(tmpDir);
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderFor = () => null;
    upExit = 1;
    events = [];
    dockerSpawns = [];
    labelledVolumes = [];
    containers = [];
    h.endpointReadsRender = true;
    h.endpointRenderReads = 0;
    h.fakeDocker = (args) => {
      dockerSpawns.push(args);
      if (args.includes('config')) {
        events.push('config');
        const rendered = renderFor(args);
        return makeRenderProc(rendered === null ? '' : JSON.stringify(rendered), rendered === null ? 1 : 0);
      }
      events.push(`mutation:${args.find((arg) => ['up', 'down', 'pull', 'build'].includes(arg)) ?? args.join(' ')}`);
      return makeRenderProc('', args.includes('up') ? upExit : 0);
    };
    listVolumes = vi.fn(async () => {
      events.push('listVolumes');
      return { Volumes: labelledVolumes.map((Name) => ({ Name })), Warnings: [] };
    });
    listContainers = vi.fn(async () => {
      events.push('listContainers');
      return containers;
    });
    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({ listVolumes, listContainers } as unknown as Docker);
    // Probing the Compose version is a spawn of its own; it is not under test.
    vi.spyOn(ComposeService.prototype, 'composeVersion').mockResolvedValue(null);
    // Observed, not replaced: marks when the check ran and records its answer.
    secretVerdicts = [];
    const evaluate = ComposeService.prototype.evaluateSecretVolumeUse;
    vi.spyOn(ComposeService.prototype, 'evaluateSecretVolumeUse').mockImplementation(async function (
      this: ComposeService,
      ...args: Parameters<ComposeService['evaluateSecretVolumeUse']>
    ) {
      events.push('secret-check:start');
      try {
        const verdict = await evaluate.apply(this, args);
        secretVerdicts.push(verdict);
        return verdict;
      } finally {
        events.push('secret-check:end');
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM managed_stacks').run();
  });

  const svc = () => ComposeService.getInstance(nodeId);

  type EntryPoint = [string, (stack: string) => Promise<unknown>];
  const ENTRY_POINTS: EntryPoint[] = [
    ['deployStack', (stack) => svc().deployStack(stack)],
    ['updateStack', (stack) => svc().updateStack(stack)],
    ['updateService', (stack) => svc().updateService(stack, 'web', false)],
    ['recreateServiceFromLocal', (stack) => svc().recreateServiceFromLocal(stack, 'web')],
    ['composeUpWithRecoveryOverride', (stack) => svc().composeUpWithRecoveryOverride(
      stack,
      path.join(composeDir, stack, '.sencho-recovery-aaaaaaaaaaaa.yml'),
    )],
  ];

  /** A stack with the recovery layer the recovery up names, so every entry point can render it. */
  function writeEntryStack(stack: string) {
    writeStack(stack, { '.sencho-recovery-aaaaaaaaaaaa.yml': 'services:\n  web:\n    image: alpine:3.20\n' });
  }

  describe.each(ENTRY_POINTS)('%s', (entry, run) => {
    const stack = `guard-${entry.toLowerCase()}`;
    beforeEach(() => writeEntryStack(stack));

    it('refuses a stack that reaches the reserved volume before Compose mutates anything', async () => {
      renderFor = () => reachesReserved(stack);

      const error = await failureOf(run(stack));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect(error).toMatchObject({ code: 'secret_volume_protected', status: 423 });
      expect((error as Error).message).toContain(`Sencho refused to run "${stack}" because it would reach a secret volume.`);
      expect((error as Error).message).toContain(`"${SECRET_VOLUME}"`);
      expect(mutations()).toEqual([]);
    });

    it.each(['edge-tunnel', 'released-edge-tunnel'])('lets the recorded %s consumer through', async (kind) => {
      renderFor = () => reachesReserved(stack);
      recordManagedKind(stack, kind);

      const error = await failureOf(run(stack));

      expect(error).not.toBeInstanceOf(SecretVolumeProtectedError);
      expect(mutations().length).toBeGreaterThan(0);
      // An exempt stack is not checked, so the node is not read either.
      expect(listVolumes).not.toHaveBeenCalled();
    });

    it('does not exempt any other managed kind', async () => {
      renderFor = () => reachesReserved(stack);
      recordManagedKind(stack, 'gitops-blueprint');

      expect(await failureOf(run(stack))).toBeInstanceOf(SecretVolumeProtectedError);
      expect(mutations()).toEqual([]);
    });

    it('refuses when the render cannot be read, saying it could not verify', async () => {
      // The endpoint guard would refuse an unreadable render first; here it does
      // not read it, so the secret guard's own answer is what reaches the caller.
      h.endpointReadsRender = false;
      renderFor = () => null;

      const error = await failureOf(run(stack));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain(`Sencho could not verify that "${stack}" does not reach a secret volume on this node`);
      expect((error as Error).message).toContain('(docker compose config failed with code 1)');
      expect(mutations()).toEqual([]);
    });

    it('lets an ordinary stack through without listing containers', async () => {
      renderFor = () => ordinary(stack);

      const error = await failureOf(run(stack));

      expect(error).not.toBeInstanceOf(SecretVolumeProtectedError);
      // A failed update compensates with a recovery up, which checks again.
      expect(secretVerdicts.length).toBeGreaterThan(0);
      expect(secretVerdicts.filter((verdict) => verdict !== null)).toEqual([]);
      expect(mutations().length).toBeGreaterThan(0);
      expect(duringSecretCheck()).toContain('listVolumes');
      expect(duringSecretCheck()).not.toContain('listContainers');
    });
  });

  describe('what the guard reads from the node', () => {
    const stack = 'guard-node-facts';
    beforeEach(() => writeStack(stack));

    it('lists only volumes carrying the secret label, and refuses a stack that declares one by its name', async () => {
      labelledVolumes = ['tunnel_creds'];
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20', volumes: [{ type: 'volume', source: 'creds', target: '/creds' }] } },
        volumes: { creds: { name: 'tunnel_creds', external: true } },
      });

      const error = await failureOf(svc().deployStack(stack));

      expect(listVolumes).toHaveBeenCalledWith({ filters: { label: ['io.sencho.secret'] } });
      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('The volume "tunnel_creds" holds a secret Sencho keeps on this node.');
      expect(mutations()).toEqual([]);
    });

    it('refuses a stack that declares the reserved label on a volume of its own', async () => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { lookalike: { name: `${stack}_lookalike`, labels: { 'io.sencho.secret': 'edge-tunnel-run-token' } } },
      });

      const error = await failureOf(svc().deployStack(stack));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('declares the label io.sencho.secret');
    });

    it('refuses volumes_from and pid naming a container that mounts a secret volume, and reads containers only then', async () => {
      containers = [
        { Id: CONSUMER_ID, Names: ['/edge-consumer'], Mounts: [{ Type: 'volume', Name: SECRET_VOLUME }] },
        { Id: 'f'.repeat(64), Names: ['/bystander'], Mounts: [{ Type: 'volume', Name: 'other_data' }, { Type: 'bind' }] },
      ];
      renderFor = () => ({
        name: stack,
        services: {
          web: { image: 'alpine:3.20', volumes_from: ['container:edge-consumer:ro'] },
          sidecar: { image: 'alpine:3.20', pid: 'container:abc123def' },
        },
      });

      const error = await failureOf(svc().deployStack(stack));

      expect(listContainers).toHaveBeenCalledWith({ all: true });
      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('Service "web" takes the volumes of container "edge-consumer"');
      expect((error as Error).message).toContain('Service "sidecar" joins the process namespace of container "abc123def"');
      expect(mutations()).toEqual([]);
    });

    it('counts a container mounting a labelled volume as a consumer, and lets a reference to a bystander through', async () => {
      labelledVolumes = ['tunnel_creds'];
      containers = [
        { Id: CONSUMER_ID, Names: ['/edge-consumer'], Mounts: [{ Type: 'volume', Name: 'tunnel_creds' }] },
        { Id: 'f'.repeat(64), Names: ['/bystander'], Mounts: [{ Type: 'volume', Name: 'other_data' }] },
      ];
      renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20', volumes_from: ['container:edge-consumer'] } } });
      expect(await failureOf(svc().deployStack(stack))).toBeInstanceOf(SecretVolumeProtectedError);

      dockerSpawns = [];
      renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20', volumes_from: ['container:bystander'] } } });
      expect(await failureOf(svc().deployStack(stack))).not.toBeInstanceOf(SecretVolumeProtectedError);
      expect(mutations().length).toBeGreaterThan(0);
    });

    it('refuses when the volume list cannot be read', async () => {
      listVolumes.mockRejectedValueOnce(new Error('connect ECONNREFUSED /var/run/docker.sock'));
      renderFor = () => ordinary(stack);

      const error = await failureOf(svc().deployStack(stack));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('could not verify');
      expect(mutations()).toEqual([]);
    });
  });

  it('shares one render between the endpoint guard and the secret guard on a deploy', async () => {
    const stack = 'guard-one-render';
    writeStack(stack);
    renderFor = () => ordinary(stack);
    // The required-variable check renders on its own (it reads Compose's
    // diagnostics), so it is turned off here to count only the guards' render.
    const db = DatabaseService.getInstance();
    const envBlock = db.getGlobalSettings()['env_block_deploy_on_missing_required'];
    db.updateGlobalSetting('env_block_deploy_on_missing_required', '0');
    try {
      const error = await failureOf(svc().deployStack(stack));

      expect(error).not.toBeInstanceOf(SecretVolumeProtectedError);
      expect(h.endpointRenderReads).toBe(1);
      expect(listVolumes).toHaveBeenCalledTimes(1);
      expect(mutations().some((args) => args.includes('up'))).toBe(true);
      expect(beforeMutation().filter((event) => event === 'config')).toHaveLength(1);
      expect(configSpawns()).toHaveLength(1);
    } finally {
      db.updateGlobalSetting('env_block_deploy_on_missing_required', envBlock ?? '1');
    }
  });

  describe('a recovery up', () => {
    const stack = 'guard-recovery-captured';
    const overrideFile = '.sencho-recovery-bbbbbbbbbbbb.yml';
    const captured = {
      composeArgsPrefix: ['-f', 'compose.captured.yaml'],
      projectDirectory: null,
      projectName: stack,
      explicitComposeFiles: ['compose.captured.yaml'],
      meshEnabled: false,
    };
    const rendersCaptured = (args: string[]) => args.some((arg) => arg.endsWith('compose.captured.yaml'));

    beforeEach(() => {
      writeStack(stack, {
        'compose.captured.yaml': 'services:\n  web:\n    image: alpine:3.20\n',
        [overrideFile]: 'services:\n  web:\n    image: alpine:3.20\n',
      });
      // The current files are ordinary; the captured generation reached the secret volume.
      renderFor = (args) => (rendersCaptured(args) ? reachesReserved(stack) : ordinary(stack));
    });

    it('is refused when its captured file set reaches the volume, though the current files do not', async () => {
      const error = await failureOf(svc().composeUpWithRecoveryOverride(
        stack, path.join(composeDir, stack, overrideFile), undefined, captured,
      ));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain(`"${SECRET_VOLUME}"`);
      // The secret guard rendered the captured invocation, with the recovery layer last.
      const rendered = configSpawns().filter(rendersCaptured);
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered[rendered.length - 1].some((arg) => arg.endsWith(overrideFile))).toBe(true);
      expect(mutations()).toEqual([]);
    });

    it('runs from the current files when no invocation was captured', async () => {
      upExit = 0;

      await svc().composeUpWithRecoveryOverride(stack, path.join(composeDir, stack, overrideFile));

      expect(configSpawns().some(rendersCaptured)).toBe(false);
      expect(mutations().some((args) => args.includes('up'))).toBe(true);
    });
  });

  describe('down --volumes', () => {
    const stack = 'guard-down-volumes';
    beforeEach(() => writeStack(stack));

    it.each(['runDown', 'downStack'] as const)('%s refuses to remove the volumes of a stack declaring the reserved volume', async (method) => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { secret: { name: SECRET_VOLUME } },
      });

      const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('so its volumes were not removed');
      expect(mutations()).toEqual([]);
    });

    it('refuses a stack declaring the reserved label the same way', async () => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { lookalike: { name: `${stack}_lookalike`, labels: ['io.sencho.secret=x'] } },
      });

      expect(await failureOf(svc().runDown(stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
      expect(mutations()).toEqual([]);
    });

    it('takes the stack down when volumes are kept, and removes them for the recorded consumer', async () => {
      renderFor = () => reachesReserved(stack);

      await svc().runDown(stack);
      expect(mutations()).toEqual([expect.arrayContaining(['down'])]);
      expect(mutations()[0]).not.toContain('--volumes');

      dockerSpawns = [];
      recordManagedKind(stack, 'edge-tunnel');
      await svc().runDown(stack, { removeVolumes: true });
      expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
    });
  });

  describe('POST /api/labels/:id/action dry-run deploy', () => {
    const stack = 'guard-labels-dry';
    let labelId: number;

    beforeEach(async () => {
      writeStack(stack);
      vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
      const { StackOpLockService } = await import('../services/StackOpLockService');
      StackOpLockService.resetForTests();
      const created = await request(app).post('/api/labels').set('Cookie', cookie)
        .send({ name: `secret-guard-${Date.now()}`, color: 'teal' });
      expect(created.status).toBe(201);
      labelId = created.body.id;
      const assigned = await request(app).put(`/api/stacks/${stack}/labels`).set('Cookie', cookie)
        .send({ labelIds: [labelId] });
      expect(assigned.status).toBe(200);
    });

    it('reports the refusal the real deploy would give, from one render, without running Compose', async () => {
      renderFor = () => reachesReserved(stack);

      const res = await request(app).post(`/api/labels/${labelId}/action`).set('Cookie', cookie)
        .send({ action: 'deploy', dryRun: true });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { stackName: stack, success: false, dryRun: true, error: expect.stringContaining(`"${SECRET_VOLUME}"`) },
      ]);
      expect(res.body.results[0].error).toContain('would reach a secret volume');
      expect(h.endpointRenderReads).toBe(1);
      expect(configSpawns()).toHaveLength(1);
      expect(mutations()).toEqual([]);
    });

    it('reports success for an ordinary stack', async () => {
      renderFor = () => ordinary(stack);

      const res = await request(app).post(`/api/labels/${labelId}/action`).set('Cookie', cookie)
        .send({ action: 'deploy', dryRun: true });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([expect.objectContaining({ stackName: stack, success: true, dryRun: true })]);
      expect(mutations()).toEqual([]);
    });
  });
});
