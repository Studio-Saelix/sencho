import { describe, it, expect } from 'vitest';
import { isDynamicPath, listComposeServiceNames, parseComposeYaml, parseDeclaredInputs } from '../helpers/composeInputParse';
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

/** The reported shape: two flat scalar anchors reused once per service. */
function scalarAliasCompose(serviceCount: number): string {
    let text = 'x-r: &r unless-stopped\nx-e: &e shared.env\nservices:\n';
    for (let i = 0; i < serviceCount; i++) {
        text += `  s${i}:\n    image: alpine\n    restart: *r\n    env_file: *e\n`;
    }
    return text;
}

/** Ordinary reuse of a harmless merge anchor, a scalar env_file anchor and a sequence anchor. */
function aliasHeavyCompose(serviceCount: number): string {
    let text = `x-defaults: &defaults
  restart: unless-stopped
  logging:
    driver: json-file
x-env-file: &env-file shared.env
x-volumes: &volumes
  - ./data:/data
services:
`;
    for (let i = 0; i < serviceCount; i++) {
        text += `  svc${i}:
    <<: *defaults
    image: alpine
    env_file: *env-file
    volumes: *volumes
`;
    }
    return text;
}

/** Ten anchors in a binary chain: nine doubling steps ending in 512 leaves. */
function nestedAliasCompose(levels: number): string {
    let text = 'x-a0: &a0 [end]\n';
    for (let i = 1; i < levels; i++) {
        text += `x-a${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
    }
    return `${text}services: {}\n`;
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

    it('walks declarations of every Compose-accepted service key', () => {
        const { result } = parse({
            'compose.yaml': [
                'services:',
                '  1e999:',
                '    image: alpine',
                '    env_file: first.env',
                '  Infinity:',
                '    image: alpine',
                '    env_file: second.env',
                '',
            ].join('\n'),
        });
        const envFiles = byKind(result, 'env_file');
        expect(envFiles.map((entry) => entry.sourcePath).sort()).toEqual(['first.env', 'second.env']);
    });

    it('walks include list form and recurses into included files', () => {
        const { result } = parse({
            'compose.yaml': 'include:\n  - common/redis.yaml\nservices:\n  web:\n    image: nginx\n',
            // Included files resolve their relative paths against their own
            // directory (each included file is its own project).
            'common/redis.yaml': 'services:\n  redis:\n    image: redis\n    env_file: redis.env\n',
        });
        const includes = byKind(result, 'include');
        expect(includes.map((i) => i.sourcePath)).toEqual(['common/redis.yaml']);
        const envFiles = byKind(result, 'env_file');
        expect(envFiles.map((e) => e.sourcePath)).toContain('common/redis.env');
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
        // Already resolved by the parser; the classifier must not re-resolve it.
        expect(includeEnv[0].baseDir).toBe('repo-root');
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
            // Included files resolve their own relative paths against their
            // own directory (each included file is its own project).
            'base/web.yaml': 'services:\n  web-base:\n    image: nginx\n    label_file: labels.txt\n',
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
            'compose.yaml': `secrets:
  ssh-key:
    file: web/ssh-key
services:
  web:
    build:
      context: web
      dockerfile: Dockerfile.dev
      secrets:
        - npm-token
        - id: ssh-key
          source: ssh-key
      additional_contexts:
        certs: web/certs
`,
        });
        const contexts = byKind(result, 'build-context');
        expect(contexts.map((c) => c.sourcePath)).toEqual(['web']);
        expect(byKind(result, 'dockerfile')[0].sourcePath).toBe('Dockerfile.dev');
        // String-form and long-syntax (source = top-level secret name) build
        // secrets are both recorded as unmanaged references; the top-level
        // secrets walk emits the actual file.
        const buildSecrets = byKind(result, 'build-secret');
        expect(buildSecrets.map((s) => s.sourcePath)).toEqual([null, null]);
        expect(byKind(result, 'secret').map((s) => s.sourcePath)).toContain('web/ssh-key');
        expect(byKind(result, 'build-additional-context')[0].sourcePath).toBe('web/certs');
    });

    it('defaults an omitted build context to the project directory', () => {
        const { result } = parse({
            'compose.yaml': 'services:\n  web:\n    build:\n      dockerfile: Dockerfile\n',
        });
        const contexts = byKind(result, 'build-context');
        expect(contexts.map((c) => c.sourcePath)).toEqual(['.']);
        // The classifier resolves '.' against the per-file project directory
        // (context dir, base file dir, or the declaring file's own dir).
        expect(contexts[0].baseDir).toBe('compose-file-dir');
    });

    it('never treats a build-secret source as a file path', () => {
        const { result } = parse({
            'compose.yaml': `secrets:
  build-key:
    external: true
services:
  web:
    build:
      context: web
      secrets:
        - id: build-key
          source: build-key
`,
        });
        // The secret name must not be searched as a file in the repository.
        const buildSecrets = byKind(result, 'build-secret');
        expect(buildSecrets.map((s) => s.sourcePath)).toEqual([null]);
        // The referenced (external) top-level secret is recorded unmanaged.
        expect(byKind(result, 'secret').some((s) => s.sourcePath === null)).toBe(true);
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
        // Relative binds resolve against the project base; absolute and
        // ../-escaping binds are host paths (never adopted from the repo).
        // Host binds keep their raw spelling so the caller can recognize an
        // absolute path that points back inside the stack.
        expect(binds.map((b) => b.sourcePath)).toEqual(['data', '../shared', '/etc/hosts', '~/cache', 'config']);
        expect(binds.map((b) => b.baseDir)).toEqual(['project-root', 'host', 'host', 'host', 'project-root']);
        expect(binds.map((b) => b.materializedPath)).toEqual(['data', null, null, null, 'config']);
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

    it('walks label_file in string and list forms', () => {
        const { result } = parse({
            'compose.yaml': `services:
  a:
    image: a
    label_file: a.labels
  b:
    image: b
    label_file:
      - b1.labels
      - b2.labels
`,
        });
        const labelFiles = byKind(result, 'label_file');
        expect(labelFiles.map((l) => l.sourcePath).sort()).toEqual(['a.labels', 'b1.labels', 'b2.labels'].sort());
    });

    it('walks additional_contexts in mapping and NAME=VALUE list forms', () => {
        const { result } = parse({
            'compose.yaml': `services:
  a:
    build:
      context: web
      additional_contexts:
        certs: web/certs
  b:
    build:
      context: web
      additional_contexts:
        - resources=web/resources
        - app=docker-image://my-app:latest
        - base=service:base
`,
        });
        const contexts = byKind(result, 'build-additional-context');
        // Path values resolve project-relative; builder-supplied values are
        // recorded unmanaged (host) and never searched for in the repo.
        const pathValues = contexts.filter((c) => c.baseDir !== 'host');
        expect(pathValues.map((c) => c.sourcePath).sort()).toEqual(['web/certs', 'web/resources'].sort());
        const builderValues = contexts.filter((c) => c.baseDir === 'host');
        expect(builderValues.map((c) => c.sourcePath).sort()).toEqual(['docker-image://my-app:latest', 'service:base'].sort());
    });

    it('walks include map path and env_file in list forms', () => {
        const { result } = parse({
            'compose.yaml': `include:
  - path:
      - a.yaml
      - b.yaml
    env_file:
      - a.env
      - b.env
services: {}
`,
            'a.yaml': 'services: {}\n',
            'b.yaml': 'services: {}\n',
        });
        const includes = byKind(result, 'include');
        expect(includes.map((i) => i.sourcePath).sort()).toEqual(['a.yaml', 'b.yaml'].sort());
        const includeEnv = byKind(result, 'include-env');
        expect(includeEnv.map((e) => e.sourcePath).sort()).toEqual(['a.env', 'b.env'].sort());
    });

    it('applies include project_directory to the included subtree', () => {
        const { result } = parse({
            'compose.yaml': 'include:\n  - path: app/compose.yaml\n    project_directory: app\nservices: {}\n',
            'app/compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: x.env\n',
        });
        // The included file's project-relative paths resolve against the
        // included project_directory ('app'), not its own directory.
        const envFiles = byKind(result, 'env_file');
        expect(envFiles.map((e) => e.sourcePath)).toEqual(['app/x.env']);
    });

    it('parses Windows drive-letter short-form bind mounts (audit round 10 S-2)', () => {
        // Plain YAML scalars keep backslashes literally (no escape processing).
        const { result } = parse({
            'compose.yaml': `services:
  web:
    image: nginx
    volumes:
      - C:\\data:/data
      - C:creds:/creds
      - \\\\server\\share:/share
      - ./data:/data
      - named-vol:/vol
      - C:\\data:/data:ro
`,
        });
        const binds = byKind(result, 'bind-mount');
        // Drive-letter, drive-relative, and UNC short binds are recorded as
        // host entries (with their raw spelling) instead of being mistaken for
        // named volumes and dropped; ./data resolves project-relative;
        // named-vol is not a bind.
        expect(binds).toHaveLength(5);
        expect(binds.map((b) => b.baseDir)).toEqual(['host', 'host', 'host', 'project-root', 'host']);
        expect(binds.find((b) => b.kind === 'bind-mount' && b.materializedPath === 'data')?.sourcePath).toBe('data');
    });

    it('preserves env_file required: false and required: true (audit round 10 S-1)', () => {
        const { result } = parse({
            'compose.yaml': `services:
  web:
    image: nginx
    env_file:
      - path: optional.env
        required: false
      - required.env
`,
        });
        const envFiles = byKind(result, 'env_file');
        expect(envFiles.find((e) => e.sourcePath === 'optional.env')?.required).toBe(false);
        expect(envFiles.find((e) => e.sourcePath === 'required.env')?.required).toBe(true);
    });

    it('classifies absolute and home-relative paths as host paths', () => {
        const { result } = parse({
            'compose.yaml': `include:
  - /etc/compose/extra.yaml
services:
  web:
    image: nginx
    env_file: /etc/secrets/web.env
    configs: [cfg]
    label_file: ~/labels.txt
configs:
  cfg:
    file: C:\\\\config\\\\app.conf
`,
        });
        const includes = byKind(result, 'include');
        expect(includes[0].sourcePath).toBe('/etc/compose/extra.yaml');
        expect(includes[0].baseDir).toBe('host');
        const envFile = byKind(result, 'env_file')[0];
        expect(envFile.baseDir).toBe('host');
        expect(envFile.materializedPath).toBeNull();
        const cfg = byKind(result, 'config')[0];
        // Plain YAML scalars do not process escapes, so the parsed value
        // carries the double backslashes as written.
        expect(cfg.sourcePath).toBe('C:\\\\config\\\\app.conf');
        expect(cfg.baseDir).toBe('host');
        const labelFile = byKind(result, 'label_file')[0];
        expect(labelFile.baseDir).toBe('host');
    });
});

describe('YAML alias budget', () => {
    it.each([101, 220])('accepts %i ordinary scalar alias references per anchor', (serviceCount) => {
        const { result } = parse({ 'compose.yaml': scalarAliasCompose(serviceCount) });
        expect(result.parseErrors).toEqual([]);
        const envFiles = byKind(result, 'env_file');
        expect(envFiles).toHaveLength(serviceCount);
        expect(envFiles.every((e) => e.sourcePath === 'shared.env')).toBe(true);
    });

    it('applies the same alias budget under a YAML 1.1 directive', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1\n---\n${scalarAliasCompose(101)}`,
        });
        expect(result.parseErrors).toEqual([]);
        expect(byKind(result, 'env_file')).toHaveLength(101);
    });

    it('still refuses an over-budget alias expansion under a YAML 1.1 directive', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1\n---\n${nestedAliasCompose(10)}`,
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('Cannot parse compose file compose.yaml');
        expect(result.parseErrors[0]).toContain('Excessive alias count');
    });

    it('resolves an aliased dependency and collection across 55 services', () => {
        const { result } = parse({
            'compose.yaml': aliasHeavyCompose(55),
            'shared.env': 'A=1\n',
            'data/.keep': '',
        });
        expect(result.parseErrors).toEqual([]);
        const envFiles = byKind(result, 'env_file');
        expect(envFiles).toHaveLength(55);
        expect(envFiles.every((e) => e.sourcePath === 'shared.env')).toBe(true);
        expect(envFiles.every((e) => e.baseDir === 'compose-file-dir')).toBe(true);
        const binds = byKind(result, 'bind-mount');
        expect(binds).toHaveLength(55);
        expect(binds.every((b) => b.sourcePath === 'data')).toBe(true);
    });

    it('refuses a nested merge that would hide an inherited declaration', () => {
        const { result } = parse({
            'compose.yaml': `x-env: &env shared.env
x-base: &base
  env_file: *env
x-defaults: &defaults
  <<: *base
  restart: unless-stopped
services:
  web:
    <<: *defaults
    image: alpine
`,
            'shared.env': 'A=1\n',
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('compose.yaml');
        expect(result.parseErrors[0]).toContain('YAML merge key hides declaration "env_file"');
        expect(byKind(result, 'env_file')).toHaveLength(0);
    });

    it.each([
        ['services', `x-s: &s
  web:
    image: alpine
    env_file: secret.env
services:
  <<: *s
`],
        ['configs', `x-c: &c
  app:
    file: ./secret.txt
configs:
  <<: *c
services: {}
`],
        ['secrets', `x-s: &s
  app:
    file: ./secret.txt
secrets:
  <<: *s
services: {}
`],
    ])('refuses a merge on the %s container', (container, compose) => {
        const { result } = parse({ 'compose.yaml': compose, 'secret.env': 'A=1\n', 'secret.txt': 'x' });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain(`YAML merge key hides declaration "${container}"`);
    });

    it('checks a shared anchor under every role that reaches it', () => {
        const { result } = parse({
            'compose.yaml': `x-base: &base
  context: .
  dockerfile: Dockerfile.dev
x-shared: &shared
  <<: *base
services:
  b:
    image: alpine
    build: *shared
  a: *shared
`,
            'Dockerfile.dev': 'FROM alpine\n',
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toMatch(/YAML merge key hides declaration "(context|dockerfile)"/);
    });

    it.each([
        ['compact', '!!merge <<: *a'],
        ['verbatim', '!<tag:yaml.org,2002:merge> <<: *a'],
    ])('refuses an explicitly tagged merge key (%s)', (_label, key) => {
        const { result } = parse({
            'compose.yaml': `x-a: &a
  restart: unless-stopped
services:
  web:
    ${key}
    image: alpine
`,
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('tagged YAML merge keys are not supported');
    });

    it('accepts a YAML 1.1 document that declares no aliases or merges', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1
---
services:
  web:
    image: alpine
    env_file: shared.env
`,
            'shared.env': 'A=1\n',
        });
        expect(result.parseErrors).toEqual([]);
        expect(byKind(result, 'env_file').map((i) => i.sourcePath)).toEqual(['shared.env']);
    });

    it('accepts a harmless merge in a YAML 1.1 document', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1
---
x-a: &a
  restart: unless-stopped
  logging:
    driver: json-file
services:
  web:
    <<: *a
    image: alpine
    env_file: shared.env
`,
            'shared.env': 'A=1\n',
        });
        expect(result.parseErrors).toEqual([]);
        expect(byKind(result, 'env_file').map((i) => i.sourcePath)).toEqual(['shared.env']);
    });

    it('keeps the declaration-hiding merge check for a YAML 1.1 document', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1
---
x-a: &a
  env_file: secret.env
services:
  web:
    <<: *a
    image: alpine
`,
            'secret.env': 'A=1\n',
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('YAML merge key hides declaration "env_file"');
        expect(byKind(result, 'env_file')).toHaveLength(0);
    });

    it('reads YAML 1.1 scalars with 1.2 core typing', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1
---
services:
  web:
    image: alpine
    env_file: no
`,
            'no': 'A=1\n',
        });
        expect(result.parseErrors).toEqual([]);
        expect(byKind(result, 'env_file').map((i) => i.sourcePath)).toEqual(['no']);
    });

    it('accepts a YAML 1.1 directive in an included file', () => {
        const { result } = parse({
            'compose.yaml': `include:
  - common/base.yaml
services: {}
`,
            'common/base.yaml': `%YAML 1.1
---
services:
  redis:
    image: redis
    env_file: redis.env
`,
            'common/redis.env': 'R=1\n',
        });
        expect(result.parseErrors).toEqual([]);
        expect(byKind(result, 'env_file').map((i) => i.sourcePath)).toEqual(['common/redis.env']);
    });

    it('refuses an explicitly tagged merge key in a YAML 1.1 document', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.1
---
x-a: &a
  restart: unless-stopped
services:
  web:
    !!merge <<: *a
    image: alpine
`,
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('tagged YAML merge keys are not supported');
    });

    it('accepts an explicit YAML 1.2 directive', () => {
        const { result } = parse({
            'compose.yaml': `%YAML 1.2
---
services:
  web:
    image: alpine
`,
        });
        expect(result.parseErrors).toEqual([]);
    });

    it('accepts a container merge that contributes no entries', () => {
        const { result } = parse({
            'compose.yaml': `x-empty: &empty {}
services:
  <<: *empty
  web:
    image: alpine
`,
        });
        expect(result.parseErrors).toEqual([]);
    });

    const bigAnchorCompose = (serviceCount: number): string => {
        let compose = 'x-big: &big\n';
        for (let i = 0; i < 1_000; i++) compose += `  k${i}: v\n`;
        compose += 'services:\n';
        for (let i = 0; i < serviceCount; i++) compose += `  s${i}:\n    <<: *big\n    image: alpine\n`;
        return compose;
    };

    it('accepts merge-key inspection just below the finite budget', () => {
        const { result } = parse({ 'compose.yaml': bigAnchorCompose(99) });
        expect(result.parseErrors).toEqual([]);
    });

    it('refuses a merge whose key inspection exceeds the finite budget', () => {
        const { result } = parse({ 'compose.yaml': bigAnchorCompose(120) });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('merge keys exceed the 100000-key inspection budget');
    });

    it('bounds collected parse errors for repeated invalid declarations', () => {
        let compose = 'x-e: &e\n';
        for (let i = 0; i < 10; i++) compose += '  - {}\n';
        compose += 'services:\n';
        for (let i = 0; i < 20; i++) compose += `  s${i}:\n    image: alpine\n    env_file: *e\n`;
        const { result } = parse({ 'compose.yaml': compose });
        expect(result.parseErrors).toHaveLength(100);
        expect(result.parseErrors[0]).toContain('env_file entry');
    });

    it('refuses a merge that would hide a build declaration', () => {
        const { result } = parse({
            'compose.yaml': `x-build: &build
  dockerfile: Dockerfile.dev
services:
  web:
    build:
      <<: *build
      context: .
`,
            'Dockerfile.dev': 'FROM alpine\n',
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('YAML merge key hides declaration "dockerfile"');
    });

    const mergeHidingRoleCases: Array<[string, string, string]> = [
        ['include path', `x-i: &i
  path: base.yaml
include:
  - <<: *i
services: {}
`, 'path'],
        ['extends file', `x-e: &e
  file: base.yaml
services:
  web:
    extends:
      <<: *e
      service: base
`, 'file'],
        ['env_file path', `x-e: &e
  path: shared.env
services:
  web:
    env_file:
      - <<: *e
        required: true
`, 'path'],
        ['volume source', `x-v: &v
  source: ./data
  type: bind
services:
  web:
    volumes:
      - <<: *v
        target: /data
`, 'source'],
        ['config file', `x-c: &c
  file: ./app.conf
configs:
  app:
    <<: *c
services: {}
`, 'file'],
        ['additional context', `x-a: &a
  ctx: ./ctx
services:
  web:
    build:
      context: .
      additional_contexts:
        <<: *a
`, 'additional_contexts'],
    ];
    const mergeHidingRoleFiles = {
        'base.yaml': 'services: {}\n',
        'shared.env': 'A=1\n',
        'data/.keep': '',
        'app.conf': 'x',
        'ctx/.keep': '',
    };

    it.each(mergeHidingRoleCases)('refuses a merge hiding a %s declaration', (_label, compose, key) => {
        const { result } = parse({ 'compose.yaml': compose, ...mergeHidingRoleFiles });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain(`YAML merge key hides declaration "${key}"`);
    });

    it.each(mergeHidingRoleCases)('refuses a merge hiding a %s declaration under a YAML 1.1 directive', (_label, compose, key) => {
        const { result } = parse({ 'compose.yaml': `%YAML 1.1\n---\n${compose}`, ...mergeHidingRoleFiles });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain(`YAML merge key hides declaration "${key}"`);
    });

    it('keeps an explicit declaration over one inherited through a merge', () => {
        const { result } = parse({
            'compose.yaml': `x-base: &base
  env_file: hidden.env
services:
  web:
    <<: *base
    image: alpine
    env_file: explicit.env
`,
            'explicit.env': 'A=1\n',
            'hidden.env': 'B=1\n',
        });
        expect(result.parseErrors).toEqual([]);
        const envFiles = byKind(result, 'env_file');
        expect(envFiles).toHaveLength(1);
        expect(envFiles[0].sourcePath).toBe('explicit.env');
    });

    it('applies the same allowance to includes, extends targets and additional layers', () => {
        const r = repo({
            'compose.yaml': `include:
  - shared/common.yaml
services:
  web:
    extends:
      file: base.yaml
      service: base
`,
            'shared/common.yaml': aliasHeavyCompose(101),
            'base.yaml': scalarAliasCompose(101),
            'compose.prod.yaml': aliasHeavyCompose(101),
        });
        const result = parseDeclaredInputs([
            { path: 'compose.yaml', content: r.files['compose.yaml'] },
            { path: 'compose.prod.yaml', content: r.files['compose.prod.yaml'] },
        ], { projectRoot: null, read: r.read });

        expect(result.parseErrors).toEqual([]);
        const envFiles = byKind(result, 'env_file');
        // Included project, extended service, and the additional -f layer all
        // keep their own path ownership while parsing under the same budget.
        expect(envFiles.filter((e) => e.sourcePath === 'shared/shared.env')).toHaveLength(101);
        // The extended service's own file and the additional -f layer both
        // resolve against the primary file's directory.
        expect(envFiles.filter((e) => e.sourcePath === 'shared.env')).toHaveLength(202);
        expect(byKind(result, 'include').map((e) => e.sourcePath)).toEqual(['shared/common.yaml']);
        expect(byKind(result, 'extends').map((e) => e.sourcePath)).toEqual(['base.yaml']);
    });

    it('still refuses a compact nested alias expansion beyond the finite budget', () => {
        const { result } = parse({ 'compose.yaml': nestedAliasCompose(10) });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('Cannot parse compose file compose.yaml');
        expect(result.parseErrors[0]).toContain('Excessive alias count');
    });

    it('still refuses one anchor referenced beyond the finite budget', () => {
        const refs = Array.from({ length: 10_001 }, () => '*r').join(', ');
        const { result } = parse({
            'compose.yaml': `x-r: &r unless-stopped\nx-refs: [${refs}]\nservices: {}\n`,
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('Cannot parse compose file compose.yaml');
        expect(result.parseErrors[0]).toContain('Excessive alias count');
    });

    it('refuses a file that emits more declared inputs than the finite cap', () => {
        const binds = Array.from({ length: 201 }, (_, i) => `  - ./data${i}:/data${i}`).join('\n');
        let compose = `x-v: &v\n${binds}\nservices:\n`;
        for (let i = 0; i < 500; i++) compose += `  s${i}:\n    image: alpine\n    volumes: *v\n`;
        const { result } = parse({ 'compose.yaml': compose });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('compose.yaml');
        expect(result.parseErrors[0]).toContain('declared-input cap');
        expect(result.inputs.length).toBe(100_000);
    });

    it('keeps an unresolved alias an error', () => {
        const { result } = parse({
            'compose.yaml': 'services:\n  web:\n    image: alpine\n    restart: *missing\n',
        });
        expect(result.parseErrors.some((e) => e.includes('Cannot parse compose file compose.yaml'))).toBe(true);
    });

    it('keeps the source-size cap', () => {
        const { result } = parse({
            'compose.yaml': `services: {}\n${'#'.repeat(1_048_576)}`,
        });
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0]).toContain('exceeds the 1048576-byte parse cap');
    });
});

