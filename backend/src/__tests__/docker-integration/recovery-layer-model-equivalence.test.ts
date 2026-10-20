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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { generateOverrideYaml } from '../../services/MeshComposeOverride';

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
  /**
   * The layer list the capture must record, when the case pins its own chain.
   * The model comparison below catches a wrong project, but only this asserts
   * the literal selection the generation stores.
   */
  expectLayers?: string[];
  /**
   * Mesh is enabled for the stack. The live run then injects its own explicit
   * `-f` list (base, implicit override, Mesh layer), which suppresses Compose's
   * discovery and `COMPOSE_FILE` along with it.
   */
  mesh?: boolean;
  /**
   * The injected list must load the same service definitions Compose's own
   * discovery would: a Mesh layer may not change which competing file the stack
   * deploys. Not set where the injection is meant to change the layer set, which
   * is the `COMPOSE_FILE` case the `-f` list replaces.
   */
  meshMatchesDiscovery?: boolean;
  /**
   * Image a real rollback's recovery layer holds. When the layer pins the image,
   * a wrong layer selection can no longer be spotted by comparing images; the
   * command and mounts still have to match the live run.
   */
  recoveryImage?: string;
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
    // A literal `{` inside a default is valid Compose. The assignment does not
    // select a layer, so a reader that rejects it must not refuse the capture
    // or change the project.
    name: 'an unrelated env assignment with a literal brace',
    stack: 'layerbrace',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'plain'),
      '.env': 'LABEL=${UNSET:-foo{bar}\n',
    },
    expectLayers: ['compose.yaml'],
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
  {
    // The process disables the default env file, so Compose never reads the
    // chain it holds: the run loads compose.yaml alone. Pinning the chain from
    // an ignored file would roll the stack back to a project it never ran.
    name: 'a .env COMPOSE_FILE chain the process disables',
    stack: 'layerdisabledenv',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
    processEnv: { COMPOSE_DISABLE_ENV_FILE: 'true' },
  },
  {
    // A BOM is a valid env file to Compose, which trims it before parsing, so a
    // reader that rejects it refuses a stack that deploys.
    name: 'a BOM-prefixed .env COMPOSE_FILE chain',
    stack: 'layerbom',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': '\uFEFFCOMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
  },
  {
    name: 'a BOM-prefixed listed env file',
    stack: 'layerbomlisted',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      'select.env': '\uFEFFCOMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
    processEnv: { COMPOSE_ENV_FILES: 'select.env' },
    expectUncaptured: 'select.env is loaded by Compose through COMPOSE_ENV_FILES and is not captured',
  },
  {
    // Only a file's leading BOM is dropped. A trailing BOM is an ordinary name
    // character to Compose, so the two files below are different projects. A
    // reader that trims it records the plain layer and a rollback runs the wrong
    // command while its pinned image still looks correct.
    name: 'a trailing BOM in the selected layer name',
    stack: 'layertrailingbom',
    files: {
      'compose.yaml': SERVICE('alpine:3.20', 'plain'),
      'compose.yaml\uFEFF': SERVICE('busybox:1.37', 'bom'),
      '.env': 'COMPOSE_FILE=compose.yaml\uFEFF\n',
    },
    expectLayers: ['compose.yaml\uFEFF'],
    recoveryImage: 'busybox:1.37',
  },
  {
    // Go trims Unicode White_Space from an unquoted value, so a trailing en quad
    // still selects the plain layer. Keeping it would select the second file.
    name: 'trailing Unicode whitespace in the selected layer name',
    stack: 'layertrailingunicode',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'plain'),
      'compose.yaml\u2000': SERVICE('alpine:3.20', 'wrong'),
      '.env': 'COMPOSE_FILE=compose.yaml\u2000\n',
    },
    expectLayers: ['compose.yaml'],
    recoveryImage: 'busybox:1.36.1',
  },
  {
    // Compose skips statement whitespace with unicode.IsSpace, so a separator
    // before an unrelated assignment is valid. A reader that rejects it turns a
    // working stack into an unknown and refuses every capture.
    name: 'an unrelated assignment after a Unicode separator',
    stack: 'layerunicodeseparator',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'plain'),
      '.env': '\u2000LABEL=ordinary\nCOMPOSE_FILE=compose.yaml\n',
    },
    expectLayers: ['compose.yaml'],
  },
  {
    // export consumes ASCII whitespace with its regexp, then Go trims the rest
    // of the isSpace run. The NBSP after the space must not become part of the
    // name, or the chain is invisible and discovery pins the root instead.
    name: 'export followed by a space and a separator',
    stack: 'layerexportseparator',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'plain'),
      'prod.yaml': SERVICE('alpine:3.20', 'production'),
      '.env': 'export \u00a0COMPOSE_FILE=prod.yaml\n',
    },
    expectLayers: ['prod.yaml'],
    recoveryImage: 'alpine:3.20',
  },
  {
    // Mesh injects an explicit -f list, so the live run pins the base and the
    // implicit override instead of leaving either to discovery. The capture has
    // to record that same pair, or the recovery pins the other competing file.
    name: 'competing overrides under a Mesh run',
    stack: 'layermeshoverride',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'compose.override.yaml': SERVICE('busybox:1.36.1', 'ovr-yaml'),
      'compose.override.yml': SERVICE('busybox:1.36.1', 'ovr-yml'),
    },
    mesh: true,
    meshMatchesDiscovery: true,
  },
  {
    // Same injection, legacy family: Compose prefers .yml, so a live run that
    // pins the base by its own filename order has to agree with discovery.
    name: 'competing legacy roots under a Mesh run',
    stack: 'layermeshlegacy',
    files: {
      'docker-compose.yaml': SERVICE('busybox:1.36.1', 'base-yaml'),
      'docker-compose.yml': SERVICE('busybox:1.36.1', 'base-yml'),
    },
    mesh: true,
    meshMatchesDiscovery: true,
  },
  {
    // An injected -f list replaces COMPOSE_FILE, so the chain in .env selects
    // nothing on the live run and must not select anything on the recovery.
    name: 'a .env COMPOSE_FILE chain under a Mesh run',
    stack: 'layermeshchain',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
    mesh: true,
  },
  {
    // Compose validates an assignment name with Go's Unicode letter and number
    // rules, so a non-ASCII key is an ordinary line. A reader that rejects it
    // turns an unrelated .env line into a refused Compose action.
    name: 'a Unicode assignment beside the chain',
    stack: 'layerunicode',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'UNICODE_é=value\n中文=值\nCOMPOSE_FILE=compose.yaml:prod.yaml\n',
    },
  },
  {
    // The separator is an incomplete octal escape: Go's UnquoteChar wants
    // exactly three digits, so the spelling survives as the literal `\12` and
    // splits the chain there. Expanding it to a newline selects one layer named
    // after the whole value, and the recovery run then loads nothing at all.
    name: 'a separator that is an incomplete octal escape',
    stack: 'layerseparatoroctal',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml\\12prod.yaml\nCOMPOSE_PATH_SEPARATOR="\\012"\n',
    },
    expectLayers: ['compose.yaml', 'prod.yaml'],
  },
  {
    // A `\0` with no digits at all. Compose rewrites the prefix and Go refuses
    // the bare backslash, so the value is one backslash and the chain splits on
    // it; a reader that keeps `\0` splits nothing.
    name: 'a separator that is a bare octal prefix',
    stack: 'layerseparatoroctalzero',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml\\prod.yaml\nCOMPOSE_PATH_SEPARATOR="\\0"\n',
    },
    expectLayers: ['compose.yaml', 'prod.yaml'],
  },
  {
    // Three octal digits naming a byte above 255: Go refuses the escape, and
    // the rewritten spelling is what survives, so the separator is `\400`.
    name: 'a separator that is an out-of-range octal escape',
    stack: 'layerseparatoroctalrange',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yaml\\400prod.yaml\nCOMPOSE_PATH_SEPARATOR="\\0400"\n',
    },
    expectLayers: ['compose.yaml', 'prod.yaml'],
  },
  {
    // A valid byte octal, the shape the reader already reproduces: `\0123`
    // becomes `S`, so `S` is the separator. Kept beside the invalid spellings
    // so a reader that stops expanding octals fails here instead.
    name: 'a separator that is a valid byte octal escape',
    stack: 'layerseparatoroctalbyte',
    files: {
      'compose.yaml': SERVICE('busybox:1.36.1', 'root'),
      'prod.yaml': SERVICE('busybox:1.36.1', 'production'),
      '.env': 'COMPOSE_FILE=compose.yamlSprod.yaml\nCOMPOSE_PATH_SEPARATOR="\\0123"\n',
    },
    expectLayers: ['compose.yaml', 'prod.yaml'],
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

/**
 * The stack-relative layers a global-flag prefix pins with `-f`, in order. An
 * absolute entry is a generated layer (a Mesh override, a digest overlay) that
 * lives outside the stack directory, so it is not a captured stack input.
 */
function pinnedStackLayers(prefix: string[]): string[] {
  const layers: string[] = [];
  for (let i = 0; i < prefix.length - 1; i++) {
    if (prefix[i] !== '-f' && prefix[i] !== '--file') continue;
    if (!path.isAbsolute(prefix[i + 1])) layers.push(prefix[i + 1]);
  }
  return layers;
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
        [
          'services:',
          '  web:',
          ...(testCase.recoveryImage ? [`    image: ${testCase.recoveryImage}`] : []),
          '    labels:',
          '      sencho.recovery-test: "1"',
          '',
        ].join('\n'),
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
        const { MeshService } = await import('../../services/MeshService');

        // Mesh is a live-execution input, not a stack file: the real deploy
        // generates the layer in Sencho's data dir and appends it, so the test
        // does the same rather than hand-building an argument list.
        if (testCase.mesh) {
          const overrideDir = path.join(tmpDir, 'mesh-overrides');
          fs.mkdirSync(overrideDir, { recursive: true });
          const overridePath = path.join(overrideDir, `${testCase.stack}.override.yml`);
          fs.writeFileSync(
            overridePath,
            generateOverrideYaml({
              services: ['web'],
              aliases: [],
              senchoIp: '172.30.0.2',
            }),
            'utf8',
          );
          DatabaseService.getInstance().insertMeshStack(nodeId, testCase.stack, null);
          vi.spyOn(MeshService.getInstance(), 'ensureStackOverride').mockResolvedValue(overridePath);
        }

        const inventory = await resolveRollbackInventory(nodeId, testCase.stack);
        expect(inventory.coverageRefusal).toBeNull();
        if (testCase.expectUncaptured) {
          expect(inventory.uncapturedInputs.join(' ')).toContain(testCase.expectUncaptured);
        }
        if (testCase.expectLayers) {
          expect(inventory.invocation.composeLayers).toEqual(testCase.expectLayers);
        }

        // Recovery runs the persisted generation, not the in-memory inventory,
        // so the invocation it reads back is the one under test.
        const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
        const generationId = randomUUID();
        await RollbackGenerationStore.captureGeneration({
          nodeId,
          stackName: testCase.stack,
          generationId,
          inventory,
        });
        const manifest = await RollbackGenerationStore.readVerifiedGeneration(
          nodeId,
          testCase.stack,
          generationId,
        );

        const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
          testCase.stack,
          ['config'],
          recoveryLayer,
          manifest.invocation,
        );
        const recoveryPrefix = args.slice(1, args.indexOf('config'));
        // The live run is the deploy's own global flags with no recovery layer,
        // built by the production builder: a live run that pins files (Mesh
        // injection, a deploy spec) pins them there, and a live run that leaves
        // discovery alone stays bare. Rebuilding the prefix from the captured
        // inventory would compare the recovery against itself.
        const liveArgs = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
          testCase.stack,
          ['config'],
          null,
          null,
        );
        const livePrefix = liveArgs.slice(1, liveArgs.indexOf('config'));
        // The recovery layer must come last, or it shadows every other layer
        // instead of refining the captured project.
        expect(recoveryPrefix[recoveryPrefix.length - 1]).toBe(recoveryLayer);
        // A generation that records layers has to name them on the recovery run.
        if (inventory.invocation.composeLayers) {
          expect(recoveryPrefix).toEqual(expect.arrayContaining(inventory.invocation.composeLayers));
        }
        // Complete coverage means every stack-relative layer the live run loads
        // is either held by the generation or recorded as one it cannot hold.
        // A layer the live run pins and the inventory never accounted for is
        // the mismatch this suite exists to catch.
        for (const layer of pinnedStackLayers(livePrefix)) {
          const accountedFor = inventory.entries.some((e) => e.relativePath === layer)
            || inventory.uncapturedRelativePaths.includes(layer);
          expect(accountedFor, `capture must account for the live layer ${layer}`).toBe(true);
        }

        const recovery = renderModel(recoveryPrefix, stackDir, testCase.stack) as {
          services: Record<string, { command?: string[]; image?: string; networks?: unknown }>;
        };
        const live = renderModel(livePrefix, stackDir, testCase.stack) as {
          services: Record<string, { command?: string[]; image?: string; networks?: unknown }>;
        };
        // The recovery layer only adds a label, so the service definitions the
        // deploy ran have to survive the rollback verbatim.
        expect(recovery.services.web.command).toEqual(live.services.web.command);
        expect(recovery.services.web.image).toBe(live.services.web.image);
        if (testCase.mesh) {
          // Both runs loaded the Mesh layer, so the comparison above is a
          // statement about the same Mesh-enabled project on both sides.
          expect(live.services.web.networks).toBeDefined();
          expect(recovery.services.web.networks).toEqual(live.services.web.networks);
        }
        if (testCase.meshMatchesDiscovery) {
          // The Mesh-injected -f list replaced discovery, so it has to name the
          // files discovery would have picked: enabling Mesh must not change
          // which competing file the stack deploys.
          const discovered = renderModel([], stackDir, testCase.stack) as {
            services: Record<string, { command?: string[]; image?: string }>;
          };
          expect(live.services.web.command).toEqual(discovered.services.web.command);
          expect(live.services.web.image).toEqual(discovered.services.web.image);
        }
      } finally {
        for (const name of appliedEnv) delete process.env[name];
        vi.restoreAllMocks();
        DatabaseService.getInstance().deleteMeshStack(nodeId, testCase.stack);
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, testCase.stack, []);
      }
    });
  }

  it.each([
    ['the project .env', 'file'],
    ['the process environment', 'process'],
  ])('pins an absolute same-stack chain read from %s', async (_label, source) => {
    const stack = `layerabsolutepath${source}`;
    const stackDir = path.join(composeDir, stack);
    fs.mkdirSync(stackDir, { recursive: true });
    const rootAbs = path.join(stackDir, 'compose.yaml');
    const prodAbs = path.join(stackDir, 'prod.yaml');
    fs.writeFileSync(rootAbs, SERVICE('busybox:1.36.1', 'root'), 'utf8');
    fs.writeFileSync(prodAbs, SERVICE('busybox:1.36.1', 'production'), 'utf8');
    const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
    fs.writeFileSync(
      recoveryLayer,
      'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
      'utf8',
    );

    const chain = `${rootAbs}:${prodAbs}`;
    const appliedEnv: string[] = [];
    if (source === 'file') {
      fs.writeFileSync(path.join(stackDir, '.env'), `COMPOSE_FILE=${chain}\n`, 'utf8');
    } else {
      // Compose resolves the variable in the process environment above every
      // file, so both sources reach the same selection reader.
      process.env.COMPOSE_FILE = chain;
      appliedEnv.push('COMPOSE_FILE');
    }

    try {
      const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
      const { ComposeService } = await import('../../services/ComposeService');

      const captured = await resolveRollbackInventory(nodeId, stack);
      // An absolute spelling of a file inside the stack is the same layer as
      // its relative one, so the capture pins the relative name and does not
      // refuse a project Compose runs.
      expect(captured.coverageRefusal).toBeNull();
      expect(captured.invocation.composeLayers).toEqual(['compose.yaml', 'prod.yaml']);

      const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
        stack,
        ['config'],
        recoveryLayer,
        captured.invocation,
      );
      const recovery = renderModel(args.slice(1, args.indexOf('config')), stackDir, stack) as {
        services: Record<string, { command?: string[] }>;
      };
      const live = renderModel([], stackDir, stack) as {
        services: Record<string, { command?: string[] }>;
      };
      expect(live.services.web.command).toEqual(['echo', 'production']);
      expect(recovery.services.web.command).toEqual(live.services.web.command);
    } finally {
      for (const name of appliedEnv) delete process.env[name];
    }
  });

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

  it('holds the env file Compose loads from the selected project directory', async () => {
    const stack = 'layerprojectenv';
    const stackDir = path.join(composeDir, stack);
    fs.mkdirSync(path.join(stackDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  web:',
      '    extends:',
      '      file: sub/compose.yaml',
      '      service: web',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(stackDir, 'sub', 'compose.yaml'), SERVICE('busybox:1.36.1', '${SUBVAR}'), 'utf8');
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=sub/compose.yaml\n', 'utf8');
    fs.writeFileSync(path.join(stackDir, 'sub', '.env'), 'SUBVAR=captured\n', 'utf8');
    const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
    fs.writeFileSync(
      recoveryLayer,
      'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
      'utf8',
    );

    const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
    const { storedRestoreCoverage } = await import('../../services/updateGuard/readiness');
    const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
    const { ComposeService } = await import('../../services/ComposeService');

    const inventory = await resolveRollbackInventory(nodeId, stack);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.entries.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining(['.env', 'compose.yaml', 'sub/compose.yaml', 'sub/.env']),
    );
    expect(inventory.uncapturedInputs).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName: stack,
      generationId,
      inventory,
    });
    const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stack, generationId);
    expect(storedRestoreCoverage(stored)).toBe('complete');
    expect(stored.entries.map((entry) => entry.relativePath)).toContain('sub/.env');

    fs.writeFileSync(path.join(stackDir, 'sub', '.env'), 'SUBVAR=changed\n', 'utf8');
    const changed = renderModel([], stackDir, stack) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(changed.services.web.command).toEqual(['echo', 'changed']);

    const ctx = await resolveComposeProjectContextForGeneration(nodeId, stack, generationId);
    await ctx.restoreFromContext();
    expect(fs.readFileSync(path.join(stackDir, 'sub', '.env'), 'utf8')).toBe('SUBVAR=captured\n');

    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stack,
      ['config'],
      recoveryLayer,
      stored.invocation,
    );
    const recovery = renderModel(args.slice(1, args.indexOf('config')), stackDir, stack) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(recovery.services.web.command).toEqual(['echo', 'captured']);
    const live = renderModel([], stackDir, stack) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(live.services.web.command).toEqual(['echo', 'captured']);
  });

  it('reconstructs the interpolation environment a COMPOSE_FILE selection loaded', async () => {
    const stack = 'layerenvreconstruct';
    const stackDir = path.join(composeDir, stack);
    fs.mkdirSync(path.join(stackDir, 'sub'), { recursive: true });
    // The root file extends the selected service, so the inventory holds both
    // YAML files; the live run loads the selected project alone.
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  web:',
      '    extends:',
      '      file: sub/compose.yaml',
      '      service: web',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(
      path.join(stackDir, 'sub', 'compose.yaml'),
      'services:\n  web:\n    image: busybox:1.36.1\n    command: ["echo", "${ROOT_ONLY:-fallback}", "${SUBVAR:-nosub}", "${BOTH:-noboth}"]\n',
      'utf8',
    );
    // A root-only value, a project-only value, and a key both files define:
    // the live run applies the project file first and the root file second,
    // so the root value wins the shared key.
    fs.writeFileSync(
      path.join(stackDir, '.env'),
      'COMPOSE_FILE=sub/compose.yaml\nROOT_ONLY=captured-root\nBOTH=fromroot\n',
      'utf8',
    );
    fs.writeFileSync(path.join(stackDir, 'sub', '.env'), 'SUBVAR=captured-sub\nBOTH=fromsub\n', 'utf8');
    const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
    fs.writeFileSync(
      recoveryLayer,
      'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
      'utf8',
    );

    const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
    const { storedRestoreCoverage } = await import('../../services/updateGuard/readiness');
    const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
    const { ComposeService } = await import('../../services/ComposeService');

    const inventory = await resolveRollbackInventory(nodeId, stack);
    expect(inventory.coverageRefusal).toBeNull();
    // The generation claims complete coverage, so its invocation has to carry
    // the interpolation environment the live run used.
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.invocation.interpolationEnvFiles).toEqual(['sub/.env', '.env']);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({ nodeId, stackName: stack, generationId, inventory });
    const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stack, generationId);
    expect(storedRestoreCoverage(stored)).toBe('complete');
    expect(stored.invocation.interpolationEnvFiles).toEqual(['sub/.env', '.env']);

    // The literal values the live run renders, pinned so a recovery that
    // loses either file or flips the shared key cannot pass as equivalent.
    const live = renderModel([], stackDir, stack) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(live.services.web.command).toEqual(['echo', 'captured-root', 'captured-sub', 'fromroot']);

    // Both env files change on disk; the restore puts the captured bytes back.
    fs.writeFileSync(path.join(stackDir, 'sub', '.env'), 'SUBVAR=changed\nBOTH=changed-sub\n', 'utf8');
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=sub/compose.yaml\nROOT_ONLY=changed\n', 'utf8');
    const ctx = await resolveComposeProjectContextForGeneration(nodeId, stack, generationId);
    await ctx.restoreFromContext();
    expect(fs.readFileSync(path.join(stackDir, 'sub', '.env'), 'utf8')).toBe('SUBVAR=captured-sub\nBOTH=fromsub\n');
    expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).toBe(
      'COMPOSE_FILE=sub/compose.yaml\nROOT_ONLY=captured-root\nBOTH=fromroot\n',
    );

    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stack,
      ['config'],
      recoveryLayer,
      stored.invocation,
    );
    const prefix = args.slice(1, args.indexOf('config'));
    // The recorded order is the live run's: the project file first, the stack
    // root file last, so a key both define keeps the root value.
    expect(prefix).toEqual([
      '-f', 'sub/compose.yaml',
      '--env-file', path.join(stackDir, 'sub', '.env'),
      '--env-file', path.join(stackDir, '.env'),
      '-f', recoveryLayer,
    ]);

    const recovery = renderModel(prefix, stackDir, stack) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(recovery.services.web.command).toEqual(['echo', 'captured-root', 'captured-sub', 'fromroot']);
  });

  it('expands literal braces the way the Compose CLI does', async () => {
    const { expandComposeEnvTemplate } = await import('../../utils/composeDotenv');
    const cases: Array<{ name: string; template: string; env: string; set: boolean; expected: string | null }> = [
      { name: 'audit', template: '${UNSET:-foo{bar}', env: 'LABEL=${UNSET:-foo{bar}\n', set: false, expected: 'foo{bar' },
      { name: 'two', template: '${UNSET:-foo{bar}}', env: 'LABEL=${UNSET:-foo{bar}}\n', set: false, expected: 'foo{bar}' },
      { name: 'set-after', template: '${SET:-foo{bar}}TAIL', env: 'SET=value\nLABEL=${SET:-foo{bar}}TAIL\n', set: true, expected: 'valueTAIL' },
      { name: 'nested', template: '${A:-${B:-deep}}', env: 'LABEL=${A:-${B:-deep}}\n', set: false, expected: 'deep' },
      { name: 'nested-brace', template: '${A:-${B:-foo{bar}}}', env: 'LABEL=${A:-${B:-foo{bar}}}\n', set: false, expected: 'foo{bar}' },
      { name: 'unclosed', template: '${UNSET:-foo{bar', env: 'LABEL=${UNSET:-foo{bar\n', set: false, expected: null },
      { name: 'empty', template: '${}', env: 'LABEL=${}\n', set: false, expected: null },
    ];
    const root = fs.mkdtempSync(path.join(composeDir, 'brace-cli-'));
    const lookup = (set: boolean) => (name: string) => (set && name === 'SET' ? 'value' : undefined);
    try {
      for (const testCase of cases) {
        const dir = path.join(root, testCase.name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'compose.yaml'), SERVICE('busybox:1.36.1', '${LABEL}'), 'utf8');
        fs.writeFileSync(path.join(dir, '.env'), testCase.env, 'utf8');
        if (testCase.expected === null) {
          expect(() => renderModel([], dir, `brace${testCase.name}`), testCase.name).toThrow(/Invalid template/);
          expect(() => expandComposeEnvTemplate(testCase.template, lookup(testCase.set)), testCase.name)
            .toThrow(/Invalid template/);
          continue;
        }
        const model = renderModel([], dir, `brace${testCase.name}`) as {
          services: Record<string, { command?: string[] }>;
        };
        expect(model.services.web.command?.[1], testCase.name).toBe(testCase.expected);
        expect(expandComposeEnvTemplate(testCase.template, lookup(testCase.set)), testCase.name)
          .toBe(testCase.expected);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});