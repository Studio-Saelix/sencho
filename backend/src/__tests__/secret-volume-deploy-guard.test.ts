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
  type FakeVolume = string | { Name: string; Labels?: Record<string, string> | null };
  let labelledVolumes: FakeVolume[];
  let containers: Array<{
    Id: string;
    Names: string[];
    Labels?: Record<string, string>;
    Mounts: Array<{ Type: string; Name?: string; Destination?: string }>;
  }>;
  /** What `inspect` answers per container id: the create spec the down guard reads. */
  let inspectFor: Record<string, {
    Id?: string;
    Mounts?: Array<{ Type: string; Name?: string; Destination?: string }>;
    HostConfig: { Mounts?: Array<{ Type: string; Source?: string; Target: string }>; Binds?: string[]; VolumesFrom?: string[] };
  }>;
  let inspectError: (Error & { statusCode?: number }) | null;
  /** A failure for one container id or name only. */
  let inspectErrorFor: Record<string, Error & { statusCode?: number }>;
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
    inspectFor = {};
    inspectError = null;
    inspectErrorFor = {};
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
      return { Volumes: labelledVolumes.map((volume) => (typeof volume === 'string' ? { Name: volume } : volume)), Warnings: [] };
    });
    listContainers = vi.fn(async (opts?: { filters?: { label?: string[] } }) => {
      events.push('listContainers');
      // A Compose project filter answers only that project's containers, as the daemon does.
      const project = opts?.filters?.label?.find((label) => label.startsWith('com.docker.compose.project='));
      if (project === undefined) return containers;
      const name = project.slice('com.docker.compose.project='.length);
      return containers.filter((container) => container.Labels?.['com.docker.compose.project'] === name);
    });
    const getContainer = vi.fn((id: string) => ({
      inspect: async () => {
        events.push(`inspect:${id}`);
        if (inspectError) throw inspectError;
        if (inspectErrorFor[id]) throw inspectErrorFor[id];
        return inspectFor[id] ?? { HostConfig: {} };
      },
    }));
    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({ listVolumes, listContainers, getContainer } as unknown as Docker);
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

    it.each(['runDown', 'downStack'] as const)('%s refuses a stack declaring the reserved label the same way', async (method) => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { lookalike: { name: `${stack}_lookalike`, labels: ['io.sencho.secret=x'] } },
      });

      expect(await failureOf(svc()[method](stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
      expect(mutations()).toEqual([]);
    });

    it.each(['runDown', 'downStack'] as const)('%s refuses a volume only the Docker volume labels, though the stack declares it plainly', async (method) => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { data: { name: `${stack}_data` } },
      });
      labelledVolumes = [`${stack}_data`];

      const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('so its volumes were not removed');
      expect(listVolumes).toHaveBeenCalledWith({ filters: { label: ['io.sencho.secret'] } });
      expect(mutations()).toEqual([]);
    });

    it.each(['runDown', 'downStack'] as const)('%s refuses when the volume labels cannot be read', async (method) => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { data: { name: `${stack}_data` } },
      });
      listVolumes.mockRejectedValueOnce(new Error('connect ECONNREFUSED /var/run/docker.sock'));

      const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

      expect(error).toBeInstanceOf(SecretVolumeProtectedError);
      expect((error as Error).message).toContain('could not read the volumes on this node');
      expect(mutations()).toEqual([]);
    });

    it.each(['runDown', 'downStack'] as const)('%s removes the volumes of an ordinary stack when no declared volume is a secret', async (method) => {
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: { data: { name: `${stack}_data` } },
      });
      labelledVolumes = ['some-other-stack_tok'];

      await svc()[method](stack, { removeVolumes: true });

      expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
    });

    it('reads the volume labels and the containers of a stack that declares no volume', async () => {
      // Anonymous volumes are not declared, and `down --volumes` removes them.
      renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });

      await svc().runDown(stack, { removeVolumes: true });

      expect(listVolumes).toHaveBeenCalledWith({ filters: { label: ['io.sencho.secret'] } });
      expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: [`com.docker.compose.project=${stack}`] } });
      expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
    });

    describe('a secret volume a container mounts anonymously', () => {
      const ANON = 'f3b1c2d4e5a6978812ab34cd56ef7890a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const declaredNone = () => ({});
      const declaredOrdinary = () => ({ data: { name: `${stack}_data` } });

      /** A Compose container of `project` mounting `volume` at /token, anonymously unless `named`. */
      function holder(project: string, volume: string, named = false) {
        containers = [{
          Id: 'c-web',
          Names: [`/${project}-web-1`],
          Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'web' },
          Mounts: [{ Type: 'volume', Name: volume, Destination: '/token' }],
        }];
        inspectFor = {
          'c-web': { HostConfig: { Mounts: [{ Type: 'volume', ...(named ? { Source: volume } : {}), Target: '/token' }] } },
        };
      }

      it.each([
        ['runDown', 'no declared volume', declaredNone],
        ['downStack', 'no declared volume', declaredNone],
        ['runDown', 'an ordinary declared volume', declaredOrdinary],
        ['downStack', 'an ordinary declared volume', declaredOrdinary],
      ] as const)('%s refuses it with %s', async (method, _declared, volumes) => {
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20', volumes: [{ type: 'volume', target: '/token' }] } }, volumes: volumes() });
        labelledVolumes = [ANON];
        holder(stack, ANON);

        const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

        expect(error).toBeInstanceOf(SecretVolumeProtectedError);
        expect((error as Error).message).toContain('mounts without naming it');
        expect(events).toContain('inspect:c-web');
        expect(mutations()).toEqual([]);
      });

      it.each(['runDown', 'downStack'] as const)('%s finds it under the project name Compose runs the stack as', async (method) => {
        renderFor = () => ({ name: 'edge-project', services: { web: { image: 'alpine:3.20' } } });
        labelledVolumes = [ANON];
        holder('edge-project', ANON);

        expect(await failureOf(svc()[method](stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
        expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: ['com.docker.compose.project=edge-project'] } });
        expect(mutations()).toEqual([]);
      });

      it('leaves out a container of another project that happens to carry the stack name', async () => {
        // Compose runs this stack as `edge-project`; a project named like the stack is not its own.
        renderFor = () => ({ name: 'edge-project', services: { web: { image: 'alpine:3.20' } } });
        labelledVolumes = [ANON];
        holder(stack, ANON);

        await svc().runDown(stack, { removeVolumes: true });

        expect(events).not.toContain('inspect:c-web');
        expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
      });

      it.each([
        ['a trailing slash', '/token/'],
        ['a doubled slash', '//token'],
      ])('matches a named mount whose spec spells the path with %s', async (_spelling, target) => {
        recordManagedKind(stack, 'edge-tunnel');
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } }, volumes: { tok: { name: `${stack}_tok`, external: true } } });
        labelledVolumes = [`${stack}_tok`];
        holder(stack, `${stack}_tok`);
        inspectFor['c-web'] = { HostConfig: { Mounts: [{ Type: 'volume', Source: `${stack}_tok`, Target: target }] } };

        await svc().runDown(stack, { removeVolumes: true });

        expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
      });

      it.each(['runDown', 'downStack'] as const)('%s refuses when the spec names the volume only at another path', async (method) => {
        // Named at /backup, but the mount at /token has no source: that one is anonymous.
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
        labelledVolumes = [ANON];
        holder(stack, ANON);
        inspectFor['c-web'] = { HostConfig: { Mounts: [{ Type: 'volume', Source: ANON, Target: '/backup' }, { Type: 'volume', Target: '/token' }] } };

        expect(await failureOf(svc()[method](stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
        expect(mutations()).toEqual([]);
      });

      it.each(['edge-tunnel', 'released-edge-tunnel'])('refuses the recorded %s consumer too, through both methods', async (kind) => {
        recordManagedKind(stack, kind);
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } }, volumes: { tok: { name: `${stack}_tok`, external: true } } });
        labelledVolumes = [`${stack}_tok`, ANON];
        holder(stack, ANON);

        for (const method of ['runDown', 'downStack'] as const) {
          expect(await failureOf(svc()[method](stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
        }
        expect(mutations()).toEqual([]);
      });

      it.each(['runDown', 'downStack'] as const)('%s lets the consumer through when it mounts the secret volume by name', async (method) => {
        recordManagedKind(stack, 'edge-tunnel');
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } }, volumes: { tok: { name: `${stack}_tok`, external: true } } });
        labelledVolumes = [`${stack}_tok`];
        holder(stack, `${stack}_tok`, true);

        await svc()[method](stack, { removeVolumes: true });

        expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
      });

      it('counts a bind entry naming the volume as a named mount', async () => {
        recordManagedKind(stack, 'edge-tunnel');
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } }, volumes: { tok: { name: `${stack}_tok`, external: true } } });
        labelledVolumes = [`${stack}_tok`];
        holder(stack, `${stack}_tok`);
        inspectFor['c-web'] = { HostConfig: { Binds: [`${stack}_tok:/token:ro`] } };

        await svc().runDown(stack, { removeVolumes: true });

        expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
      });

      it.each(['runDown', 'downStack'] as const)('%s removes an ordinary anonymous volume without inspecting the container', async (method) => {
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
        labelledVolumes = ['some-other-stack_tok'];
        holder(stack, ANON);

        await svc()[method](stack, { removeVolumes: true });

        expect(events).not.toContain('inspect:c-web');
        expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
      });

      it.each(['runDown', 'downStack'] as const)('%s refuses when the containers cannot be listed', async (method) => {
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
        listContainers.mockRejectedValueOnce(new Error('connect ECONNREFUSED /var/run/docker.sock'));

        const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

        expect(error).toBeInstanceOf(SecretVolumeProtectedError);
        expect((error as Error).message).toContain('could not read the containers of this stack');
        expect(mutations()).toEqual([]);
      });

      it.each(['runDown', 'downStack'] as const)('%s refuses when a container holding a secret volume cannot be inspected', async (method) => {
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
        labelledVolumes = [ANON];
        holder(stack, ANON);
        inspectError = Object.assign(new Error('server error'), { statusCode: 500 });

        const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

        expect(error).toBeInstanceOf(SecretVolumeProtectedError);
        expect((error as Error).message).toContain('could not read the containers of this stack');
        expect(mutations()).toEqual([]);
      });

      describe('a secret mount inherited through volumes_from', () => {
        const tok = `${stack}_tok`;
        /**
         * A 64-hex volume name, Docker's anonymous name shape. The fake volume
         * list reports no labels, so this keeps the provenance path under test;
         * the named tests below also run with a plain name the guard can clear
         * without reading the donor.
         */
        const namedId = 'a1'.repeat(32);

        const twoServices = (volume = tok, volumeKey = 'tok', declare = true) => () => ({
          name: stack,
          services: { web: { image: 'alpine:3.20' }, side: { image: 'alpine:3.20', volumes_from: ['web'] } },
          volumes: declare ? { [volumeKey]: { name: volume, external: true } } : {},
        });

        /** `c-web` mounts `volume` at /token (named unless `anonymous`); `c-side` inherits it from `c-web`. */
        function donorAndInheritor(volume: string, anonymous = false, donorService = 'web', donorProject = stack) {
          containers = [
            {
              Id: 'c-web',
              Names: [`/${donorProject}-${donorService}-1`],
              Labels: { 'com.docker.compose.project': donorProject, 'com.docker.compose.service': donorService },
              Mounts: [{ Type: 'volume', Name: volume, Destination: '/token' }],
            },
            {
              Id: 'c-side',
              Names: [`/${stack}-side-1`],
              Labels: { 'com.docker.compose.project': stack, 'com.docker.compose.service': 'side' },
              Mounts: [{ Type: 'volume', Name: volume, Destination: '/token' }],
            },
          ];
          const donor = {
            Id: 'c-web',
            Mounts: [{ Type: 'volume', Name: volume, Destination: '/token' }],
            HostConfig: { Mounts: [{ Type: 'volume', ...(anonymous ? {} : { Source: volume }), Target: '/token' }] },
          };
          inspectFor = {
            'c-web': donor,
            [`${donorProject}-${donorService}-1`]: donor,
            'c-side': { Id: 'c-side', Mounts: donor.Mounts, HostConfig: { VolumesFrom: [`${donorProject}-${donorService}-1:ro`] } },
          };
        }

        it.each([
          ['edge-tunnel', 'runDown'],
          ['edge-tunnel', 'downStack'],
          ['released-edge-tunnel', 'runDown'],
          ['released-edge-tunnel', 'downStack'],
        ] as const)('lets the recorded %s consumer through %s when the inherited mount is named by its donor', async (kind, method) => {
          recordManagedKind(stack, kind);
          renderFor = twoServices(namedId);
          labelledVolumes = [namedId];
          donorAndInheritor(namedId);

          await svc()[method](stack, { removeVolumes: true });

          expect(events).toContain('inspect:c-side');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it.each(['runDown', 'downStack'] as const)('%s lets an ordinary stack through when it inherits a named secret mount from a container outside the project', async (method) => {
          renderFor = () => ({ name: stack, services: { side: { image: 'alpine:3.20' } } });
          labelledVolumes = [namedId];
          donorAndInheritor(namedId, false, 'tunnel', 'edge');

          await svc()[method](stack, { removeVolumes: true });

          expect(events).toContain('inspect:c-side');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it.each([
          ['edge-tunnel', 'runDown'],
          ['edge-tunnel', 'downStack'],
          ['released-edge-tunnel', 'runDown'],
          ['released-edge-tunnel', 'downStack'],
        ] as const)('%s consumer inherits a named secret mount from outside the project through %s without declaring a volume', async (kind, method) => {
          recordManagedKind(stack, kind);
          renderFor = () => ({ name: stack, services: { side: { image: 'alpine:3.20' } } });
          labelledVolumes = [namedId];
          donorAndInheritor(namedId, false, 'tunnel', 'edge');

          await svc()[method](stack, { removeVolumes: true });

          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it.each(['runDown', 'downStack'] as const)('%s lets a named volume through when the donor it inherits from is gone', async (method) => {
          // The surviving container still lists the volume by name, and Docker
          // keeps a volume created by name when the container is removed. The
          // donor's create spec is not needed to establish that.
          renderFor = () => ({ name: stack, services: { side: { image: 'alpine:3.20', volumes_from: ['container:retired-donor'] } } });
          labelledVolumes = [tok];
          containers = [{
            Id: 'c-side',
            Names: [`/${stack}-side-1`],
            Labels: { 'com.docker.compose.project': stack, 'com.docker.compose.service': 'side' },
            Mounts: [{ Type: 'volume', Name: tok, Destination: '/token' }],
          }];
          inspectFor = { 'c-side': { Id: 'c-side', Mounts: [{ Type: 'volume', Name: tok, Destination: '/token' }], HostConfig: { VolumesFrom: ['retired-donor:ro'] } } };
          inspectErrorFor['retired-donor'] = Object.assign(new Error('no such container'), { statusCode: 404 });

          await svc()[method](stack, { removeVolumes: true });

          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it.each(['runDown', 'downStack'] as const)('%s refuses a possibly-anonymous volume whose donor is gone', async (method) => {
          renderFor = () => ({ name: stack, services: { side: { image: 'alpine:3.20', volumes_from: ['container:retired-donor'] } } });
          labelledVolumes = [namedId];
          containers = [{
            Id: 'c-side',
            Names: [`/${stack}-side-1`],
            Labels: { 'com.docker.compose.project': stack, 'com.docker.compose.service': 'side' },
            Mounts: [{ Type: 'volume', Name: namedId, Destination: '/token' }],
          }];
          inspectFor = { 'c-side': { Id: 'c-side', Mounts: [{ Type: 'volume', Name: namedId, Destination: '/token' }], HostConfig: { VolumesFrom: ['retired-donor:ro'] } } };
          inspectErrorFor['retired-donor'] = Object.assign(new Error('no such container'), { statusCode: 404 });

          const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

          expect(error).toBeInstanceOf(SecretVolumeProtectedError);
          expect((error as Error).message).toContain('could not read the containers of this stack');
          expect(mutations()).toEqual([]);
        });

        it('permits a mount of a volume created by name, which Docker keeps when the container is removed', async () => {
          // A plain name cannot be a Docker-created anonymous volume, so the
          // container spec is irrelevant: the volume survives the removal.
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [tok];
          holder(stack, tok);
          inspectFor['c-web'] = { HostConfig: {} };

          await svc().runDown(stack, { removeVolumes: true });

          expect(events).not.toContain('inspect:c-web');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it('refuses a plain-name volume the daemon labels as anonymous', async () => {
          // The anonymous label, not the name shape, decides; a labelled
          // anonymous volume is exactly what the removal deletes.
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [{ Name: tok, Labels: { 'io.sencho.secret': '', 'com.docker.volume.anonymous': '' } }];
          holder(stack, tok);
          inspectFor['c-web'] = { HostConfig: {} };

          const error = await failureOf(svc().runDown(stack, { removeVolumes: true }));

          expect(error).toBeInstanceOf(SecretVolumeProtectedError);
          expect(events).toContain('inspect:c-web');
          expect(mutations()).toEqual([]);
        });

        it('treats a 64-hex volume the daemon labels as named without reading the container', async () => {
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [{ Name: namedId, Labels: { 'io.sencho.secret': '' } }];
          holder(stack, namedId);
          inspectFor['c-web'] = { HostConfig: {} };

          await svc().runDown(stack, { removeVolumes: true });

          expect(events).not.toContain('inspect:c-web');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it('follows a chain of donors to the one that names the mount', async () => {
          recordManagedKind(stack, 'edge-tunnel');
          renderFor = twoServices(namedId, 'tok', false);
          labelledVolumes = [namedId];
          donorAndInheritor(namedId);
          // c-side inherits from c-mid, which inherits from the named c-web.
          inspectFor['c-mid'] = { Id: 'c-mid', Mounts: inspectFor['c-web'].Mounts, HostConfig: { VolumesFrom: [`${stack}-web-1`] } };
          inspectFor['c-side'].HostConfig.VolumesFrom = ['c-mid'];

          await svc().runDown(stack, { removeVolumes: true });

          expect(events).toContain('inspect:c-mid');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it('does not inspect a donor twice when a chain reaches it by name and by id', async () => {
          renderFor = () => ({ name: stack, services: { side: { image: 'alpine:3.20' } } });
          labelledVolumes = [namedId];
          containers = [{
            Id: 'c-side',
            Names: [`/${stack}-side-1`],
            Labels: { 'com.docker.compose.project': stack, 'com.docker.compose.service': 'side' },
            Mounts: [{ Type: 'volume', Name: namedId, Destination: '/token' }],
          }];
          const mounts = [{ Type: 'volume' as const, Name: namedId, Destination: '/token' }];
          // The mid donor lists the same donor by name and then by its id: the
          // second reference must not inspect it again.
          inspectFor = {
            'c-side': { Id: 'c-side', Mounts: mounts, HostConfig: { VolumesFrom: ['c-mid'] } },
            'c-mid': { Id: 'c-mid', Mounts: mounts, HostConfig: { VolumesFrom: ['c-donor-name', 'c-donor-id'] } },
            'c-donor-name': { Id: 'c-donor-id', Mounts: mounts, HostConfig: { Mounts: [{ Type: 'volume', Target: '/token' }] } },
          };

          await expect(svc().runDown(stack, { removeVolumes: true })).rejects.toBeInstanceOf(SecretVolumeProtectedError);
          expect(events.filter((event) => event === 'inspect:c-donor-name')).toHaveLength(1);
          expect(events).not.toContain('inspect:c-donor-id');
          expect(mutations()).toEqual([]);
        });

        it('names the mount through a donor bind entry', async () => {
          renderFor = twoServices(namedId, 'tok', false);
          labelledVolumes = [namedId];
          donorAndInheritor(namedId);
          inspectFor['c-web'].HostConfig = { Binds: [`${namedId}:/token:ro`] };

          await svc().runDown(stack, { removeVolumes: true });

          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it('refuses, and stops, when donors inherit from each other and none names the mount', async () => {
          renderFor = twoServices(namedId, 'tok', false);
          labelledVolumes = [namedId];
          containers = [{
            Id: 'c-side',
            Names: [`/${stack}-side-1`],
            Labels: { 'com.docker.compose.project': stack, 'com.docker.compose.service': 'side' },
            Mounts: [{ Type: 'volume', Name: namedId, Destination: '/token' }],
          }];
          const mounts = [{ Type: 'volume' as const, Name: namedId, Destination: '/token' }];
          // c-side and c-mid inherit from each other; neither names the volume.
          inspectFor = {
            'c-side': { Id: 'c-side', Mounts: mounts, HostConfig: { VolumesFrom: ['c-mid'] } },
            'c-mid': { Id: 'c-mid', Mounts: mounts, HostConfig: { VolumesFrom: ['c-side'] } },
          };

          await expect(svc().runDown(stack, { removeVolumes: true })).rejects.toBeInstanceOf(SecretVolumeProtectedError);
          expect(events.filter((event) => event === 'inspect:c-mid')).toHaveLength(1);
          expect(mutations()).toEqual([]);
        });

        it.each(['runDown', 'downStack'] as const)('%s refuses a mount inherited from a donor that mounts it anonymously', async (method) => {
          renderFor = twoServices(ANON, 'tok', false);
          labelledVolumes = [ANON];
          donorAndInheritor(ANON, true);

          const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

          expect(error).toBeInstanceOf(SecretVolumeProtectedError);
          expect((error as Error).message).toContain('mounts without naming it');
          expect(mutations()).toEqual([]);
        });

        it.each([
          ['edge-tunnel', 'runDown'],
          ['edge-tunnel', 'downStack'],
          ['released-edge-tunnel', 'runDown'],
          ['released-edge-tunnel', 'downStack'],
        ] as const)('refuses the recorded %s consumer for an anonymous mount inherited from a donor outside the project through %s', async (kind, method) => {
          // The donor is not a container this down removes, so only following
          // volumes_from finds the anonymous mount it copied.
          recordManagedKind(stack, kind);
          renderFor = () => ({ name: stack, services: { side: { image: 'alpine:3.20', volumes_from: ['container:tunnel'] } } });
          labelledVolumes = [ANON];
          donorAndInheritor(ANON, true, 'tunnel', 'edge');

          const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

          expect(error).toBeInstanceOf(SecretVolumeProtectedError);
          expect(events).not.toContain('inspect:c-web');
          expect(mutations()).toEqual([]);
        });

        it('refuses a donor that does not hold the mount the inheritor has', async () => {
          renderFor = twoServices(namedId, 'tok', false);
          labelledVolumes = [namedId];
          donorAndInheritor(namedId);
          inspectFor[`${stack}-web-1`] = { Id: 'c-web', Mounts: [], HostConfig: { Mounts: [{ Type: 'volume', Source: namedId, Target: '/other' }] } };
          // c-web itself still lists and inspects as named; only the inheritor's provenance is unknown.
          await expect(svc().runDown(stack, { removeVolumes: true })).rejects.toBeInstanceOf(SecretVolumeProtectedError);
          expect(mutations()).toEqual([]);
        });

        it.each([
          ['edge-tunnel', 'runDown', 'cannot be inspected', 500],
          ['edge-tunnel', 'downStack', 'cannot be inspected', 500],
          ['released-edge-tunnel', 'runDown', 'cannot be inspected', 500],
          ['released-edge-tunnel', 'downStack', 'cannot be inspected', 500],
          ['edge-tunnel', 'runDown', 'is gone', 404],
          ['edge-tunnel', 'downStack', 'is gone', 404],
          ['released-edge-tunnel', 'runDown', 'is gone', 404],
          ['released-edge-tunnel', 'downStack', 'is gone', 404],
        ] as const)('%s %s refuses when the donor %s', async (kind, method, _what, statusCode) => {
          recordManagedKind(stack, kind);
          renderFor = twoServices(namedId);
          labelledVolumes = [namedId];
          donorAndInheritor(namedId);
          inspectErrorFor[`${stack}-web-1`] = Object.assign(new Error('donor read failed'), { statusCode });

          const error = await failureOf(svc()[method](stack, { removeVolumes: true }));

          expect(error).toBeInstanceOf(SecretVolumeProtectedError);
          expect((error as Error).message).toContain('could not read the containers of this stack');
          expect(mutations()).toEqual([]);
        });
      });

      describe('a container the down does not remove with its volumes', () => {
        function oneHolder(labels: Record<string, string>) {
          containers = [{
            Id: 'c-held',
            Names: [`/${stack}-held-1`],
            Labels: { 'com.docker.compose.project': stack, ...labels },
            Mounts: [{ Type: 'volume', Name: ANON, Destination: '/token' }],
          }];
          inspectFor = { 'c-held': { HostConfig: { Mounts: [{ Type: 'volume', Target: '/token' }] } } };
        }

        it.each([
          ['runDown', 'a service the project no longer declares', { 'com.docker.compose.service': 'retired' }],
          ['downStack', 'a service the project no longer declares', { 'com.docker.compose.service': 'retired' }],
          ['runDown', 'a service the project does not enable', { 'com.docker.compose.service': 'debug' }],
          ['downStack', 'a service the project does not enable', { 'com.docker.compose.service': 'debug' }],
          ['downStack', 'a one-off of a service the project no longer declares', { 'com.docker.compose.service': 'retired', 'com.docker.compose.oneoff': 'True' }],
          ['runDown', 'a one-off of a service the project no longer declares', { 'com.docker.compose.service': 'retired', 'com.docker.compose.oneoff': 'True' }],
          ['runDown', 'no service label', {}],
          ['downStack', 'no service label', {}],
        ] as const)('%s leaves an orphan with %s alone, as Compose keeps its volumes', async (method, _what, labels) => {
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [ANON];
          oneHolder(labels);

          await svc()[method](stack, { removeVolumes: true });

          expect(events).not.toContain('inspect:c-held');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it.each(['edge-tunnel', 'released-edge-tunnel'] as const)('ignores an orphan of the recorded %s consumer, with its volumes kept', async (kind) => {
          recordManagedKind(stack, kind);
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [ANON];
          oneHolder({ 'com.docker.compose.service': 'retired' });

          await svc().downStack(stack, { removeVolumes: true });

          expect(events).not.toContain('inspect:c-held');
          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it('lets runDown through for a one-off run container, which a plain down never lists', async () => {
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [ANON];
          oneHolder({ 'com.docker.compose.service': 'web', 'com.docker.compose.oneoff': 'True' });

          await svc().runDown(stack, { removeVolumes: true });

          expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
        });

        it('refuses downStack for a one-off run container of a declared service, which --remove-orphans removes with its volumes', async () => {
          renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
          labelledVolumes = [ANON];
          oneHolder({ 'com.docker.compose.service': 'web', 'com.docker.compose.oneoff': 'True' });

          expect(await failureOf(svc().downStack(stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
          expect(mutations()).toEqual([]);
        });
      });

      it('goes ahead when the container is gone by the time it is inspected', async () => {
        renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } } });
        labelledVolumes = [ANON];
        holder(stack, ANON);
        inspectError = Object.assign(new Error('no such container'), { statusCode: 404 });

        await svc().runDown(stack, { removeVolumes: true });

        expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
      });
    });

    it.each([
      ['edge-tunnel', 'runDown'],
      ['edge-tunnel', 'downStack'],
      ['released-edge-tunnel', 'runDown'],
      ['released-edge-tunnel', 'downStack'],
    ] as const)('lets the recorded %s consumer remove its volumes through %s when its secret volumes are external', async (kind, method) => {
      recordManagedKind(stack, kind);
      renderFor = () => ({
        name: stack,
        services: { web: { image: 'alpine:3.20' } },
        volumes: {
          secret: { name: SECRET_VOLUME, external: true },
          tok: { name: `${stack}_tok`, external: true },
          data: { name: `${stack}_data` },
        },
      });
      labelledVolumes = [`${stack}_tok`];

      await svc()[method](stack, { removeVolumes: true });

      expect(mutations()).toEqual([expect.arrayContaining(['down', '--volumes'])]);
    });

    it.each([
      ['the reserved volume beside an external one', () => ({ ext: { name: SECRET_VOLUME, external: true }, own: { name: `${stack}_tok` } }), [`${stack}_tok`]],
      ['the reserved volume', () => ({ secret: { name: SECRET_VOLUME } }), [] as string[]],
      ['a labelled volume', () => ({ tok: { name: `${stack}_tok` } }), [`${stack}_tok`]],
    ])('refuses the recorded consumer when it declares %s as its own, which Compose would remove', async (_what, volumes, labelled) => {
      recordManagedKind(stack, 'edge-tunnel');
      renderFor = () => ({ name: stack, services: { web: { image: 'alpine:3.20' } }, volumes: volumes() });
      labelledVolumes = labelled;

      for (const method of ['runDown', 'downStack'] as const) {
        expect(await failureOf(svc()[method](stack, { removeVolumes: true }))).toBeInstanceOf(SecretVolumeProtectedError);
      }
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
