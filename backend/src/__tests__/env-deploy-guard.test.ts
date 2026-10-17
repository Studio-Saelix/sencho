/**
 * The deploy guard (on by default): blocks a deploy/update when required env vars are
 * missing, only when the setting is on. Compose's own stderr is the authoritative
 * signal (so an empty `REQ=` with `${REQ:?err}` is caught, which a key-only check
 * could not), and the guard runs before any backup/cleanup/pull/up side effect.
 *
 * The GitOps decrypt overlay is the other input, and it has the opposite
 * confidentiality regime: its env files are plaintext secrets, so Compose's
 * diagnostic for it is withheld rather than parsed. A `:?` message is itself
 * interpolated, so the diagnostic can carry a decrypted value, and those tests
 * run the real Compose binary to keep that behavior pinned.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import { NodeRegistry } from '../services/NodeRegistry';
import SelfIdentityService from '../services/SelfIdentityService';
import { gitSecretsAreaBase } from '../services/gitops/managedPaths';
import { WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT } from '../helpers/decryptedComposeOutput';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;
const originalSenchoMode = process.env.SENCHO_MODE;

// The stderr `docker compose config` emits for an unset OR empty `${REQ:?err}`.
const REQUIRED_MISSING_STDERR = 'required variable REQ is missing a value: must be provided';

function setBlocking(on: boolean): void {
  vi.spyOn(DatabaseService.getInstance(), 'getGlobalSettings')
    .mockReturnValue({ env_block_deploy_on_missing_required: on ? '1' : '0' } as Record<string, string>);
}

function stubStderr(stderr: string, rendered: string | null = null) {
  const compose = ComposeService.getInstance(nodeId);
  const spy = vi.spyOn(compose, 'renderConfig').mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false });
  return { compose, spy };
}

/**
 * A real decrypt-overlay directory: a stack area under the git-secrets root,
 * with the plaintext project Compose would actually read there.
 */