describe('isDynamicPath', () => {
    it('treats Compose variable forms as dynamic', () => {
        expect(isDynamicPath('${ENV_FILE}')).toBe(true);
        expect(isDynamicPath('${ENV_FILE:-default.env}')).toBe(true);
        expect(isDynamicPath('$ENV_FILE')).toBe(true);
        expect(isDynamicPath('prefix-$ENV_FILE')).toBe(true);
    });

    it('treats a literal $ that is not a variable start as static', () => {
        expect(isDynamicPath('config$.env')).toBe(false);
        expect(isDynamicPath('file$.yaml')).toBe(false);
        expect(isDynamicPath('plain.env')).toBe(false);
    });
});

describe('parseDeclaredInputs reportUnenumerable mode', () => {
    const run = (files: Record<string, string>, reportUnenumerable: boolean) => {
        const r = repo(files);
        return parseDeclaredInputs([{ path: 'compose.yaml', content: files['compose.yaml'] }], {
            projectRoot: null,
            read: r.read,
            reportUnenumerable,
        });
    };

    const interpolatedInclude = { 'compose.yaml': 'include:\n  - "${COMMON_DIR}/base.yaml"\nservices: {}\n' };
    const interpolatedExtends = {
        'compose.yaml': 'services:\n  web:\n    extends:\n      file: ${BASE_FILE:-base.yaml}\n      service: base\n',
    };
    const outsideProjectDir = {
        'compose.yaml': 'include:\n  - path: ./local.yaml\n    project_directory: ../shared-common\nservices: {}\n',
        'local.yaml': 'services:\n  web:\n    image: nginx\n',
    };

    it.each([
        ['an interpolated include', interpolatedInclude, /is unreadable/],
        ['an interpolated extends file', interpolatedExtends, /is unreadable/],
        ['a project_directory outside the base', outsideProjectDir, /escapes its base/],
    ])('keeps %s a parse error by default, for Git materialization', (_label, files, message) => {
        const result = run(files, false);
        expect(result.parseErrors.some((e) => message.test(e))).toBe(true);
    });

    it('leaves an interpolated project_directory unreported by default, for Git materialization', () => {
        const result = run({
            'compose.yaml': 'include:\n  - path: ./local.yaml\n    project_directory: "${PD:-inc}"\nservices: {}\n',
            'local.yaml': 'services:\n  web:\n    image: nginx\n',
        }, false);
        expect(result.dynamic).toEqual([]);
        expect(result.inputs.some((i) => i.kind === 'include' && i.baseDir === 'host')).toBe(false);
    });

    it.each([
        ['an interpolated include', interpolatedInclude],
        ['an interpolated extends file', interpolatedExtends],
        ['a project_directory outside the base', outsideProjectDir],
    ])('reports %s instead of failing the parse when partial', (_label, files) => {
        const result = run(files, true);
        expect(result.parseErrors).toEqual([]);
    });

    it('lists an interpolated include and extends file as dynamic when partial', () => {
        expect(run(interpolatedInclude, true).dynamic.map((d) => [d.kind, d.sourcePath]))
            .toEqual([['include', '${COMMON_DIR}/base.yaml']]);
        expect(run(interpolatedExtends, true).dynamic.map((d) => [d.kind, d.sourcePath]))
            .toEqual([['extends', '${BASE_FILE:-base.yaml}']]);
    });

    it('records an outside project_directory as an outside include when partial', () => {
        const outside = run(outsideProjectDir, true).inputs.filter((i) => i.baseDir === 'host');
        expect(outside.map((i) => [i.kind, i.sourcePath])).toEqual([['include', '../shared-common']]);
    });

    it('still reports a missing static include and keeps recursing into readable ones when partial', () => {
        const missing = run({ 'compose.yaml': 'include:\n  - ./missing.yaml\nservices: {}\n' }, true);
        expect(missing.parseErrors.some((e) => /missing\.yaml is unreadable/.test(e))).toBe(true);

        const nested = run({
            'compose.yaml': 'include:\n  - ./inner.yaml\nservices: {}\n',
            'inner.yaml': 'services:\n  web:\n    image: nginx\n    env_file: ./app.env\n',
        }, true);
        expect(nested.parseErrors).toEqual([]);
        expect(nested.inputs.filter((i) => i.kind === 'env_file').map((i) => i.sourcePath)).toEqual(['app.env']);
    });

    it('lists an interpolated project_directory as dynamic and still records the included file', () => {
        const result = run({
            'compose.yaml': 'include:\n  - path: ./local.yaml\n    project_directory: "${PROJ_DIR}"\nservices: {}\n',
            'local.yaml': 'services:\n  web:\n    image: nginx\n    env_file: ./local.env\n',
        }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.dynamic.map((d) => [d.kind, d.sourcePath])).toEqual([['include', '${PROJ_DIR}']]);
        expect(result.inputs.filter((i) => i.kind === 'include').map((i) => i.sourcePath)).toEqual(['local.yaml']);
        // The included project's directory is unknown, so its own references are not enumerated.
        expect(result.inputs.filter((i) => i.kind === 'env_file')).toEqual([]);
    });

    it('follows a literal sibling include entry beside an interpolated one', () => {
        const result = run({
            'compose.yaml': 'include:\n  - ./a.yaml\n  - "${X}/b.yaml"\nservices: {}\n',
            'a.yaml': 'services:\n  web:\n    image: nginx\n    env_file: ./a.env\n',
        }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.dynamic.map((d) => d.sourcePath)).toEqual(['${X}/b.yaml']);
        expect(result.inputs.filter((i) => i.kind === 'env_file').map((i) => i.sourcePath)).toEqual(['a.env']);
    });

    it('reports an interpolated path that follows a literal path in one include entry', () => {
        const result = run({
            'compose.yaml': 'include:\n  - path: ["./a.yaml", "${X}/b.yaml"]\nservices: {}\n',
            'a.yaml': 'services:\n  web:\n    image: nginx\n',
        }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.dynamic.map((d) => [d.kind, d.sourcePath])).toEqual([['include', '${X}/b.yaml']]);
        expect(result.inputs.filter((i) => i.kind === 'include').map((i) => i.sourcePath)).toEqual(['a.yaml']);
    });

    it.each([
        ['an outside project_directory', 'include:\n  - path: ./inc/base.yaml\n    project_directory: ../shared-common\n    env_file: ./inc.env\nservices: {}\n'],
        ['an interpolated project_directory', 'include:\n  - path: ./inc/base.yaml\n    project_directory: "${PD:-inc}"\n    env_file: ./inc.env\nservices: {}\n'],
        ['an interpolated main file', 'include:\n  - path: ["${X}/a.yaml", ./inc/base.yaml]\n    env_file: ./inc.env\nservices: {}\n'],
        ['an outside main file', 'include:\n  - path: ../shared-common/base.yaml\n    env_file: ./inc.env\nservices: {}\n'],
    ])('still records the include env_file beside %s', (_label, compose) => {
        const result = run({ 'compose.yaml': compose, 'inc/base.yaml': 'services: {}\n' }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.inputs.filter((i) => i.kind === 'include-env').map((i) => i.sourcePath)).toEqual(['inc.env']);
    });

    it('keeps skipping the include env_file for an outside main file by default', () => {
        const result = run({
            'compose.yaml': 'include:\n  - path: ../shared-common/base.yaml\n    env_file: ./inc.env\nservices: {}\n',
        }, false);
        expect(result.inputs.filter((i) => i.kind === 'include-env')).toEqual([]);
    });

    it('does not enumerate a literal override listed after an interpolated main file', () => {
        const result = run({
            'compose.yaml': 'include:\n  - path: ["${DIR}/base.yaml", "./override.yaml"]\nservices: {}\n',
            'override.yaml': 'services:\n  web:\n    image: nginx\n    env_file: ./o.env\n',
        }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.dynamic.map((d) => d.sourcePath)).toEqual(['${DIR}/base.yaml']);
        // The first path defines the included project's directory, which is unknown here.
        expect(result.inputs.filter((i) => i.kind === 'env_file')).toEqual([]);
    });

    it('records one outside input when both the included file and its project_directory are outside', () => {
        const result = run({
            'compose.yaml': 'include:\n  - path: ../shared-common/base.yaml\n    project_directory: ../shared-common\nservices: {}\n',
        }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.inputs.filter((i) => i.baseDir === 'host').map((i) => [i.kind, i.sourcePath]))
            .toEqual([['include', '../shared-common/base.yaml']]);
    });

    it('does not follow an interpolated include inside a readable included file', () => {
        const result = run({
            'compose.yaml': 'include:\n  - ./inner.yaml\nservices: {}\n',
            'inner.yaml': 'include:\n  - "${DIR}/more.yaml"\nservices: {}\n',
        }, true);
        expect(result.parseErrors).toEqual([]);
        expect(result.dynamic.map((d) => d.sourcePath)).toEqual(['${DIR}/more.yaml']);
    });
});

