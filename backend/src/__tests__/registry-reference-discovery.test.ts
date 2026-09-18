import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  discoverRegistryReferences,
  discoverRegistryReferencesFromComposeContent,
  parseDockerfileReferences,
} from '../services/registryReferenceDiscovery';
import { makeRenderProc } from './helpers/mockComposeRender';

// The effective-model render spawns `docker compose config`; tests never
// depend on a docker binary being present. The default mock makes the render
// fail (exit 1) so every service-scoped test exercises the deterministic
// per-file fallback; targeted effective-path tests override it to succeed.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mockSpawn, execFile: vi.fn() }));

function mockRenderFailure(): void {
  mockSpawn.mockImplementation(() => makeRenderProc('', 1));
}

function mockRenderSuccess(renderedJson: string): void {
  mockSpawn.mockImplementation(() => makeRenderProc(renderedJson, 0));
}

describe('registryReferenceDiscovery', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockRenderFailure();
  });

  it('discovers hosts from compose files and Dockerfiles', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );
    fs.writeFileSync(
      path.join(dir, 'Dockerfile'),
      'FROM docker.io/library/node:20\nCOPY --from=ghcr.io/org/cache:1 /app /app\n',
    );

    const result = await discoverRegistryReferences(dir);
    expect(result.referencedHosts).toContain('ghcr.io');
    expect(result.referencedHosts).toContain('index.docker.io');
    expect(result.referencedPullRefs).toContain('ghcr.io/org/private-app:latest');
    expect(result.referencedPullRefs).toContain('ghcr.io/org/cache:1');
    expect(result.referencedPullRefs).toContain('index.docker.io/library/node:20');
  });

  it('preserves digest-pinned refs through discovery', async () => {
    const digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-digest-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      `services:\n  app:\n    image: ghcr.io/org/private-app@${digest}\n`,
    );

    const result = await discoverRegistryReferences(dir);
    expect(result.referencedPullRefs).toEqual([`ghcr.io/org/private-app@${digest}`]);
  });

  it('derives hosts and pull refs from the same parse, so a sha256-prefixed ref contributes neither', () => {
    const result = discoverRegistryReferencesFromComposeContent(
      'services:\n  app:\n    image: sha256:abcdef0123456789abcdef0123456789/org/app:latest\n',
    );
    // A ref the parser rejects contributes neither a host nor a pull ref;
    // both sets come from the same parse.
    expect(result.referencedHosts).toEqual([]);
    expect(result.referencedPullRefs).toEqual([]);
  });

  it('discovers hosts from inline compose content', () => {
    const result = discoverRegistryReferencesFromComposeContent(
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );
    expect(result.referencedHosts).toEqual(['ghcr.io']);
  });

  it('ignores numeric COPY --from stages in isolation', () => {
    const hosts = parseDockerfileReferences('COPY --from=0 /src /dest\n');
    expect(hosts).toEqual([]);
  });

  it('treats COPY --from matching a declared stage alias as a local reference', () => {
    // COPY --from=BUILDER targets a stage declared by an earlier FROM ... AS,
    // so it is a local reference, not an external image pull. The base image
    // of the FROM stage is still collected. Stage names are case-insensitive.
    const hosts = parseDockerfileReferences(
      'FROM node:20 AS builder\nCOPY --from=BUILDER /out /app\n',
    );
    expect(hosts).toEqual(['index.docker.io']);
  });

  it('still collects a COPY --from that matches no declared alias', () => {
    const hosts = parseDockerfileReferences(
      'FROM node:20\nCOPY --from=ghcr.io/org/cache:1 /app /app\n',
    );
    expect(hosts).toContain('index.docker.io');
    expect(hosts).toContain('ghcr.io');
  });

  it('parses FROM lines in Dockerfiles', () => {
    const hosts = parseDockerfileReferences('FROM alpine:3\n');
    expect(hosts).toEqual(['index.docker.io']);
  });

  it('continues past an unreadable subdirectory', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-noread-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'locked'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );
    fs.chmodSync(path.join(dir, 'locked'), 0o000);

    const result = await discoverRegistryReferences(dir);
    expect(result.referencedHosts).toEqual(['ghcr.io']);
    expect(result.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);

    fs.chmodSync(path.join(dir, 'locked'), 0o755);
  });

  it('rejects oversized Dockerfiles', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-big-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'x'.repeat(1_048_577));

    await expect(discoverRegistryReferences(dir)).rejects.toThrow(/size limit/i);
  });

  it('resolves registry variables from .env when env map is supplied', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-env-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ${REGISTRY}/org/private:latest\n',
    );

    const result = await discoverRegistryReferences(dir, { REGISTRY: 'ghcr.io' });
    expect(result.referencedHosts).toEqual(['ghcr.io']);
  });

  it('scopes discovery to the selected service, excluding a sibling private image', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-svc-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '  sibling:\n'
      + '    image: registry.example.com/org/private-sibling:latest\n',
    );

    const scoped = await discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);

    // Without a service the whole project still participates.
    const whole = await discoverRegistryReferences(dir);
    expect(whole.referencedHosts).toEqual(['ghcr.io', 'registry.example.com']);
  });

  it('includes only the selected service build Dockerfile refs when scoped', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-svcbuild-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build:\n'
      + '      context: ./build\n'
      + '  sibling:\n'
      + '    build:\n'
      + '      context: ./other\n',
    );
    fs.writeFileSync(
      path.join(dir, 'build', 'Dockerfile'),
      'FROM ghcr.io/org/base-app:2\n',
    );
    fs.writeFileSync(
      path.join(dir, 'other', 'Dockerfile'),
      'FROM registry.example.com/org/base-sibling:2\n',
    );

    const scoped = await discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/base-app:2']);

    const whole = await discoverRegistryReferences(dir);
    expect(whole.referencedHosts).toEqual(['ghcr.io', 'registry.example.com']);
  });

  it('scopes inline compose content discovery to the selected service', () => {
    const content = 'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '  sibling:\n'
      + '    image: registry.example.com/org/private-sibling:latest\n';
    const scoped = discoverRegistryReferencesFromComposeContent(content, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
  });

  it('skips the build Dockerfile when it is missing from the build context', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-nodockerfile-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '    build:\n'
      + '      context: ./build\n',
    );

    // No Dockerfile is written into ./build; discovery narrows to the image
    // ref instead of throwing out of the service-scoped path.
    const scoped = await discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
  });

  it('skips the build Dockerfile when it exceeds the size limit', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-bigdockerfile-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '    build:\n'
      + '      context: ./build\n',
    );
    fs.writeFileSync(
      path.join(dir, 'build', 'Dockerfile'),
      Buffer.alloc(1_048_577, 0x23),  // One byte past MAX_DOCKERFILE_BYTES.
    );

    // Oversize narrows coverage like absence does, but unlike absence it
    // warns, so the operator can tell a too-large Dockerfile from a missing
    // one when triaging a later remote-side pull failure.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OVERSIZED',
        expect.objectContaining({ dockerfile: 'Dockerfile' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the build Dockerfile is unreadable, naming the errno reason', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-readonly-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '    build:\n'
      + '      context: ./build\n',
    );
    fs.writeFileSync(path.join(dir, 'build', 'Dockerfile'), 'FROM ghcr.io/org/private-base:1\n');

    // chmod cannot make a file unreadable when tests run as root, so the
    // open failure is produced by replacing openSync for the duration.
    const realOpenSync = fs.openSync;
    const openSpy = vi
      .spyOn(fs, 'openSync')
      .mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        const target = String(args[0]);
        if (target.endsWith('Dockerfile')) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return realOpenSync(...args);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      // The Dockerfile base image host stays out of the discovered set and
      // the warn names the file plus the errno reason.
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_UNREADABLE',
        expect.objectContaining({ dockerfile: 'Dockerfile', reason: 'EACCES' }),
      );
    } finally {
      openSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it('stays silent when the build Dockerfile is absent', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-absent-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '    build:\n'
      + '      context: ./build\n',
    );
    // No Dockerfile in ./build: the documented passthrough, which must stay
    // silent about the Dockerfile so the unreadable/oversized warns keep
    // their signal value. The effective-render warn is expected here: with
    // no docker binary the render fails and the per-file fallback applies.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
      expect(warn.mock.calls.filter(c => String(c[0]).includes('DOCKERFILE'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the compose file is unparseable in service-scoped discovery', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-unparseable-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services: [unclosed\n'
      + '  app:\n'
      + '    image: ghcr.io/org/private-app:latest\n'
      + '    build:\n'
      + '      context: ./build\n',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      // The unparseable compose contributes neither the service image nor
      // the build Dockerfile; the warn names the service whose coverage
      // narrowed so the empty set is never mistaken for a clean one.
      expect(scoped.referencedHosts).toEqual([]);
      expect(scoped.referencedPullRefs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_COMPOSE_UNPARSEABLE',
        expect.objectContaining({ service: 'app' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('returns an empty reference set for a service not named in the compose file', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-svcmissing-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );

    const scoped = await discoverRegistryReferences(dir, {}, 'nonexistent');
    expect(scoped.referencedHosts).toEqual([]);
    expect(scoped.referencedPullRefs).toEqual([]);
  });

  it('collects refs from a string build context equal to the stack root', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-rootctx-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build: .\n',
    );
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM ghcr.io/org/private-base:1\n');

    // `build: .` resolves the context to the stack root itself; the root
    // Dockerfile must participate, not warn as outside the base. The
    // effective-render warn is expected: the render fails and the per-file
    // fallback applies.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-base:1']);
      expect(warn.mock.calls.filter(c => String(c[0]).includes('DOCKERFILE'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('collects refs from an object build context equal to the stack root', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-rootctxobj-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build:\n'
      + '      context: .\n',
    );
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM ghcr.io/org/private-base:2\n');

    // Both build forms normalize to the same root context; the object form
    // must stay silent about the Dockerfile for the same reason the string
    // form does, with the expected render warn excluded the same way.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-base:2']);
      expect(warn.mock.calls.filter(c => String(c[0]).includes('DOCKERFILE'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('follows an explicit dockerfile key with the stack root as context', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-rootexplicit-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build:\n'
      + '      context: .\n'
      + '      dockerfile: root.Dockerfile\n',
    );
    // A default-named decoy at the root must not be read: only the file the
    // explicit `dockerfile:` key names participates.
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM registry.example.com/org/decoy:9\n');
    fs.writeFileSync(path.join(dir, 'root.Dockerfile'), 'FROM registry.example.com/org/private-base:3\n');

    const scoped = await discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['registry.example.com']);
    expect(scoped.referencedPullRefs).toEqual(['registry.example.com/org/private-base:3']);
  });

  it('still warns when the build context resolves strictly outside the base', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-outside-${Date.now()}`);
    const peer = `${dir}-peer`;
    const escaped = `../${path.basename(peer)}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(peer, { recursive: true });
    // A decoy Dockerfile inside the outside context makes the empty-refs
    // assertion name the leaked reference if a regression ever reads it.
    fs.writeFileSync(path.join(peer, 'Dockerfile'), 'FROM registry.example.com/org/leaked:1\n');
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build:\n'
      + `      context: ${escaped}\n`,
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      // A context that escapes the stack root still narrows coverage with
      // the documented warn; equality must not loosen the outside-base rule.
      expect(scoped.referencedHosts).toEqual([]);
      expect(scoped.referencedPullRefs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE',
        expect.objectContaining({ context: escaped }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('still warns when the explicit dockerfile key resolves outside the base', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-dfoutside-${Date.now()}`);
    const peer = `${dir}-peer`;
    const escaped = `../${path.basename(peer)}/escape.Dockerfile`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(peer, { recursive: true });
    // A decoy Dockerfile inside the peer dir makes the empty-refs assertion
    // name the leaked reference if a regression ever reads the file.
    fs.writeFileSync(path.join(peer, 'escape.Dockerfile'), 'FROM registry.example.com/org/leaked:2\n');
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build:\n'
      + '      context: .\n'
      + `      dockerfile: ${escaped}\n`,
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      // The context stays inside the base while the explicit dockerfile key
      // escapes it; the file is never read and the narrowing stays visible.
      expect(scoped.referencedHosts).toEqual([]);
      expect(scoped.referencedPullRefs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE',
        expect.objectContaining({ dockerfile: escaped }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the effective merged model for service-scoped discovery when the render succeeds', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-effective-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:1\n  worker:\n    image: ghcr.io/example/worker:1\n',
    );
    fs.writeFileSync(
      path.join(dir, 'compose.prod.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:2\n',
    );

    // The effective render merges the two files: the override replaces web:1
    // with web:2, so the attested set matches what `docker compose pull web`
    // fetches, not the per-file union the fallback would produce.
    mockRenderSuccess(JSON.stringify({
      services: {
        web: { image: 'ghcr.io/example/web:2' },
        worker: { image: 'ghcr.io/example/worker:1' },
      },
    }));

    const scoped = await discoverRegistryReferences(
      dir,
      {},
      'web',
      ['compose.yaml', 'compose.prod.yaml'],
    );
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/example/web:2']);
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.anything(),
      expect.objectContaining({ cwd: expect.any(String) }),
    );
  });

  it('collects the service build Dockerfile refs alongside the effective model', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-effbuild-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    build:\n      context: ./build\n',
    );
    fs.writeFileSync(
      path.join(dir, 'build', 'Dockerfile'),
      'FROM ghcr.io/org/private-base:1\n',
    );

    // The render carries image refs but not Dockerfile contents, so the
    // build-context Dockerfile is still collected per file when the render
    // succeeds; a build-only service renders with a null image and
    // contributes no image ref.
    mockRenderSuccess(JSON.stringify({ services: { app: { image: null } } }));

    const scoped = await discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-base:1']);
  });

  it('falls back to the per-file union when the effective render fails', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-fallback-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:1\n',
    );
    fs.writeFileSync(
      path.join(dir, 'compose.prod.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:2\n',
    );

    // beforeEach installs the render-failure default, so this call runs the
    // documented fallback: the per-file union never under-covers, and the
    // degradation warns so the operator can tell fallback from clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(
        dir,
        {},
        'web',
        ['compose.yaml', 'compose.prod.yaml'],
      );
      expect(scoped.referencedPullRefs).toEqual([
        'ghcr.io/example/web:1',
        'ghcr.io/example/web:2',
      ]);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_EFFECTIVE_RENDER_FAILED',
        expect.objectContaining({ code: 1 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the per-file union when the render exits 0 with unparseable stdout', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-garbage-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:1\n',
    );

    // A zero exit does not guarantee a well-formed `--format json` payload.
    // The render must verify the stdout parses before trusting it, so garbage
    // output degrades to the per-file union instead of returning only the
    // Dockerfile refs and silently dropping the compose image ref.
    mockRenderSuccess('<html>not json</html>');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'web');
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/example/web:1']);
      // The code-0-garbage case is a render failure, not a clean render, so
      // the same documented degradation warn fires as for a nonzero exit.
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_EFFECTIVE_RENDER_FAILED',
        expect.objectContaining({ code: 0 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('injects the discovery env into the render child process environment', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-renderenv-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );

    // The hub-side discover and the target-side seam receive the same env
    // map; the render must resolve exactly that map, so the vars are merged
    // into the child's process env (the highest Compose precedence) and PATH
    // is pinned after the merge so a project var cannot redirect the binary.
    mockRenderSuccess(JSON.stringify({
      services: { app: { image: 'ghcr.io/org/private-app:latest' } },
    }));

    await discoverRegistryReferences(dir, { REGISTRY: 'ghcr.io' }, 'app');

    const call = mockSpawn.mock.calls.find(
      c => Array.isArray(c[1]) && c[1].includes('config'),
    );
    expect(call).toBeDefined();
    const childEnv = call?.[2]?.env as Record<string, string>;
    expect(childEnv.REGISTRY).toBe('ghcr.io');
    expect(childEnv.PATH).toBe(process.env.PATH);
  });

  it('warns outside-base when a symlinked build context resolves outside the project', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-symctx-${Date.now()}`);
    const peer = `${dir}-peer`;
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.mkdirSync(peer, { recursive: true });
    // A decoy Dockerfile inside the escaped target makes the empty-refs
    // assertion name the leaked reference if a regression ever follows the
    // symlink and reads it.
    fs.writeFileSync(path.join(peer, 'Dockerfile'), 'FROM registry.example.com/org/leaked:5\n');
    // The build context directory is a symlink pointing outside the project:
    // the lexical path stays inside the base while the canonical target
    // escapes it, so containment must be decided on the realpath.
    fs.symlinkSync(peer, path.join(dir, 'build', 'ctx'));

    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n    build:\n      context: ./build/ctx\n',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE',
        expect.objectContaining({ context: './build/ctx' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('follows a symlinked Dockerfile that resolves inside the project', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-symin-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'real', 'base.Dockerfile'),
      'FROM ghcr.io/org/private-base:7\n',
    );
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    build:\n      context: ./build\n      dockerfile: linked.Dockerfile\n',
    );
    // A symlink whose target stays inside the base is a normal project
    // layout, not an escape: the canonical target is read and contributes
    // its refs.
    fs.symlinkSync(
      path.join(dir, 'real', 'base.Dockerfile'),
      path.join(dir, 'build', 'linked.Dockerfile'),
    );

    const scoped = await discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-base:7']);
  });

  it('warns as unreadable when the dockerfile key resolves to the stack root itself', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-dfroot-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    build:\n'
      + '      context: .\n'
      + '      dockerfile: .\n',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'app');
      // `dockerfile: .` resolves the file path to the stack root directory;
      // containment must accept the equality so the failure surfaces as the
      // documented not-a-regular-file warn instead of a silent null.
      expect(scoped.referencedHosts).toEqual([]);
      expect(scoped.referencedPullRefs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        '[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_UNREADABLE',
        expect.objectContaining({ reason: 'not a regular file' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('bails to the per-file fallback when a compose file is a symlink outside the project', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-symcmp-${Date.now()}`);
    const peer = `${dir}-peer`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(
      path.join(peer, 'outside-compose.yaml'),
      'services:\n  web:\n    image: registry.example.com/org/leaked:9\n',
    );
    // A compose-file symlink inside the project that resolves outside it
    // must not reach the docker child: the lexical check alone cannot stop
    // it because the child resolves symlinks itself, so the render bails to
    // the per-file union and the decoy ref from the outside file is absent.
    fs.symlinkSync(
      path.join(peer, 'outside-compose.yaml'),
      path.join(dir, 'compose.yaml'),
    );

    mockRenderSuccess(JSON.stringify({
      services: { web: { image: 'registry.example.com/org/leaked:9' } },
    }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = await discoverRegistryReferences(dir, {}, 'web');
      expect(scoped.referencedPullRefs).toEqual([]);
      expect(scoped.referencedHosts).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('pins the docker-control env vars against project env overrides', async () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-pins-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );

    // The deploy child receives project vars only through --env-file
    // interpolation; the render merges them into process env for Compose
    // precedence, so the docker-control vars must be pinned to the server's
    // values to keep the render from acting on a redirected binary, config
    // dir, or daemon endpoint.
    mockRenderSuccess(JSON.stringify({
      services: { app: { image: 'ghcr.io/org/private-app:latest' } },
    }));

    await discoverRegistryReferences(dir, {
      REGISTRY: 'ghcr.io',
      DOCKER_CONFIG: '/tmp/hostile-docker-config',
      DOCKER_HOST: 'tcp://attacker.example:2375',
      DOCKER_CONTEXT: 'hostile-context',
    }, 'app');

    const call = mockSpawn.mock.calls.find(
      c => Array.isArray(c[1]) && c[1].includes('config'),
    );
    expect(call).toBeDefined();
    const childEnv = call?.[2]?.env as Record<string, string>;
    expect(childEnv.REGISTRY).toBe('ghcr.io');
    expect(childEnv.DOCKER_CONFIG).toBe(process.env.DOCKER_CONFIG ?? undefined);
    expect(childEnv.DOCKER_HOST).toBe(process.env.DOCKER_HOST ?? undefined);
    expect(childEnv.DOCKER_CONTEXT).toBe(process.env.DOCKER_CONTEXT ?? undefined);
  });
});
