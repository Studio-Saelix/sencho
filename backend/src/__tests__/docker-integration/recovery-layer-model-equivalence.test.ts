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

      try {
        const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
        const { ComposeService } = await import('../../services/ComposeService');
        const inventory = await resolveRollbackInventory(nodeId, testCase.stack);
        expect(inventory.coverageRefusal).toBeNull();

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
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, testCase.stack, []);
      }
    });
  }
});