function writeOverlay(stackName: string, compose: string, env: string): string {
  const dir = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), compose);
  fs.writeFileSync(path.join(dir, '.env'), env);
  return dir;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  nodeId = (DatabaseService.getInstance().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

describe('assertRequiredEnvPresent', () => {
  it('does not render when the setting is off', async () => {
    setBlocking(false);
    const { compose, spy } = stubStderr(REQUIRED_MISSING_STDERR);
    await (compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s');
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks when a required variable is unset or empty', async () => {
    setBlocking(true);
    const { compose } = stubStderr(REQUIRED_MISSING_STDERR);
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .rejects.toThrow(/REQ/);
  });

  it('names every missing variable with plural grammar', async () => {
    setBlocking(true);
    const { compose } = stubStderr('required variable A is missing a value\nrequired variable B is missing a value');
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .rejects.toThrow(/variables A, B are missing/);
  });

  it('allows when all required variables are present', async () => {
    setBlocking(true);
    const { compose } = stubStderr('', '{"services":{}}');
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .resolves.toBeUndefined();
  });

  it('does not block on a render failure unrelated to required vars', async () => {
    setBlocking(true);
    const { compose } = stubStderr('yaml: line 2: mapping values are not allowed');
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .resolves.toBeUndefined();
  });

  it('falls through without blocking when the settings read fails', async () => {
    vi.spyOn(DatabaseService.getInstance(), 'getGlobalSettings').mockImplementation(() => { throw new Error('db down'); });
    const { compose, spy } = stubStderr(REQUIRED_MISSING_STDERR);
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('deployStack/updateStack guard ordering', () => {
  it('deployStack throws before taking an atomic backup when a required var is missing', async () => {
    setBlocking(true);
    const compose = ComposeService.getInstance(nodeId);
    vi.spyOn(compose, 'renderConfig').mockResolvedValue({ rendered: null, stderr: REQUIRED_MISSING_STDERR, code: 1, timedOut: false });
    const backup = vi.spyOn(compose as unknown as { createAtomicBackup(...a: unknown[]): Promise<void> }, 'createAtomicBackup').mockResolvedValue(undefined);
    await expect(compose.deployStack('s', undefined, true)).rejects.toThrow(/REQ/);
    expect(backup).not.toHaveBeenCalled();
  });

  it('updateStack throws before taking an atomic backup when a required var is missing', async () => {
    setBlocking(true);
    const compose = ComposeService.getInstance(nodeId);
    vi.spyOn(compose, 'renderConfig').mockResolvedValue({ rendered: null, stderr: REQUIRED_MISSING_STDERR, code: 1, timedOut: false });
    const backup = vi.spyOn(compose as unknown as { createAtomicBackup(...a: unknown[]): Promise<void> }, 'createAtomicBackup').mockResolvedValue(undefined);
    await expect(compose.updateStack('s', undefined, true)).rejects.toThrow(/REQ/);
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('assertRequiredEnvPresent over a GitOps decrypt overlay', () => {
  // The value Compose must never be asked to hand back. A `:?` message is itself
  // interpolated, so `${SECRET}` resolves into the very text Compose reports and
  // lands on the phrase the name-only parser keys on.
  const SENTINEL = 'audit_guard_secret_word';
  const NESTED_COMPOSE = [
    'services:',
    '  app:',
    '    image: alpine:3',
    '    environment:',
    '      - "FAIL=${MISSING:?required variable ${SECRET} is missing}"',
    '',
  ].join('\n');

  function guard(compose: ComposeService, stackName: string, stackDirOverride?: string): Promise<void> {
    return (compose as unknown as {
      assertRequiredEnvPresent: (s: string, d?: string) => Promise<void>;
    }).assertRequiredEnvPresent(stackName, stackDirOverride);
  }

  it('publishes the withheld refusal, not the interpolated value, for a nested :? message', async () => {
    setBlocking(true);
    const overlayDir = writeOverlay('guard-overlay-nested', NESTED_COMPOSE, `SECRET=${SENTINEL}\n`);

    // Control: the real binary really does print the resolved value. Without
    // this, a green assertion below could just mean Compose failed differently.
    let composeStderr = '';
    try {
      execFileSync('docker', ['compose', 'config', '--quiet'], {
        cwd: overlayDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
    } catch (err) {
      composeStderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    expect(composeStderr).toContain(SENTINEL);

    const error = await guard(ComposeService.getInstance(nodeId), 'guard-overlay-nested', overlayDir)
      .then(() => null, (e: Error) => e);

    // The refusal still blocks, with Sencho's own wording and the deploy remedy.
    expect(error?.message).toBe(
      `Deploy blocked: ${WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT}then deploy again.`,
    );
    expect(error?.message).not.toContain(SENTINEL);
    expect(error?.message).not.toContain('MISSING');
  });

  it('allows an overlay render that resolved', async () => {
    setBlocking(true);
    const overlayDir = writeOverlay(
      'guard-overlay-ok',
      'services:\n  app:\n    image: alpine:3\n',
      `SECRET=${SENTINEL}\n`,
    );
    await expect(guard(ComposeService.getInstance(nodeId), 'guard-overlay-ok', overlayDir))
      .resolves.toBeUndefined();
  });

  it('leaves the live project naming the variables it is missing', async () => {
    // The control for the two tests above: without an overlay the guard still
    // reads Compose's diagnostic, because that project is not a secret store.
    setBlocking(true);
    const { compose } = stubStderr(REQUIRED_MISSING_STDERR);
    await expect(guard(compose, 's')).rejects.toThrow(
      'Deploy blocked: required environment variable REQ is missing. Define it in a .env or env_file, then deploy again.',
    );
  });
});

describe('pilot bind guard over a GitOps decrypt overlay', () => {
  // The Pilot guard asks whether a bind resolves under the project directory when
  // the host maps that directory somewhere else, because a relative bind then
  // lands at a host path Sencho did not choose. A Git deploy runs Compose out of a
  // decrypt overlay, so the guard has to read the overlay: the live project may
  // not render at all, and where it does render it describes a model the deploy is
  // not about to run. These run the real Compose binary on both sides.
  const RELATIVE_BIND_COMPOSE = [
    'services:',
    '  app:',
    '    image: alpine:3',
    '    ports:',
    '      - "${PORT}:80"',
    '    volumes:',
    '      - ./data:/data',
    '',
  ].join('\n');
  const ABSOLUTE_BIND_COMPOSE = RELATIVE_BIND_COMPOSE.replace('./data:/data', '/srv/postgres/data:/data');
  /** A published port held in ciphertext: Compose cannot turn it into a port. */
  const CIPHERTEXT_PORT = 'ENC[AES256_GCM,data:AAAA,iv:BBBB,tag:CCCC,type:str]';
  const HOST_COMPOSE_DIR = '/srv/example-apps';

  /** A bind source interpolated from a var. Compose takes the ciphertext for a
   *  relative path, so the live render succeeds and puts the bind inside the live
   *  stack dir, while the decrypted value beside it names a real external path.
   *  The name has to be absent from the environment: Compose reads the process
   *  environment ahead of `.env`, so a var the test harness sets would win. */
  const INTERPOLATED_VAR = 'SENCHO_TEST_DATA_DIR';
  const INTERPOLATED_BIND_COMPOSE = [
    'services:',
    '  app:',
    '    image: alpine:3',
    '    volumes:',
    '      - type: bind',
    `        source: "\${${INTERPOLATED_VAR}}"`,
    '        target: /data',
    '',
  ].join('\n');

  function writeLiveStack(stackName: string, compose: string, env: string): void {
    const dir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), compose);
    fs.writeFileSync(path.join(dir, '.env'), env);
  }

  function pilotGuard(stackName: string, overlayDir?: string): Promise<void> {
    return (ComposeService.getInstance(nodeId) as unknown as {
      assertSafePilotBindMapping: (s: string, o?: string) => Promise<void>;
    }).assertSafePilotBindMapping(stackName, overlayDir);
  }

  beforeEach(() => {
    // Restated per test: the file's afterEach restores every spy between cases.
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: HOST_COMPOSE_DIR, destination: NodeRegistry.getInstance().getComposeDir(nodeId) },
    ]);
    process.env.SENCHO_MODE = 'pilot';
  });

  afterAll(() => {
    if (originalSenchoMode === undefined) delete process.env.SENCHO_MODE;
    else process.env.SENCHO_MODE = originalSenchoMode;
  });

  it('refuses a relative bind the live project could not render', async () => {
    const stackName = 'pilot-overlay-relative';
    writeLiveStack(stackName, RELATIVE_BIND_COMPOSE, `PORT=${CIPHERTEXT_PORT}\n`);
    const overlayDir = writeOverlay(stackName, RELATIVE_BIND_COMPOSE, 'PORT=8080\n');

    // Controls on both renders, so a green refusal below cannot mean the guard
    // simply found nothing to look at: the live one really does fail on the
    // ciphertext port, and the overlay one is rewritten onto the live stack
    // directory, which is the path a mismatched Pilot mapping must still refuse.
    const compose = ComposeService.getInstance(nodeId);
    expect((await compose.renderConfig(stackName)).rendered).toBeNull();
    const overlay = await compose.renderConfig(stackName, { stackDirOverride: overlayDir });
    expect(overlay.rendered).not.toBeNull();
    const liveData = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName, 'data');
    expect(overlay.rendered).toContain(liveData);
    expect(overlay.rendered).not.toContain(path.join(overlayDir, 'data'));

    const error = await pilotGuard(stackName, overlayDir).then(() => null, (e: Error) => e);

    expect(error?.message).toContain('1:1');
    expect(error?.message).toContain(path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId)));
    expect(error?.message).toContain(HOST_COMPOSE_DIR);
    expect(error?.message).not.toContain(CIPHERTEXT_PORT);
  });

  it('allows an interpolated absolute bind the live render resolves inside the project dir', async () => {
    // The other side of the same rule. Compose accepts the ciphertext as a
    // relative path, so the live render succeeds and puts the bind under the live
    // stack dir, which would refuse a deploy whose overlay declares a perfectly
    // ordinary external path. Reading the overlay is what lets it through.
    const stackName = 'pilot-overlay-interpolated';
    expect(INTERPOLATED_VAR in process.env, 'the interpolated var must not exist in the environment').toBe(false);
    writeLiveStack(stackName, INTERPOLATED_BIND_COMPOSE, `${INTERPOLATED_VAR}=${CIPHERTEXT_PORT}\n`);
    const overlayDir = writeOverlay(stackName, INTERPOLATED_BIND_COMPOSE, `${INTERPOLATED_VAR}=/srv/postgres/data\n`);

    // Control: the live render really does resolve the ciphertext into the live
    // stack dir, which is the reading the guard must not act on.
    const live = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    expect(live.rendered).not.toBeNull();
    expect(live.rendered).toContain(path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName));

    await expect(pilotGuard(stackName, overlayDir)).resolves.toBeUndefined();
  });

  it('refuses a bind that escapes the overlay with a parent segment', async () => {
    // `..` resolves out of the overlay directory but stays in the stack's area
    // under the secrets root, so the base has to sit where it sits for a live
    // stack: one level above the project directory. A base of the overlay
    // directory itself would clear this bind, which the live check does not.
    const stackName = 'pilot-overlay-parent';
    const parentBindCompose = RELATIVE_BIND_COMPOSE.replace('./data:/data', '../data:/data');
    writeLiveStack(stackName, parentBindCompose, `PORT=${CIPHERTEXT_PORT}\n`);
    const overlayDir = writeOverlay(stackName, parentBindCompose, 'PORT=8080\n');

    // Control: `../data` is rewritten to the live stack's parent, the same path
    // the declaration has on a deploy that does not use an overlay.
    const overlay = await ComposeService.getInstance(nodeId).renderConfig(stackName, { stackDirOverride: overlayDir });
    expect(overlay.rendered).not.toBeNull();
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    expect(overlay.rendered).toContain(path.join(composeDir, 'data'));
    expect(overlay.rendered).not.toContain(path.join(path.dirname(overlayDir), 'data'));

    const error = await pilotGuard(stackName, overlayDir).then(() => null, (e: Error) => e);

    expect(error?.message).toContain('1:1');
  });

  it('refuses a bind naming the compose tree outright', async () => {
    // The other tree to stay out of. An overlay adds its own tree to the set, it
    // does not replace the compose tree: a bind can name that one directly, and it
    // is the tree the Pilot Agent maps. Reading only the overlay's tree would clear
    // this, which the live arm does not.
    const stackName = 'pilot-overlay-into-compose-tree';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const intoCompose = RELATIVE_BIND_COMPOSE.replace(
      './data:/data',
      `${path.join(composeDir, stackName, 'data')}:/data`,
    );
    writeLiveStack(stackName, intoCompose, `PORT=${CIPHERTEXT_PORT}\n`);
    const overlayDir = writeOverlay(stackName, intoCompose, 'PORT=8080\n');

    // Control: the bind really does resolve inside the compose tree.
    const overlay = await ComposeService.getInstance(nodeId).renderConfig(stackName, { stackDirOverride: overlayDir });
    expect(overlay.rendered).not.toBeNull();
    expect(overlay.rendered).toContain(path.join(composeDir, stackName, 'data'));

    const error = await pilotGuard(stackName, overlayDir).then(() => null, (e: Error) => e);

    expect(error?.message).toContain('1:1');
  });

  it('refuses a relative bind an included file resolves into the compose tree', async () => {
    // A relative bind in an included file resolves against that file's own
    // directory, not the project directory, so an absolute `include` aimed at the
    // live stack routes a relative bind into the compose tree while the overlay's
    // own tree never sees it. The compose tree in the set is what catches it.
    const stackName = 'pilot-overlay-include';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const sharedDir = path.join(composeDir, stackName, 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, 'inc.yaml'),
      // The included service is named apart from the including file's service and
      // carries its own image on purpose. Compose 2.x refuses a model where an
      // included file and the including file declare the same service
      // (`services.<name> conflicts with imported resource`), and it also refuses
      // an included service that has neither an image nor a build context; 5.x
      // merges the two declarations and fills both gaps. Written self-contained,
      // this renders on either version, and the bind still resolves against the
      // included file's own directory, which is the routing under test.
      'services:\n  helper:\n    image: alpine:3\n    volumes:\n      - ./idata:/idata\n',
    );
    const includeCompose = [
      'include:',
      `  - ${path.join(sharedDir, 'inc.yaml')}`,
      'services:',
      '  app:',
      '    image: alpine:3',
      '    ports:',
      '      - "${PORT}:80"',
      '',
    ].join('\n');
    writeLiveStack(stackName, includeCompose, `PORT=${CIPHERTEXT_PORT}\n`);
    const overlayDir = writeOverlay(stackName, includeCompose, 'PORT=8080\n');

    // Control: the included file's relative bind really does resolve against the
    // included file's own directory, which is the routing this test relies on.
    const overlay = await ComposeService.getInstance(nodeId).renderConfig(stackName, { stackDirOverride: overlayDir });
    expect(overlay.rendered).not.toBeNull();
    expect(overlay.rendered).toContain(path.join(sharedDir, 'idata'));

    const error = await pilotGuard(stackName, overlayDir).then(() => null, (e: Error) => e);

    expect(error?.message).toContain('1:1');
  });

  it('allows the same stack when the bind source is absolute and external', async () => {
    const stackName = 'pilot-overlay-absolute';
    writeLiveStack(stackName, ABSOLUTE_BIND_COMPOSE, `PORT=${CIPHERTEXT_PORT}\n`);
    const overlayDir = writeOverlay(stackName, ABSOLUTE_BIND_COMPOSE, 'PORT=8080\n');

    await expect(pilotGuard(stackName, overlayDir)).resolves.toBeUndefined();
  });

  it('clears the guard entirely when the host maps the compose directory 1:1', async () => {
    // The remedy the refusal tells the operator to apply has to work, and this is
    // also the control on the early return the overlay work sits behind. With the
    // same absolute path on both sides there is no mapping to disagree with, so a
    // relative bind is fine. The project renders on purpose here: if the guard ever
    // stopped deciding on the mapping alone, it would render this one, find the
    // relative bind inside the compose tree, and refuse.
    const stackName = 'pilot-mapping-1to1';
    writeLiveStack(stackName, RELATIVE_BIND_COMPOSE, 'PORT=8080\n');
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: composeDir, destination: composeDir },
    ]);

    // Control: this project really does carry a bind the guard refuses when the
    // mapping disagrees, so the pass below is the mapping decision and not an
    // unreadable render.
    const live = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    expect(live.rendered).not.toBeNull();
    expect(live.rendered).toContain(path.join(composeDir, stackName, 'data'));

    await expect(pilotGuard(stackName)).resolves.toBeUndefined();
  });

  it('leaves the live-only behaviour alone when no overlay is in play', async () => {
    // Unchanged from before the overlay existed: a live render that cannot be
    // read leaves the guard without a decision, and the network gate refuses.
    const stackName = 'pilot-live-unreadable';
    writeLiveStack(stackName, RELATIVE_BIND_COMPOSE, `PORT=${CIPHERTEXT_PORT}\n`);

    await expect(pilotGuard(stackName)).resolves.toBeUndefined();
  });

  it('still refuses a relative bind on a live-only deploy', async () => {
    // The control for the live path: reading live is the whole guard there, so a
    // readable live render with a relative bind has to refuse.
    const stackName = 'pilot-live-relative';
    writeLiveStack(stackName, RELATIVE_BIND_COMPOSE, 'PORT=8080\n');

    const error = await pilotGuard(stackName).then(() => null, (e: Error) => e);

    expect(error?.message).toContain('1:1');
  });
});
