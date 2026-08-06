import { describe, it, expect } from 'vitest';
import { parseDeclaredInputs } from '../helpers/composeInputParse';
import type { DeclaredInput, DynamicInput } from '../types/gitProjectManifest';

/** In-memory repo fixture: maps repo paths to contents. */
function repo(files: Record<string, string>) {
    return {
        read: (p: string): string | null => files[p] ?? null,
        files,
    };
}

function parse(files: Record<string, string>, projectRoot: string | null = null) {
    const r = repo(files);
    const primary = Object.keys(files).find((p) => p.endsWith('compose.yaml') || p === 'compose.yml') ?? 'compose.yaml';
    return {
        result: parseDeclaredInputs([{ path: primary, content: files[primary] ?? '' }], {
            projectRoot,
            read: r.read,
        }),
        files: r.files,
    };
}

function byKind(result: ReturnType<typeof parse>['result'], kind: string): DeclaredInput[] {
    return result.inputs.filter((i) => i.kind === kind);
}

describe('parseDeclaredInputs', () => {
    it('emits the interpolation env at the project root', () => {
        const { result } = parse({ 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
        const interp = byKind(result, 'interpolation-env');
        expect(interp).toHaveLength(1);
        expect(interp[0].sourcePath).toBe('.env');
        expect(interp[0].baseDir).toBe('project-root');
    });

    it('uses the project root for the interpolation env path', () => {
        const { result } = parse({ 'deploy/compose.yaml': 'services: {}\n' }, 'deploy');
        const interp = byKind(result, 'interpolation-env');
        expect(interp[0].sourcePath).toBe('deploy/.env');
    });

    it('walks include list form and recurses into included files', () => {
        const { result } = parse({
            'compose.yaml': 'include:\n  - common/redis.yaml\nservices:\n  web:\n    image: nginx\n',
            'common/redis.yaml': 'services:\n  redis:\n    image: redis\n    env_file: common/redis.env\n',
        });
        const includes = byKind(result, 'include');
        expect(includes.map((i) => i.sourcePath)).toEqual(['common/redis.yaml']);
        const envFiles = byKind(result, 'env_file');
        expect(envFiles.map((e) => e.sourcePath)).toContain('common/redis.env');
        // Included file's env_file resolves relative to its own directory.
        expect(envFiles.find((e) => e.sourcePath === 'common/redis.env')?.baseDir).toBe('compose-file-dir');
    });

    it('walks include map form with include-specific env_file', () => {
        const { result } = parse({
            'compose.yaml': 'include:\n  - path: apps/api.yaml\n    env_file: apps/api.env\n',
            'apps/api.yaml': 'services:\n  api:\n    image: api\n',
        });
        expect(byKind(result, 'include')[0].sourcePath).toBe('apps/api.yaml');
        const includeEnv = byKind(result, 'include-env');
        expect(includeEnv).toHaveLength(1);
        expect(includeEnv[0].sourcePath).toBe('apps/api.env');
        expect(includeEnv[0].baseDir).toBe('project-root');
    });

    it('detects include cycles', () => {
        const { result } = parse({
            'compose.yaml': 'include:\n  - a.yaml\n',
            'a.yaml': 'include:\n  - compose.yaml\nservices: {}\n',
        });
        expect(result.parseErrors.some((e) => e.includes('cycle'))).toBe(true);
    });

    it('reports unreadable include targets as parse errors', () => {
        const { result } = parse({
            'compose.yaml': 'include:\n  - missing.yaml\n',
        });
        expect(result.parseErrors.some((e) => e.includes('missing.yaml'))).toBe(true);
    });

    it('walks extends.file recursion and reports cycles', () => {
        const { result } = parse({
            'compose.yaml': 'services:\n  web:\n    extends:\n      file: base/web.yaml\n      service: web-base\n',
            'base/web.yaml': 'services:\n  web-base:\n    image: nginx\n    label_file: base/labels.txt\n',
        });
        const extendsRefs = byKind(result, 'extends');
        expect(extendsRefs.map((e) => e.sourcePath)).toEqual(['base/web.yaml']);
        expect(byKind(result, 'label_file')[0].sourcePath).toBe('base/labels.txt');
    });

    it('does not recurse into same-file string-form extends', () => {
        const { result } = parse({
            'compose.yaml': 'services:\n  web:\n    extends: base\n  base:\n    image: nginx\n',
        });
        expect(byKind(result, 'extends')).toHaveLength(0);
    });

    it('walks service env_file in string, list and map forms', () => {
        const { result } = parse({
            'compose.yaml': `services:
  a:
    image: a
    env_file: a.env
  b:
    image: b
    env_file:
      - shared.env
      - b.env
  c:
    image: c
    env_file:
      path: c.env
      required: true
`,
        });
        const envFiles = byKind(result, 'env_file');
        expect(envFiles.map((e) => e.sourcePath).sort()).toEqual(['a.env', 'b.env', 'c.env', 'shared.env'].sort());
    });

    it('classifies top-level configs and secrets file forms', () => {
        const { result } = parse({
            'compose.yaml': `configs:
  nginx-conf:
    file: nginx/nginx.conf
  ext:
    external: true
  env-injected:
    environment: NGNIX_CONFIG
secrets:
  db-password:
    file: secrets/db.env
  sops-secret:
    environment: DB_PASSWORD
services:
  web:
    image: nginx
    configs: [nginx-conf]
    secrets: [db-password]
`,
        });
        const configs = byKind(result, 'config');
        expect(configs.map((c) => c.sourcePath)).toContain('nginx/nginx.conf');
        const secrets = byKind(result, 'secret');
        expect(secrets.map((s) => s.sourcePath)).toContain('secrets/db.env');
        // external/env forms become unmanaged placeholders (null source).
        expect(configs.filter((c) => c.sourcePath === null)).toHaveLength(2);
        expect(secrets.filter((s) => s.sourcePath === null)).toHaveLength(1);
    });

    it('walks build context, dockerfile, secrets and additional contexts', () => {
        const { result } = parse({
            'compose.yaml': `services:
  web:
    build:
      context: web
      dockerfile: Dockerfile.dev
      secrets:
        - npm-token
        - id: ssh-key
          file: web/ssh-key
      additional_contexts:
        certs: web/certs
`,
        });
        const contexts = byKind(result, 'build-context');
        expect(contexts.map((c) => c.sourcePath)).toEqual(['web']);
        expect(byKind(result, 'dockerfile')[0].sourcePath).toBe('Dockerfile.dev');
        const buildSecrets = byKind(result, 'build-secret');
        expect(buildSecrets.map((s) => s.sourcePath)).toEqual([null, 'web/ssh-key']);
        expect(byKind(result, 'build-additional-context')[0].sourcePath).toBe('web/certs');
    });

    it('walks string-form build context', () => {
        const { result } = parse({
            'compose.yaml': 'services:\n  web:\n    build: web\n',
        });
        expect(byKind(result, 'build-context')[0].sourcePath).toBe('web');
    });

    it('classifies bind mounts: relative, absolute and named volumes', () => {
        const { result } = parse({
            'compose.yaml': `services:
  web:
    image: nginx
    volumes:
      - ./data:/data
      - ../shared:/shared
      - /etc/hosts:/etc/hosts:ro
      - ~/cache:/cache
      - named-vol:/vol
      - type: bind
        source: ./config
        target: /config
      - type: volume
        source: other-vol
        target: /other
`,
        });
        const binds = byKind(result, 'bind-mount');
        expect(binds.map((b) => b.sourcePath)).toEqual(['./data', '../shared', null, null, './config']);
        expect(binds.map((b) => b.baseDir)).toEqual(['project-root', 'project-root', 'host', 'host', 'project-root']);
    });

    it('routes dynamic paths into the dynamic list, not inputs', () => {
        const { result } = parse({
            'compose.yaml': `services:
  web:
    image: nginx
    env_file: \${ENV_FILE:-default.env}
`,
        });
        expect(byKind(result, 'env_file')).toHaveLength(0);
        const dynamic = result.dynamic as DynamicInput[];
        expect(dynamic.some((d) => d.kind === 'env_file' && d.sourcePath.includes('${ENV_FILE'))).toBe(true);
    });

    it('records out-of-bound and URL include targets for the classifier', () => {
        const { result } = parse({
            'compose.yaml': `include:
  - ../outside.yaml
  - https://example.com/remote.yaml
`,
        });
        const includes = byKind(result, 'include');
        expect(includes.map((i) => i.sourcePath)).toEqual(['../outside.yaml', 'https://example.com/remote.yaml']);
    });

    it('enforces the include depth cap', () => {
        const files: Record<string, string> = {};
        files['compose.yaml'] = 'include:\n  - f1.yaml\nservices: {}\n';
        for (let i = 1; i < 19; i++) {
            files[`f${i}.yaml`] = `include:\n  - f${i + 1}.yaml\nservices: {}\n`;
        }
        files['f19.yaml'] = 'services: {}\n';
        const { result } = parse(files);
        expect(result.parseErrors.some((e) => e.includes('depth 16'))).toBe(true);
    });

    it('reports unparseable compose files as parse errors', () => {
        const { result } = parse({
            'compose.yaml': 'services: [unclosed\n',
        });
        expect(result.parseErrors.some((e) => e.includes('Cannot parse'))).toBe(true);
    });
});
