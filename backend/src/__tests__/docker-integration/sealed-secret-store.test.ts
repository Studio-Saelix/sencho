/**
 * Docker-backed: the node store writes a sealed secret into its labelled
 * volume with the purpose's owner and mode, the consuming user can read it,
 * any other user cannot, a replace is atomic for a reader, and the value
 * survives a store restart with no hub.
 *
 * Skipped automatically when Docker is unavailable, and when a volume of the
 * reserved name already exists on this host (the test never touches it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import Docker from 'dockerode';
import { cleanupTestDb, setupTestDb } from '../helpers/setupTestDb';

const VOLUME = 'sencho_edge_secret';
const PURPOSE = 'edge-tunnel-run-token' as const;
const SLOT = '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4';
const IMAGE = 'alpine:3.20';
const WHO = { actor: 'integration', path: 'test', method: 'POST' };

function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
}

function dockerAvailable(): boolean {
  try {
    docker(['info'], 8_000);
    return true;
  } catch {
    return false;
  }
}

function volumeExists(): boolean {
  try {
    docker(['volume', 'inspect', VOLUME], 8_000);
    return true;
  } catch {
    return false;
  }
}

const runnable = dockerAvailable() && !volumeExists();

function readAs(user: string): { ok: boolean; out: string } {
  try {
    const out = docker(['run', '--rm', '--network', 'none', '--user', user, '-v', `${VOLUME}:/s:ro`, IMAGE, 'cat', '/s/token']);
    return { ok: true, out };
  } catch (error: unknown) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? '') };
  }
}

describe.skipIf(!runnable)('sealed secret store on a real Docker volume', () => {
  let tmpDir: string;
  let store: import('../../services/sealedSecrets/SealedSecretStore').SealedSecretStore;
  let StoreClass: typeof import('../../services/sealedSecrets/SealedSecretStore').SealedSecretStore;
  const client = new Docker();

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ SealedSecretStore: StoreClass } = await import('../../services/sealedSecrets/SealedSecretStore'));
    StoreClass.resetForTests();
    store = StoreClass.getInstance();
    store.setDockerForTests(client);
  });

  afterAll(() => {
    try {
      docker(['volume', 'rm', '-f', VOLUME]);
    } catch (error: unknown) {
      console.warn('[sealed-secret-store integration] volume cleanup failed:', (error as Error).message);
    }
    StoreClass?.resetForTests();
    cleanupTestDb(tmpDir);
  });

  it('writes the token owned by the consuming user, mode 0400, readable only by that user', async () => {
    const secret = 'integration-token-value-0001';
    expect((await store.accept(PURPOSE, SLOT, 1, secret, WHO)).status).toBe('accepted');
    expect(JSON.parse(docker(['volume', 'inspect', VOLUME, '--format', '{{json .Labels}}']))).toEqual({ 'io.sencho.secret': PURPOSE });

    const stat = docker(['run', '--rm', '--network', 'none', '-v', `${VOLUME}:/s:ro`, IMAGE, 'stat', '-c', '%u:%g %a', '/s/token']).trim();
    expect(stat).toBe('65532:65532 400');
    const root = docker(['run', '--rm', '--network', 'none', '-v', `${VOLUME}:/s:ro`, IMAGE, 'stat', '-c', '%u:%g %a', '/s']).trim();
    expect(root).toBe('0:0 755');

    expect(readAs('65532:65532')).toEqual({ ok: true, out: secret });
    expect(readAs('65534:65534').ok).toBe(false);
  });

  it('replaces atomically: a reader never sees an empty or partial file', async () => {
    const secrets = ['a'.repeat(40), 'b'.repeat(90), 'c'.repeat(15), 'd'.repeat(200), 'e'.repeat(64)];
    const lengths = new Set([...secrets.map((s) => s.length), 'integration-token-value-0001'.length]);
    const reader = new Promise<string>((resolve, reject) => {
      execFile('docker', [
        'run', '--rm', '--network', 'none', '--user', '65532:65532', '-v', `${VOLUME}:/s:ro`, IMAGE,
        'sh', '-c', 'i=0; while [ $i -lt 600 ]; do wc -c < /s/token; i=$((i+1)); done',
      ], { encoding: 'utf8', timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    let generation = 2;
    for (const secret of secrets) {
      expect((await store.accept(PURPOSE, SLOT, generation, secret, WHO)).status).toBe('accepted');
      generation += 1;
    }
    const seen = (await reader).split('\n').map((line) => line.trim()).filter(Boolean).map(Number);
    expect(seen.length).toBeGreaterThan(0);
    for (const size of seen) expect(lengths.has(size)).toBe(true);
    expect(readAs('65532:65532').out).toBe(secrets[secrets.length - 1]);
  });

  it('keeps the value across a store restart, with no hub involved', async () => {
    const before = readAs('65532:65532').out;
    StoreClass.resetForTests();
    const restarted = StoreClass.getInstance();
    restarted.setDockerForTests(client);
    expect(restarted.describe(PURPOSE, SLOT).state).toBe('present');
    expect(readAs('65532:65532').out).toBe(before);
  });

  it('removes the file and keeps the volume', async () => {
    const generation = StoreClass.getInstance().describe(PURPOSE, SLOT).purposeGeneration + 1;
    expect((await StoreClass.getInstance().remove(PURPOSE, SLOT, generation, WHO)).status).toBe('deleted');
    expect(readAs('65532:65532').ok).toBe(false);
    expect(volumeExists()).toBe(true);
  });
});