describe('listComposeServiceNames', () => {
    it('returns no names for a missing, null, scalar, or sequence services value', () => {
        expect(listComposeServiceNames('')).toEqual([]);
        expect(listComposeServiceNames('services: null\n')).toEqual([]);
        expect(listComposeServiceNames('services: "abc"\n')).toEqual([]);
        expect(listComposeServiceNames('services: [web]\n')).toEqual([]);
    });

    it('keeps literal YAML 1.1 service names', () => {
        expect(listComposeServiceNames('%YAML 1.1\n---\nservices:\n  on:\n    image: nginx\n  "true":\n    image: nginx\n'))
            .toEqual(['on', 'true']);
    });

    it('keeps numeric-looking, hexadecimal, octal, and boolean keys in Compose spelling', () => {
        expect(listComposeServiceNames([
            'services:',
            '  1e999:',
            '    image: nginx',
            '  Infinity:',
            '    image: nginx',
            '  0x10:',
            '    image: nginx',
            '  0o17:',
            '    image: nginx',
            '  true:',
            '    image: nginx',
            '  "123":',
            '    image: nginx',
        ].join('\n'))).toEqual(['1e999', 'Infinity', '0x10', '0o17', 'true', '123']);
    });

    it('keeps numeric-looking names through a services-map merge', () => {
        expect(listComposeServiceNames([
            'x-svcs: &svcs',
            '  1e999:',
            '    image: nginx',
            'services:',
            '  <<: *svcs',
            '  Infinity:',
            '    image: nginx',
        ].join('\n'))).toEqual(['1e999', 'Infinity']);
    });

    it('keeps numeric-looking names through a document-root merge', () => {
        expect(listComposeServiceNames([
            'x-root: &root',
            '  services:',
            '    1e999:',
            '      image: nginx',
            '<<: *root',
        ].join('\n'))).toEqual(['1e999']);
    });

    it('treats an explicitly string-tagged << as a literal key', () => {
        expect(listComposeServiceNames([
            'x-ext:',
            '  !!str <<: a literal extension key',
            'services:',
            '  web:',
            '    image: nginx',
            '    labels:',
            '      !!str <<: a literal label key',
        ].join('\n'))).toEqual(['web']);
    });

    it('expands a services-map merge and a document-root merge', () => {
        expect(listComposeServiceNames(
            'x-svcs: &svcs\n  web:\n    image: nginx\nservices:\n  <<: *svcs\n  db:\n    image: postgres\n',
        )).toEqual(['web', 'db']);
        expect(listComposeServiceNames(
            'x-root: &root\n  services:\n    web:\n      image: nginx\n<<: *root\n',
        )).toEqual(['web']);
    });

    it('refuses an explicit merge tag', () => {
        expect(() => listComposeServiceNames(
            'x-base: &base\n  image: nginx\nservices:\n  web:\n    !!merge <<: *base\n',
        )).toThrowError(/explicit YAML merge tag/);
    });
});

describe('parseComposeYaml', () => {
    it('keeps Compose-accepted mapping keys literal for every consumer', () => {
        const parsed = parseComposeYaml(
            'services:\n  1e999:\n    image: a\n  0x10:\n    image: b\n',
        ) as { services: Record<string, unknown> };

        expect(Object.keys(parsed.services)).toEqual(['1e999', '0x10']);
    });
});
