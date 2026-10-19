/**
 * Docker-backed: the Compose layers a recovery generation pins must load the
 * model the capture-time run loaded.
 *
 * docker compose replaces its own file discovery with COMPOSE_FILE, and it
 * resolves competing compose filenames in an order that is neither alphabetical
 * nor uniform across the compose.* and docker-compose.* families. A layer list
 * that disagrees renders a different project while the rollback reports success,
 * so every case here renders the live stack and the recovery invocation with the
 * real CLI and compares the two models. No container is started: `compose config`
 * only resolves the model.
 *
 * Skipped automatically when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();

type Case = {
  name: string;
  stack: string;
  files: Record<string, string>;
  /** Project env files configured on the node, as the Environment tab would. */
  projectEnvFiles?: string[];
  /** Process environment the live run and the reader both see. */
  processEnv?: Record<string, string>;
  /** Text a recorded omission note must contain, when the case is partial. */
  expectUncaptured?: string;
};

const SERVICE = (image: string, command: string): string =>
  ['services:', '  web:', `    image: ${image}`, `    command: ["echo","${command}"]`, ''].join('\n');

const CASES: Case[] = [
  {
    // COMPOSE_FILE replaces discovery entirely, and a -f flag replaces it in
    // turn, so a pinned list would silently drop prod.yaml.
    name: 'a .env COMPOSE_FILE chain',
    stack: 'layercomposfile',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
  },
  {
    // The legacy family prefers .yml over .yaml, the compose.* family the other
    // way round, and every override prefers .yml.
    name: 'competing legacy roots and overrides',
    stack: 'layerlegacy',
    files: {
      'docker-compose.yaml': SERVICE('busybox:1.36.1', 'base-yaml'),
      'docker-compose.yml': SERVICE('busybox:1.36.1', 'base-yml'),
      'docker-compose.override.yaml': SERVICE('busybox:1.36.1', 'ovr-yaml'),
      'docker-compose.override.yml': SERVICE('busybox:1.36.1', 'ovr-yml'),
    },
  },
  {
    // Every rollback appends a recovery layer, which suppresses discovery and
    // with it COMPOSE_FILE, so this is the shape a real rollback takes.
    name: 'a COMPOSE_FILE chain under a recovery layer',
    stack: 'layerrecoveryoverride',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
  },
  {
    name: 'a configured project env file chain',
    stack: 'layerprojectenv',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
    projectEnvFiles: ['select.env'],
  },
  {
    name: 'an ordinary stack with an implicit override',
    stack: 'layeroverride',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'compose.override.yaml': SERVICE('busybox:1.36.1', 'ovr-yaml'),
      'compose.override.yml': SERVICE('busybox:1.36.1', 'ovr-yml'),
    },
  },
  {
    // COMPOSE_ENV_FILES replaces the project .env, so the reader has to load
    // exactly that list or it answers for a variable Compose never consulted.
    name: 'a COMPOSE_ENV_FILES chain',
    stack: 'layercomposeenvfiles',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    // The inventory captures the project .env and the configured project env
    // files, not this operator-level list, so the generation records it.
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // A quoted value spans lines, so the first layer's filename ends with a
    // newline. Reading only the first physical line would pin compose.yaml and
    // run the wrong project: the truncated name resolves to a real file here.
    name: 'a multiline quoted COMPOSE_FILE value',
    stack: 'layermultiline',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'wrong-root'),
      'compose.yaml\n': SERVICE('busybox:1.36.1', 'newline-root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE="compose.yaml\n:prod.yaml"\n',
    },
  },
  {
    // Ordinary dotenv interpolation. The reader has to expand the reference the
    // same way, or it refuses a working stack (or pins a different chain).
    name: 'an interpolated COMPOSE_FILE chain',
    stack: 'layerinterpolated',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'BASE_FILE=compose.yaml\nCOMPOSE_FILE=${BASE_FILE}:prod.yaml\n',
    },
  },
  {
    // A single-quoted value is verbatim, so the chain is the literal text.
    name: 'a single-quoted chain',
    stack: 'layerquoted',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': "COMPOSE_FILE='compose.yaml:prod.yaml'\n",
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // `$$` is a literal dollar, so this names a file that starts with one and
    // must not be read as a variable reference. The distinct file is last, so a
    // reader that dropped it would render a different command.
    name: 'a dollar-escaped layer name',
    stack: 'layerdollar',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      '$root.yaml': SERVICE('busybox:1.36.1', 'dollar-root'),
      'select.env': 'COMPOSE_FILE="compose.yaml:$$root.yaml"\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // A double-quoted value expands Go escapes, and an octal one is a byte.
    name: 'an octal-escaped layer name',
    stack: 'layeroctal',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'Sprod.yaml': SERVICE('busybox:1.36.1', 'octal-root'),
      'select.env': 'COMPOSE_FILE="compose.yaml:\\0123prod.yaml"\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // A soft default resolves inside the file that holds it.
    name: 'a defaulted reference',
    stack: 'layerdefault',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': 'COMPOSE_FILE=${BASE_FILE:-compose.yaml}:prod.yaml\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // The separator can come from the file that holds the chain.
    name: 'a file-selected path separator',
    stack: 'layerseparator',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=compose.yaml;prod.yaml\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // An unquoted value ends at a space-hash comment.
    name: 'a chain with an inline comment',
    stack: 'layercomment',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': 'COMPOSE_FILE=compose.yaml:prod.yaml # production\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // Two listed files, applied in order, so the later one decides.
    name: 'two listed env files',
    stack: 'layertwofiles',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'first.env': 'COMPOSE_FILE=compose.yaml\n',
      'second.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'first.env,second.env' },
    expectUncaptured: 'first.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
];

