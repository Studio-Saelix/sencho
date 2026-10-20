/**
 * Restore has to select the project the generation captured. Live discovery at
 * restore time may name a newer Compose root, an implicit override, or a managed
 * input that only became a link after capture; none of them may decide what the
 * recovered stack runs, and none of them may leave a shared target deleted.
 *
 * The inventory here is the real one, so an ordinary authored stack is captured
 * with an empty compose prefix and docker compose auto-discovery, which is what
 * makes the wrong-root case reachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

const mockState = { composeDir: '', dataDir: '', projectEnvFiles: [] as string[] };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => mockState.projectEnvFiles,
      isMeshStackEnabled: () => false,
    }),
  },
}));

import { resolveRollbackInventory } from '../services/rollbackInventory';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';
import {
  resolveComposeProjectContext,
  resolveComposeProjectContextForGeneration,
} from '../services/composeProjectContext';

const NODE = 1;

describe('restore selects the captured Compose project', () => {
  let composeDir: string;
  let dataDir: string;
  let stackDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-sel-'));
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-seldata-'));
    mockState.composeDir = composeDir;
    mockState.dataDir = dataDir;
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    mockState.projectEnvFiles = [];
    stackDir = path.join(composeDir, 'app');
    await fsPromises.mkdir(stackDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(composeDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  });

  it('restores a partial generation without deleting a later compose root or override', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'include:\n  - path: ../shared/base.yaml\nservices:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // Partial on purpose: the shared include is a recorded omission.
    expect(captured.uncapturedInputs.length).toBeGreaterThan(0);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'app', generationId);
    expect(manifest.invocation.composeArgsPrefix).toEqual([]);
    expect(manifest.invocation.explicitComposeFiles).toEqual(['docker-compose.yml']);

    // A later edit adds a higher-priority root and an implicit override.
    const laterRoot = 'services:\n  web:\n    image: nginx\n    command: ["false"]\n';
    const laterOverride = 'services:\n  web:\n    command: ["false"]\n';
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), laterRoot, 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'docker-compose.override.yml'), laterOverride, 'utf8');

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    const restored = await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8');
    expect(restored).toBe('include:\n  - path: ../shared/base.yaml\nservices:\n  web:\n    image: nginx\n');
    // The uncaptured shared include can pull in a local override, so a name
    // that looks like a Compose layer is no proof of ownership: both later
    // files stay, and the recovery run pins the captured layer instead of
    // letting discovery decide.
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(laterRoot);
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.override.yml'), 'utf8')).toBe(laterOverride);

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(NODE).buildComposeArgsWithRecoveryOverride(
      'app',
      ['up', '-d'],
      null,
      manifest.invocation,
    );
    // An explicit -f list suppresses Compose's own discovery and the implicit
    // override merge, so the later root cannot shadow the captured project.
    expect(args).toEqual(['compose', '-f', 'docker-compose.yml', 'up', '-d']);
  });

  it('keeps a link that was deliberately left out of the capture', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared', 'base.yaml'), path.join(stackDir, 'linked.yaml'));
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'include:\n  - ./linked.yaml\nservices:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedRelativePaths).toContain('linked.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect((await fsPromises.lstat(path.join(stackDir, 'linked.yaml'))).isSymbolicLink()).toBe(true);
  });

  it('removes a managed env path that became a link after capture and keeps its target', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    env_file:\n      - path: ./later.env\n        required: false\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // Absent at capture and not an omission, so this generation is complete.
    expect(captured.uncapturedInputs).toEqual([]);
    expect(captured.uncapturedRelativePaths).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The optional env file appears as a link to a file outside this stack.
    await fsPromises.symlink(path.join(composeDir, 'shared', 'common.env'), path.join(stackDir, 'later.env'));

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    await expect(fsPromises.lstat(path.join(stackDir, 'later.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'common.env'), 'utf8')).toBe('A=1\n');
  });

  it('keeps a bind-mount link that appeared after capture, and the storage it reaches', async () => {
    const persistent = path.join(composeDir, 'persistent');
    await fsPromises.mkdir(persistent, { recursive: true });
    await fsPromises.writeFile(path.join(persistent, 'marker.txt'), 'app-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    volumes:\n      - ./data:/data\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // `data` is absent at capture: the generation is complete and holds no
    // application-data path at all, so nothing it records names `data`.
    expect(captured.uncapturedInputs).toEqual([]);
    expect(captured.uncapturedRelativePaths).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The bind source becomes a link to persistent application storage, and
    // the compose file moves on so the restore has real work to do.
    await fsPromises.symlink(persistent, path.join(stackDir, 'data'));
    const later = 'services:\n  web:\n    image: nginx:2\n    volumes:\n      - ./data:/data\n';
    await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), later, 'utf8');

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // The restore ran, and still left the application's storage connection
    // alone: the link survives and still reaches the same data.
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8')).toBe(
      'services:\n  web:\n    image: nginx\n    volumes:\n      - ./data:/data\n',
    );
    expect((await fsPromises.lstat(path.join(stackDir, 'data'))).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readFile(path.join(stackDir, 'data', 'marker.txt'), 'utf8')).toBe('app-data\n');
    expect(await fsPromises.readFile(path.join(persistent, 'marker.txt'), 'utf8')).toBe('app-data\n');
  });

  it('keeps a bind-mount link that replaced a directory, while a managed env link is still removed', async () => {
    const persistent = path.join(composeDir, 'persistent');
    await fsPromises.mkdir(persistent, { recursive: true });
    await fsPromises.writeFile(path.join(persistent, 'marker.txt'), 'app-data\n', 'utf8');
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.mkdir(path.join(stackDir, 'data'));
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      [
        'services:',
        '  web:',
        '    image: nginx',
        '    env_file:',
        '      - path: ./later.env',
        '        required: false',
        '    volumes:',
        '      - ./data:/data',
        '',
      ].join('\n'),
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The bind directory at capture is no input at all, and the optional env
    // file is absent, so the generation is complete.
    expect(captured.uncapturedInputs).toEqual([]);
    expect(captured.uncapturedRelativePaths).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // `data` turns into a link to persistent storage while `later.env`
    // turns into a link out of the stack: one is application data the
    // restore must not touch, the other a managed input it owns.
    await fsPromises.rm(path.join(stackDir, 'data'), { recursive: true });
    await fsPromises.symlink(persistent, path.join(stackDir, 'data'));
    await fsPromises.symlink(path.join(composeDir, 'shared', 'common.env'), path.join(stackDir, 'later.env'));

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect((await fsPromises.lstat(path.join(stackDir, 'data'))).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readFile(path.join(stackDir, 'data', 'marker.txt'), 'utf8')).toBe('app-data\n');
    await expect(fsPromises.lstat(path.join(stackDir, 'later.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'common.env'), 'utf8')).toBe('A=1\n');
  });

  it('keeps a bind-mounted file that appeared after capture, and the storage it reaches', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    volumes:\n      - ./seed.json:/seed.json\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // `seed.json` is absent at capture: the generation is complete and holds
    // no application-data path at all.
    expect(captured.uncapturedInputs).toEqual([]);
    expect(captured.uncapturedRelativePaths).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The bind source appears as a regular file the generation never held,
    // and the compose file moves on so the restore has real work to do.
    await fsPromises.writeFile(path.join(stackDir, 'seed.json'), '{"token":"app-data"}\n', 'utf8');
    const later = 'services:\n  web:\n    image: nginx:2\n    volumes:\n      - ./seed.json:/seed.json\n';
    await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), later, 'utf8');

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // The restore ran, and the application data it never captured is still
    // there: a live bind entry is not a managed cleanup candidate.
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8')).toBe(
      'services:\n  web:\n    image: nginx\n    volumes:\n      - ./seed.json:/seed.json\n',
    );
    expect(await fsPromises.readFile(path.join(stackDir, 'seed.json'), 'utf8')).toBe('{"token":"app-data"}\n');
  });

  it('keeps a path both bind-mounted and env-filed when the file appears after capture', async () => {
    const original = [
      'services:',
      '  store:',
      '    image: nginx',
      '    volumes:',
      '      - ./shared.env:/run/secrets/shared.env',
      '  web:',
      '    image: nginx',
      '    env_file:',
      '      - path: ./shared.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // `shared.env` is absent at capture: the generation is complete.
    expect(captured.uncapturedInputs).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The path appears as a regular file and the compose file moves on. In
    // the live inventory the env_file input is walked last, so the merged
    // entry kind is the managed one and only the application-data ownership
    // record keeps the path out of the forward.
    await fsPromises.writeFile(path.join(stackDir, 'shared.env'), 'TOKEN=app-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      original.replace('image: nginx\n    volumes', 'image: nginx:2\n    volumes'),
      'utf8',
    );
    const live = await resolveRollbackInventory(NODE, 'app');
    const merged = live.entries.find((entry) => entry.relativePath === 'shared.env');
    expect(merged?.dependencyKind).toBe('env_file');
    expect(live.applicationDataPaths).toContain('shared.env');

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // The restore ran and the file survived it.
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(path.join(stackDir, 'shared.env'), 'utf8')).toBe('TOKEN=app-data\n');
  });

  it.each([
    ['a variable that names a directory', './${DATA_SUBDIR}/data.env', './sub/data.env', 'sub/data.env'],
    ['a variable that names the whole source', '${DATA_FILE}', './data.env', 'data.env'],
  ])('keeps application data a dynamic bind resolves to: %s', async (_label, bindSource, envFile, livePath) => {
    await fsPromises.mkdir(path.join(stackDir, path.dirname(livePath)), { recursive: true });
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      `      - ${bindSource}:/data`,
      '    env_file:',
      `      - path: ${envFile}`,
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The env file is absent, so the generation is complete.
    expect(captured.uncapturedInputs).toEqual([]);
    // The substitution is unknown, so the capture records the declared source
    // rather than a literal tail: the tail names data.env here, not sub/data.env.
    expect(captured.dynamicApplicationDataSources).toEqual([bindSource]);
    expect(captured.applicationDataPaths).not.toContain(livePath);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The path appears as application data and the compose file moves on. The
    // live inventory sees only the managed env-file entry; the generation's
    // unresolved application-data record keeps every unrecorded live file.
    await fsPromises.writeFile(path.join(stackDir, livePath), 'TOKEN=application-data\n', 'utf8');
    const movedOn = original.replace('image: nginx', 'image: nginx:2');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), movedOn, 'utf8');
    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.entries.find((entry) => entry.relativePath === livePath)?.dependencyKind).toBe('env_file');
    expect(live.dynamicApplicationDataSources).toEqual([bindSource]);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // Restore returned the captured compose file and left the application data
    // it never held in place.
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(path.join(stackDir, livePath), 'utf8')).toBe('TOKEN=application-data\n');
  });

  it('keeps a storage link a dynamic bind resolves to', async () => {
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    const target = path.join(composeDir, 'shared', 'data.env');
    await fsPromises.writeFile(target, 'TOKEN=application-data\n', 'utf8');
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - ./${DATA_SUBDIR}/data.env:/data',
      '    env_file:',
      '      - path: ./sub/data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.dynamicApplicationDataSources).toEqual(['./${DATA_SUBDIR}/data.env']);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The bind source appears as a link to persistent storage the generation
    // never held, and the compose file moves on.
    const link = path.join(stackDir, 'sub', 'data.env');
    await fsPromises.symlink(target, link);
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      original.replace('image: nginx', 'image: nginx:2'),
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // Restore unlinked nothing: the storage link and the data behind it survive.
    const restoredLink = await fsPromises.lstat(link);
    expect(restoredLink.isSymbolicLink()).toBe(true);
    expect(await fsPromises.readlink(link)).toBe(target);
    expect(await fsPromises.readFile(target, 'utf8')).toBe('TOKEN=application-data\n');
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
  });

  it('keeps live application data when a stored generation predates dynamic sources', async () => {
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - ./${DATA_SUBDIR}/data.env:/data',
      '    env_file:',
      '      - path: ./sub/data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.dynamicApplicationDataSources).toEqual(['./${DATA_SUBDIR}/data.env']);
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // A generation written before this field existed looks exactly like this.
    const manifestPath = path.join(
      RollbackGenerationStore.getGenerationDir(NODE, 'app', generationId),
      'generation.json',
    );
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    delete manifest.dynamicApplicationDataSources;
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    // The live project still declares the dynamic source, so restore cannot
    // know which live path it resolves to even though the old manifest has no
    // record of it.
    await fsPromises.writeFile(path.join(stackDir, 'sub', 'data.env'), 'TOKEN=application-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      original.replace('image: nginx', 'image: nginx:2'),
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(path.join(stackDir, 'sub', 'data.env'), 'utf8')).toBe(
      'TOKEN=application-data\n',
    );
  });

  it('keeps application data when a refused live inventory clears its ownership records', async () => {
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    env_file:',
      '      - path: ./sub/data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The interpolated bind arrives after capture, the optional env file now
    // holds application data, and unrelated case-colliding configured env
    // files make the live inventory refuse. A refused inventory returns no
    // application-data records, but it also cannot prove any live path is safe
    // to delete, so restore must not forward its entries as cleanup.
    const withBind = original.replace(
      '    env_file:',
      '    volumes:\n      - ./${DATA_SUBDIR}/data.env:/data\n    env_file:',
    ).replace('image: nginx', 'image: nginx:2');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), withBind, 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'sub', 'data.env'), 'TOKEN=application-data\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'Probe.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'probe.env'), 'A=1\n', 'utf8');
    mockState.projectEnvFiles = ['Probe.env', 'probe.env'];

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.coverageRefusal).toContain('Case-colliding managed paths');
    expect(live.dynamicApplicationDataSources).toEqual([]);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(path.join(stackDir, 'sub', 'data.env'), 'utf8')).toBe(
      'TOKEN=application-data\n',
    );
  });

  it('keeps an absolute bind-mounted file inside the stack that also serves as an env file', async () => {
    const dataPath = path.join(stackDir, 'data.env');
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      `      - ${dataPath}:/data`,
      '    env_file:',
      '      - path: ./data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The absolute spelling names a file inside the stack, so it records the
    // same stack-relative ownership a relative spelling would.
    expect(captured.applicationDataPaths).toEqual(['data.env']);
    expect(captured.uncapturedInputs).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(dataPath, 'TOKEN=application-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      original.replace('image: nginx', 'image: nginx:2'),
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(dataPath, 'utf8')).toBe('TOKEN=application-data\n');
  });

  it('keeps an authored bind whose outside alias targets a stack file', async () => {
    const dataPath = path.join(stackDir, 'data.env');
    const aliasPath = path.join(composeDir, 'data-alias.env');
    await fsPromises.symlink(dataPath, aliasPath);
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      `      - ${aliasPath}:/data`,
      '    env_file:',
      '      - path: ./data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The target does not exist at capture, so the alias cannot be mapped yet.
    // Once the file appears, the live inventory resolves the same alias to the
    // stack path and keeps it out of live forwarding.
    expect(captured.applicationDataPaths).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(dataPath, 'TOKEN=application-data\n', 'utf8');

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.applicationDataPaths).toEqual(['data.env']);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(dataPath, 'utf8')).toBe('TOKEN=application-data\n');
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
  });

  it('keeps an authored bind that names an in-stack symlink to a managed file', async () => {
    const dataPath = path.join(stackDir, 'data.env');
    const aliasPath = path.join(stackDir, 'alias.env');
    await fsPromises.symlink(dataPath, aliasPath);
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - ./alias.env:/data',
      '    env_file:',
      '      - path: ./data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.applicationDataPaths).toContain('alias.env');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The alias was dangling at capture. The target appears later as the live
    // env file; the bind mounts it, so it is data rather than a stale managed
    // addition.
    await fsPromises.writeFile(dataPath, 'TOKEN=application-data\n', 'utf8');

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.applicationDataPaths).toContain('data.env');

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(dataPath, 'utf8')).toBe('TOKEN=application-data\n');
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
  });

  it('keeps application data when a bind mounts the stack root', async () => {
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - .:/workspace',
      '    env_file:',
      '      - path: ./app.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The whole stack is mounted, so no live path is provably disposable.
    expect(captured.dynamicApplicationDataSources).toEqual(['<bind source contains the stack>']);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'TOKEN=application-data\n', 'utf8');

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.dynamicApplicationDataSources).toEqual(['<bind source contains the stack>']);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'app.env'), 'utf8')).toBe(
      'TOKEN=application-data\n',
    );
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
  });

  it('keeps managed files beneath a bind-mounted directory', async () => {
    const dataDir = path.join(stackDir, 'data');
    await fsPromises.mkdir(dataDir, { recursive: true });
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - ./data:/data',
      '    env_file:',
      '      - path: ./data/app.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The bind is a directory, so every file beneath it is mounted data.
    expect(captured.applicationDataPaths).toContain('data');
    expect(captured.applicationDataPathPrefixes).toEqual(['data']);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The optional env file was absent at capture, so the generation holds no
    // entry for it. It appears later as data inside the bound directory.
    await fsPromises.writeFile(path.join(dataDir, 'app.env'), 'TOKEN=application-data\n', 'utf8');

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.applicationDataPathPrefixes).toEqual(['data']);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(dataDir, 'app.env'), 'utf8')).toBe(
      'TOKEN=application-data\n',
    );
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
  });

  it('keeps application data when the live project selects an uncaptured COMPOSE_FILE layer', async () => {
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    const root = [
      'services:',
      '  web:',
      '    image: nginx',
      '    env_file:',
      '      - path: ./sub/data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), root, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedInputs).toEqual([]);
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // After capture the stack switches to a custom layer that declares the
    // bind. The capture never parsed that layer, so the only live record of
    // the change is the layer's omission itself; the live env-file entry from
    // the conventional root must not become a cleanup candidate because of it.
    await fsPromises.writeFile(
      path.join(stackDir, '.env'),
      'COMPOSE_FILE=prod.yaml\nDATA_SUBDIR=sub\n',
      'utf8',
    );
    await fsPromises.writeFile(
      path.join(stackDir, 'prod.yaml'),
      [
        'services:',
        '  web:',
        '    volumes:',
        '      - ./${DATA_SUBDIR}/data.env:/data',
        '',
      ].join('\n'),
      'utf8',
    );
    await fsPromises.writeFile(path.join(stackDir, 'sub', 'data.env'), 'TOKEN=application-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      root.replace('image: nginx', 'image: nginx:2'),
      'utf8',
    );

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.invocation.composeLayers).toEqual(['prod.yaml']);
    expect(live.uncapturedInputs.join(' ')).toContain('prod.yaml');
    expect(live.uncapturedInputs.join(' ')).toContain('is not captured');
    expect(live.unparsedComposeSources).toEqual(['prod.yaml']);
    expect(live.dynamicApplicationDataSources).toEqual([]);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(root);
    expect(await fsPromises.readFile(path.join(stackDir, 'sub', 'data.env'), 'utf8')).toBe(
      'TOKEN=application-data\n',
    );
  });

  it('keeps application data when the live project adds an outside include', async () => {
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    const root = [
      'services:',
      '  web:',
      '    image: nginx',
      '    env_file:',
      '      - path: ./sub/data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), root, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedInputs).toEqual([]);
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The outside include arrives after capture and declares a bind to the
    // same file the conventional root lists as an optional env file. Its
    // declarations were never read, so the live env-file entry must not become
    // a cleanup candidate.
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(
      path.join(composeDir, 'shared', 'base.yaml'),
      [
        'services:',
        '  web:',
        '    volumes:',
        '      - ../app/sub/data.env:/data',
        '',
      ].join('\n'),
      'utf8',
    );
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      [
        'include:',
        '  - ../shared/base.yaml',
        'services:',
        '  web:',
        '    image: nginx:2',
        '    env_file:',
        '      - path: ./sub/data.env',
        '        required: false',
        '',
      ].join('\n'),
      'utf8',
    );
    await fsPromises.writeFile(path.join(stackDir, 'sub', 'data.env'), 'TOKEN=application-data\n', 'utf8');

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.uncapturedInputs.join(' ')).toContain('include ../shared/base.yaml');
    expect(live.unparsedComposeSources).toContain('../shared/base.yaml');
    expect(live.applicationDataPaths).toEqual([]);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(root);
    expect(await fsPromises.readFile(path.join(stackDir, 'sub', 'data.env'), 'utf8')).toBe(
      'TOKEN=application-data\n',
    );
  });

  it('keeps an absolute bind under the physical path of a linked compose root', async () => {
    const physicalRoot = path.join(composeDir, 'physical');
    const linkedRoot = path.join(composeDir, 'linked');
    const physicalStack = path.join(physicalRoot, 'app');
    await fsPromises.mkdir(physicalStack, { recursive: true });
    await fsPromises.symlink(physicalRoot, linkedRoot, 'dir');
    mockState.composeDir = linkedRoot;

    const dataPath = path.join(physicalStack, 'data.env');
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      `      - ${dataPath}:/data`,
      '    env_file:',
      '      - path: ./data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(physicalStack, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The bind uses the physical spelling, which is outside the lexical stack
    // root. It still names the same stack file as ./data.env, so the ownership
    // record must carry the stack-relative name.
    expect(captured.applicationDataPaths).toEqual(['data.env']);
    expect(captured.uncapturedInputs).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(dataPath, 'TOKEN=application-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(physicalStack, 'compose.yaml'),
      original.replace('image: nginx', 'image: nginx:2'),
      'utf8',
    );

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.applicationDataPaths).toEqual(['data.env']);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(physicalStack, 'compose.yaml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(dataPath, 'utf8')).toBe('TOKEN=application-data\n');
  });

  it('keeps a bind whose relative parent spelling re-enters the stack', async () => {
    const dataPath = path.join(stackDir, 'data.env');
    const original = [
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - ../app/data.env:/data',
      '    env_file:',
      '      - path: ./data.env',
      '        required: false',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The spelling leaves the stack lexically and resolves back to the same
    // file as ./data.env. One path must carry the application-data record.
    expect(captured.applicationDataPaths).toEqual(['data.env']);
    expect(captured.uncapturedInputs).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(dataPath, 'TOKEN=application-data\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      original.replace('image: nginx', 'image: nginx:2'),
      'utf8',
    );

    const live = await resolveRollbackInventory(NODE, 'app');
    expect(live.applicationDataPaths).toEqual(['data.env']);

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
    expect(await fsPromises.readFile(dataPath, 'utf8')).toBe('TOKEN=application-data\n');
  });

  it('refuses capture when a selected COMPOSE_FILE layer links outside the compose directory', async () => {
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-f3-out-'));
    try {
      await fsPromises.writeFile(
        path.join(outsideDir, 'chosen.yaml'),
        'services:\n  web:\n    image: nginx\n',
        'utf8',
      );
      await fsPromises.symlink(path.join(outsideDir, 'chosen.yaml'), path.join(stackDir, 'chosen.yaml'));
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      await fsPromises.writeFile(path.join(stackDir, '.env'), 'COMPOSE_FILE=chosen.yaml\n', 'utf8');

      // Recovery refuses this same target before Compose runs, so the capture
      // has to refuse before any deploy begins with a generation its own
      // rollback cannot launch.
      const ctx = await resolveComposeProjectContext(NODE, 'app');
      const refusal = ctx.backupFromContext('update');
      await expect(refusal).rejects.toMatchObject({ code: 'ROLLBACK_COVERAGE_UNAVAILABLE' });
      await expect(refusal).rejects.toThrow(/chosen.yaml links outside the compose directory/);
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('captures a selected COMPOSE_FILE layer linking inside the compose root, and recovery accepts it', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(
      path.join(composeDir, 'shared', 'chosen.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );
    await fsPromises.symlink(path.join(composeDir, 'shared', 'chosen.yaml'), path.join(stackDir, 'chosen.yaml'));
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'COMPOSE_FILE=chosen.yaml\n', 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.invocation.composeLayers).toEqual(['chosen.yaml']);
    expect(captured.uncapturedRelativePaths).toContain('chosen.yaml');
    expect(captured.uncapturedInputs.join(' ')).toContain('chosen.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'app', generationId);

    // A recovery run names the shared target through the link, which is the
    // input the generation recorded: the argument builder accepts it.
    const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
    await fsPromises.writeFile(
      recoveryLayer,
      'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
      'utf8',
    );
    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(NODE).buildComposeArgsWithRecoveryOverride(
      'app',
      ['config'],
      recoveryLayer,
      manifest.invocation,
    );
    expect(args).toEqual(expect.arrayContaining(['-f', 'chosen.yaml']));
  });

  it('pins only the root Compose selects when the stack holds more than one', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    command: ["false"]\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // Both roots are captured, but a run with no explicit -f loads one.
    expect(captured.entries.map((e) => e.relativePath).sort()).toEqual(['compose.yaml', 'docker-compose.yml']);
    expect(captured.invocation.composeLayers).toEqual(['compose.yaml']);

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(NODE).buildComposeArgsWithRecoveryOverride(
      'app',
      ['up', '-d'],
      null,
      captured.invocation,
    );
    // Merging both roots would run a configuration the deploy never ran.
    expect(args).toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);
  });

  it.each([
    ['braced', '${STACK_DIR}/compose.yaml'],
    ['bare', '$STACK_DIR/compose.yaml'],
  ])('keeps a %s dynamic include target even when it is a compose filename', async (_form, includePath) => {
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      `include:\n  - ${includePath}\nservices:\n  web:\n    image: nginx\n`,
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedInputs).toHaveLength(1);
    // The generation cannot read the substitution, so the one name it could
    // resolve to is an input it does not hold.
    expect(captured.uncapturedRelativePaths).toContain('compose.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // A partial rollback uses the current content of an input it could not
    // hold. Deleting this one would break the include it feeds.
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(
      'services:\n  web:\n    image: nginx\n',
    );
  });

  it.each([
  ['a bare variable', '$FILE'],
  ['a defaulted variable', '${FILE:-compose.yaml}'],
  ['a braced variable', '${FILE}'],
])('keeps a compose filename that %s include could resolve to', async (_label, includePath) => {
  // The whole filename is interpolated, so no literal tail identifies the file
  // and the capture cannot put it on its uncaptured-paths list. The shared env
  // it comes from lives outside this stack, so it is a recorded omission.
  await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
  await fsPromises.writeFile(path.join(composeDir, 'shared', 'paths.env'), 'FILE=compose.yaml\n', 'utf8');
  await fsPromises.writeFile(
    path.join(composeDir, 'shared', 'base.yaml'),
    'services: {}\n',
    'utf8',
  );
  await fsPromises.writeFile(
    path.join(stackDir, 'docker-compose.yml'),
    `include:\n  - ${includePath}\nservices:\n  web:\n    image: nginx\n`,
    'utf8',
  );
  await fsPromises.writeFile(
    path.join(stackDir, '.env'),
    `SHARED_ENV=${path.join(composeDir, 'shared', 'paths.env')}\n`,
    'utf8',
  );

  const captured = await resolveRollbackInventory(NODE, 'app');
  expect(captured.coverageRefusal).toBeNull();
  expect(captured.uncapturedInputs.length).toBeGreaterThan(0);

  const generationId = randomUUID();
  await RollbackGenerationStore.captureGeneration({
    nodeId: NODE,
    stackName: 'app',
    generationId,
    inventory: captured,
  });

  // The shared env later resolves the include to a conventional compose file
  // that now exists in the stack. Its name proves nothing about ownership.
  const required = 'services:\n  extra:\n    image: busybox\n';
  await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), required, 'utf8');

  const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
  await ctx.restoreFromContext();

  expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(required);
});

it('reinstates an external symlink when a restore is later reconciled', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    env_file:\n      - path: ./later.env\n        required: false\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    const sharedEnv = path.join(composeDir, 'shared', 'common.env');
    await fsPromises.symlink(sharedEnv, path.join(stackDir, 'later.env'));
    // A compose file the generation restores, so reconciliation has real work.
    // The env_file declaration stays: dropping it would stop later.env from
    // being a declared input at all.
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx:2\n    env_file:\n      - path: ./later.env\n        required: false\n',
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // Restore unlinked the leaf. The link is gone but its target is untouched.
    await expect(fsPromises.lstat(path.join(stackDir, 'later.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsPromises.readFile(sharedEnv, 'utf8')).toBe('A=1\n');

    // Compose up or the health probe failed, so the deployment is reconciled.
    const reverted = await RollbackGenerationStore.reconcileInterruptedRestore(NODE, 'app', generationId);
    expect(reverted).toBe(true);

    const relinked = await fsPromises.lstat(path.join(stackDir, 'later.env'));
    expect(relinked.isSymbolicLink()).toBe(true);
    expect(await fsPromises.readlink(path.join(stackDir, 'later.env'))).toBe(sharedEnv);
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8')).toBe(
      'services:\n  web:\n    image: nginx:2\n    env_file:\n      - path: ./later.env\n        required: false\n',
    );
    expect(await fsPromises.readFile(sharedEnv, 'utf8')).toBe('A=1\n');
  });

  it('refuses to restore when a parent directory of a managed path escaped', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    env_file:\n      - path: ./config/other.env\n        required: false\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'other.env'), 'B=2\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared'), path.join(stackDir, 'config'));

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await expect(ctx.restoreFromContext()).rejects.toThrow();

    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'common.env'), 'utf8')).toBe('A=1\n');
    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'other.env'), 'utf8')).toBe('B=2\n');
  });

  it('keeps a local override that an uncaptured external include extends from', async () => {
    // The shared project is captured as an omission, and it can refer back to a
    // conventional compose name inside this stack. That name proves nothing
    // about ownership, so restore must not delete it.
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    const sharedFile = path.join(composeDir, 'shared', 'base.yaml');
    await fsPromises.writeFile(sharedFile, 'services:\n  shared:\n    image: busybox\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'include:\n  - path: ../shared/base.yaml\nservices:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedInputs.join(' ')).toContain('../shared/base.yaml');
    expect(captured.invocation.composeLayers).toEqual(['docker-compose.yml']);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'app', generationId);

    // The shared file now extends a service from a local override that appeared
    // after capture, so the override is a dependency of the uncaptured input.
    const helper = 'services:\n  helper:\n    image: busybox\n    command: ["true"]\n';
    await fsPromises.writeFile(path.join(stackDir, 'compose.override.yml'), helper, 'utf8');
    await fsPromises.writeFile(
      sharedFile,
      'services:\n  shared:\n    extends:\n      file: ../app/compose.override.yml\n      service: helper\n',
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.override.yml'), 'utf8')).toBe(helper);
    expect(await fsPromises.readFile(sharedFile, 'utf8')).toContain('extends');
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8')).toBe(
      'include:\n  - path: ../shared/base.yaml\nservices:\n  web:\n    image: nginx\n',
    );

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(NODE).buildComposeArgsWithRecoveryOverride(
      'app',
      ['up', '-d'],
      null,
      manifest.invocation,
    );
    expect(args).toEqual(['compose', '-f', 'docker-compose.yml', 'up', '-d']);
  });

  it('restores a stack whose main compose file links into the shared compose directory', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    const sharedFile = path.join(composeDir, 'shared', 'base.yaml');
    await fsPromises.writeFile(sharedFile, 'services:\n  web:\n    image: nginx\n', 'utf8');
    const link = path.join(stackDir, 'compose.yaml');
    await fsPromises.symlink(sharedFile, link);
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'TAG=1\n', 'utf8');

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // The main file is the shared target's content, so the generation pins the
    // layer without holding its bytes.
    expect(captured.invocation.composeLayers).toEqual(['compose.yaml']);
    expect(captured.entries.map((e) => e.relativePath)).toEqual(['.env']);
    expect(captured.uncapturedRelativePaths).toContain('compose.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'app', generationId);

    // The shared file moves on, a higher-priority root appears, and the env file
    // is edited after capture.
    const sharedNow = 'services:\n  web:\n    image: nginx:2\n';
    await fsPromises.writeFile(sharedFile, sharedNow, 'utf8');
    const laterRoot = 'services:\n  web:\n    image: busybox\n';
    await fsPromises.writeFile(path.join(stackDir, 'compose.yml'), laterRoot, 'utf8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'TAG=2\n', 'utf8');

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // The captured env file comes back, the link stays a link, its target keeps
    // the content a rollback reads, and the later root is not deleted.
    expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf8')).toBe('TAG=1\n');
    expect((await fsPromises.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readFile(sharedFile, 'utf8')).toBe(sharedNow);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yml'), 'utf8')).toBe(laterRoot);

    // Recovery pins the captured layer, which resolves through the link.
    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(NODE).buildComposeArgsWithRecoveryOverride(
      'app',
      ['up', '-d'],
      null,
      manifest.invocation,
    );
    expect(args).toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);
  });
});