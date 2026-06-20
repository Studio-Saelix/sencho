/**
 * resolveStackEnvSources: env_file existence metadata, the project .env
 * interpolation source, inline environment keys, interpolation refs, and the
 * multi-file Git deploy-spec path. Real filesystem + DB; no Docker.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { resolveStackEnvSources } from '../helpers/envFileResolution';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

function composeDir(): string { return process.env.COMPOSE_DIR as string; }

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(composeDir(), stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  nodeId = (DatabaseService.getInstance().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

describe('resolveStackEnvSources', () => {
  it('models the project .env as the interpolation source and reads inline keys + refs', async () => {
    writeStack('s1', {
      'compose.yaml': 'services:\n  web:\n    image: nginx:${TAG:-latest}\n    environment:\n      APP_PORT: "8080"\n      FROM_SHELL: ${FROM_SHELL}\n',
      '.env': 'TAG=1.0\n',
    });
    const r = await resolveStackEnvSources(nodeId, 's1');
    const dotenv = r.envFiles.find(f => f.isInterpolationSource);
    expect(dotenv?.existence).toBe('present');
    expect(dotenv?.isInjectionSource).toBe(false);
    expect(r.inlineEnvKeysByService.web).toContain('APP_PORT');
    expect(r.interpolationRefs.map(x => x.name).sort()).toEqual(['FROM_SHELL', 'TAG']);
  });

  it('flags a missing required env_file but not an optional one', async () => {
    writeStack('s2', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file:\n      - ./present.env\n      - ./gone.env\n      - path: ./optional.env\n        required: false\n',
      'present.env': 'A=1\n',
    });
    const r = await resolveStackEnvSources(nodeId, 's2');
    const byRaw = (raw: string) => r.envFiles.find(f => f.rawPaths.includes(raw));
    expect(byRaw('./present.env')?.existence).toBe('present');
    expect(byRaw('./gone.env')).toMatchObject({ existence: 'missing', required: true, isInjectionSource: true });
    expect(byRaw('./optional.env')).toMatchObject({ existence: 'missing', required: false });
  });

  it('marks interpolated and escaping env_file paths as unverifiable', async () => {
    writeStack('s3', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file:\n      - ${ENV_DIR}/x.env\n      - ../escape.env\n',
    });
    const r = await resolveStackEnvSources(nodeId, 's3');
    for (const f of r.envFiles.filter(x => x.isInjectionSource)) {
      expect(f.existence).toBe('unverifiable');
      expect(f.resolvedPath).toBeNull();
    }
  });

  it('treats .env doubling as env_file: .env as one physical file with both roles', async () => {
    writeStack('s4', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file:\n      - .env\n',
      '.env': 'SHARED=1\n',
    });
    const r = await resolveStackEnvSources(nodeId, 's4');
    const dotenvFiles = r.envFiles.filter(f => f.isInterpolationSource);
    expect(dotenvFiles).toHaveLength(1);
    expect(dotenvFiles[0]).toMatchObject({ isInterpolationSource: true, isInjectionSource: true, existence: 'present' });
  });

  it('reads env_file declared only in a Git multi-file override', async () => {
    writeStack('s5', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n',
      'override.yaml': 'services:\n  web:\n    env_file:\n      - ./override.env\n',
      'override.env': 'O=1\n',
    });
    vi.spyOn(DatabaseService.getInstance(), 'getGitSource').mockReturnValue({
      applied_deploy_spec: { files: ['compose.yaml', 'override.yaml'], contextDir: null },
    } as unknown as ReturnType<typeof DatabaseService.prototype.getGitSource>);
    const r = await resolveStackEnvSources(nodeId, 's5');
    expect(r.composeFiles).toHaveLength(2);
    expect(r.envFiles.some(f => f.rawPaths.includes('./override.env') && f.existence === 'present')).toBe(true);
  });
});