/** The rendered model, with the project name pinned so it cannot differ. */
function renderModel(globalArgs: string[], cwd: string, project: string): unknown {
  const raw = execFileSync('docker', ['compose', '-p', project, ...globalArgs, 'config', '--format', 'json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

describe.skipIf(!hasDocker)('recovery loads the model the capture-time run loaded', () => {
  let tmpDir: string;
  let composeDir: string;
  let nodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;

    const { DatabaseService } = await import('../../services/DatabaseService');
    const local = DatabaseService.getInstance().getDefaultNode();
    if (!local?.id) throw new Error('Test DB has no default local node');
    nodeId = local.id;
  }, 120_000);

  afterAll(() => {
    if (tmpDir) cleanupTestDb(tmpDir);
  });

  for (const testCase of CASES) {
    it(`renders the captured model for ${testCase.name}`, async () => {
      const stackDir = path.join(composeDir, testCase.stack);
      fs.mkdirSync(stackDir, { recursive: true });
      for (const [name, body] of Object.entries(testCase.files)) {
        fs.writeFileSync(path.join(stackDir, name), body, 'utf8');
      }
      // The layer a rollback appends last. It only adds a label, so it refines
      // the captured project instead of replacing the fields under comparison.
      // Adding a layer at all is what suppresses COMPOSE_FILE, so a case without
      // it would not exercise the shape a real rollback takes.
      const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
      fs.writeFileSync(
        recoveryLayer,
        'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
        'utf8',
      );

      const { DatabaseService } = await import('../../services/DatabaseService');
      DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, testCase.stack, testCase.projectEnvFiles ?? []);

      const appliedEnv: string[] = [];
      for (const [name, value] of Object.entries(testCase.processEnv ?? {})) {
        process.env[name] = value;
        appliedEnv.push(name);
      }
      try {
        const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
        const { ComposeService } = await import('../../services/ComposeService');
        const inventory = await resolveRollbackInventory(nodeId, testCase.stack);
        expect(inventory.coverageRefusal).toBeNull();
        if (testCase.expectUncaptured) {
          expect(inventory.uncapturedInputs.join(' ')).toContain(testCase.expectUncaptured);
        }

        const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
          testCase.stack,
          ['config'],
          recoveryLayer,
          inventory.invocation,
        );
        const recoveryPrefix = args.slice(1, args.indexOf('config'));
        // The live run is the capture-time invocation itself: its own global
        // flags (a configured --env-file chain, a multi-file -f list) with no
        // recovery layer on top. Comparing against a bare `docker compose`
        // would grade the recovery against a run the deploy never made.
        const livePrefix = inventory.invocation.composeArgsPrefix;
        // The recovery layer must come last, or it shadows every other layer
        // instead of refining the captured project.
        expect(recoveryPrefix[recoveryPrefix.length - 1]).toBe(recoveryLayer);
        // A generation that records layers has to name them on the recovery run.
        if (inventory.invocation.composeLayers) {
          expect(recoveryPrefix).toEqual(expect.arrayContaining(inventory.invocation.composeLayers));
        }

        const recovery = renderModel(recoveryPrefix, stackDir, testCase.stack) as {
          services: Record<string, { command?: string[]; image?: string }>;
        };
        const live = renderModel(livePrefix, stackDir, testCase.stack) as {
          services: Record<string, { command?: string[]; image?: string }>;
        };
        // The recovery layer only adds a label, so the service definitions the
        // deploy ran have to survive the rollback verbatim.
        expect(recovery.services.web.command).toEqual(live.services.web.command);
        expect(recovery.services.web.image).toBe(live.services.web.image);
      } finally {
        for (const name of appliedEnv) delete process.env[name];
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, testCase.stack, []);
      }
    });
  }

  it('keeps a local override an uncaptured external include extends from, and both projects render', async () => {
    const stack = 'layerpartialinclude';
    const stackDir = path.join(composeDir, stack);
    const sharedDir = path.join(composeDir, 'shared');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });
    const sharedFile = path.join(sharedDir, 'base.yaml');
    fs.writeFileSync(
      sharedFile,
      ['services:', '  shared:', '    image: busybox:1.36.1', '    command: ["echo","shared"]', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(stackDir, 'docker-compose.yml'),
      `include:\n  - path: ../shared/base.yaml\n${SERVICE('busybox:1.36.1', 'root')}`,
      'utf8',
    );
    const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
    fs.writeFileSync(
      recoveryLayer,
      'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
      'utf8',
    );

    const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
    const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
    const { ComposeService } = await import('../../services/ComposeService');

    const captured = await resolveRollbackInventory(nodeId, stack);
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedInputs.join(' ')).toContain('../shared/base.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName: stack,
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stack, generationId);

    // The live shared file now extends a service from a local override that
    // appeared after capture, so that override is a dependency of the project
    // the partial generation rolls back to.
    const helper = SERVICE('busybox:1.36.1', 'helper');
    fs.writeFileSync(path.join(stackDir, 'compose.override.yml'), helper, 'utf8');
    fs.writeFileSync(
      sharedFile,
      [
        'services:',
        '  shared:',
        '    image: busybox:1.36.1',
        '    extends:',
        `      file: ../${stack}/compose.override.yml`,
        '      service: web',
        '',
      ].join('\n'),
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(nodeId, stack, generationId);
    await ctx.restoreFromContext();

    // The dependency the uncaptured input needs is still there, and the project
    // it renders is complete. Discovery loads the post-capture override, while
    // the recovery run pins the captured layer and leaves that edit alone: the
    // rollback runs what the generation holds.
    expect(fs.readFileSync(path.join(stackDir, 'compose.override.yml'), 'utf8')).toBe(helper);
    const live = renderModel([], stackDir, stack) as {
      services: Record<string, { command?: string[]; image?: string }>;
    };
    expect(Object.keys(live.services).sort()).toEqual(['shared', 'web']);
    expect(live.services.web.command).toEqual(['echo', 'helper']);

    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stack,
      ['config'],
      recoveryLayer,
      manifest.invocation,
    );
    const recovery = renderModel(args.slice(1, args.indexOf('config')), stackDir, stack) as {
      services: Record<string, { command?: string[]; image?: string }>;
    };
    expect(Object.keys(recovery.services).sort()).toEqual(['shared', 'web']);
    expect(recovery.services.web.command).toEqual(['echo', 'root']);
    // The extends target in the shared file resolved: the bytes survive and the
    // restored project still renders through them.
    expect(recovery.services.shared.command).toEqual(['echo', 'helper']);
  });

  it('renders a shared main compose file through its link, using the current target content', async () => {
    const stack = 'layersharemain';
    const stackDir = path.join(composeDir, stack);
    const sharedDir = path.join(composeDir, 'shared');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });
    const sharedFile = path.join(sharedDir, 'base.yaml');
    fs.writeFileSync(sharedFile, SERVICE('busybox:1.36.1', 'shared-v1'), 'utf8');
    const link = path.join(stackDir, 'compose.yaml');
    fs.symlinkSync(sharedFile, link);
    const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
    fs.writeFileSync(
      recoveryLayer,
      'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
      'utf8',
    );

    const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
    const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
    const { ComposeService } = await import('../../services/ComposeService');

    const captured = await resolveRollbackInventory(nodeId, stack);
    expect(captured.coverageRefusal).toBeNull();
    // The shared file is selected and pinned, and recorded as not captured.
    expect(captured.invocation.composeLayers).toEqual(['compose.yaml']);
    expect(captured.uncapturedRelativePaths).toContain('compose.yaml');
    expect(captured.entries).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName: stack,
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stack, generationId);

    // The shared file moves on, which is what a rollback reads: the generation
    // cannot hold it, so the link is the input and its target is the content.
    const sharedNow = SERVICE('busybox:1.36.1', 'shared-v2');
    fs.writeFileSync(sharedFile, sharedNow, 'utf8');

    const ctx = await resolveComposeProjectContextForGeneration(nodeId, stack, generationId);
    await ctx.restoreFromContext();

    // The restore wrote nothing through the link and left the target alone.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sharedFile, 'utf8')).toBe(sharedNow);

    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stack,
      ['config'],
      recoveryLayer,
      manifest.invocation,
    );
    const recovery = renderModel(args.slice(1, args.indexOf('config')), stackDir, stack) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(recovery.services.web.command).toEqual(['echo', 'shared-v2']);
  });
});