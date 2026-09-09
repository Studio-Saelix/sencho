import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  discoverRegistryReferences,
  discoverRegistryReferencesFromComposeContent,
  parseDockerfileReferences,
} from '../services/registryReferenceDiscovery';

describe('registryReferenceDiscovery', () => {
  it('discovers hosts from compose files and Dockerfiles', () => {
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

    const result = discoverRegistryReferences(dir);
    expect(result.referencedHosts).toContain('ghcr.io');
    expect(result.referencedHosts).toContain('index.docker.io');
    expect(result.referencedPullRefs).toContain('ghcr.io/org/private-app:latest');
    expect(result.referencedPullRefs).toContain('ghcr.io/org/cache:1');
    expect(result.referencedPullRefs).toContain('index.docker.io/library/node:20');
  });

  it('preserves digest-pinned refs through discovery', () => {
    const digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-digest-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      `services:\n  app:\n    image: ghcr.io/org/private-app@${digest}\n`,
    );

    const result = discoverRegistryReferences(dir);
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

  it('parses FROM lines in Dockerfiles', () => {
    const hosts = parseDockerfileReferences('FROM alpine:3\n');
    expect(hosts).toEqual(['index.docker.io']);
  });

  it('continues past an unreadable subdirectory', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-noread-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'locked'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );
    fs.chmodSync(path.join(dir, 'locked'), 0o000);

    const result = discoverRegistryReferences(dir);
    expect(result.referencedHosts).toEqual(['ghcr.io']);
    expect(result.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);

    fs.chmodSync(path.join(dir, 'locked'), 0o755);
  });

  it('rejects oversized Dockerfiles', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-big-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'x'.repeat(1_048_577));

    expect(() => discoverRegistryReferences(dir)).toThrow(/size limit/i);
  });

  it('resolves registry variables from .env when env map is supplied', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-env-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ${REGISTRY}/org/private:latest\n',
    );

    const result = discoverRegistryReferences(dir, { REGISTRY: 'ghcr.io' });
    expect(result.referencedHosts).toEqual(['ghcr.io']);
  });

  it('scopes discovery to the selected service, excluding a sibling private image', () => {
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

    const scoped = discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);

    // Without a service the whole project still participates.
    const whole = discoverRegistryReferences(dir);
    expect(whole.referencedHosts).toEqual(['ghcr.io', 'registry.example.com']);
  });

  it('includes only the selected service build Dockerfile refs when scoped', () => {
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

    const scoped = discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/base-app:2']);

    const whole = discoverRegistryReferences(dir);
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

  it('skips the build Dockerfile when it is missing from the build context', () => {
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
    const scoped = discoverRegistryReferences(dir, {}, 'app');
    expect(scoped.referencedHosts).toEqual(['ghcr.io']);
    expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
  });

  it('skips the build Dockerfile when it exceeds the size limit', () => {
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
      const scoped = discoverRegistryReferences(dir, {}, 'app');
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

  it('warns when the build Dockerfile is unreadable, naming the errno reason', () => {
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
      const scoped = discoverRegistryReferences(dir, {}, 'app');
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

  it('stays silent when the build Dockerfile is absent', () => {
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
    // silent so the unreadable/oversized warns keep their signal value.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scoped = discoverRegistryReferences(dir, {}, 'app');
      expect(scoped.referencedHosts).toEqual(['ghcr.io']);
      expect(scoped.referencedPullRefs).toEqual(['ghcr.io/org/private-app:latest']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the compose file is unparseable in service-scoped discovery', () => {
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
      const scoped = discoverRegistryReferences(dir, {}, 'app');
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

  it('returns an empty reference set for a service not named in the compose file', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-svcmissing-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/org/private-app:latest\n',
    );

    const scoped = discoverRegistryReferences(dir, {}, 'nonexistent');
    expect(scoped.referencedHosts).toEqual([]);
    expect(scoped.referencedPullRefs).toEqual([]);
  });
});
