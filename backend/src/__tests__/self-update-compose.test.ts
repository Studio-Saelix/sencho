/**
 * Pure-unit coverage for the compose image handling that powers pinned
 * self-update (GitHub issue: a version-pinned compose image could never update
 * because recreate reused the running image). Split across the pure helper
 * module and the three self-update argv builders that carry the repin handoff:
 *   - classifyImagePin / buildTargetImageRef / isValidImageRef,
 *   - resolveServiceImageFromContents (reverse -f precedence),
 *   - patchComposeServiceImage (comment-preserving round-trip),
 *   - buildComposeReadArgs (throwaway cat container),
 *   - mapHostPathToContainerPath (reading a covered file without a container),
 *   - the composeCopy branch of buildSelfUpdateComposeCmd,
 *   - the repinWritable branch of buildSelfUpdateRunArgs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyImagePin,
  crossesAbsoluteSymlink,
  parseMountPoints,
  resolveMountDestinations,
  buildTargetImageRef,
  isRepinBlocked,
  isShadowedByDeeperMount,
  isValidImageRef,
  mapHostPathToContainerPath,
  resolveServiceImageFromContents,
  patchComposeServiceImage,
  isSenchoDevRepository,
  isSenchoDevFloatingTag,
} from '../helpers/selfUpdateCompose';
import {
  buildComposeReadArgs,
  buildComposeConfigValidateArgs,
  buildSelfUpdateComposeCmd,
  buildSelfUpdateRunArgs,
  shQuote,
} from '../services/SelfUpdateService';

describe('isRepinBlocked', () => {
  it('blocks digest and unknown pins only', () => {
    expect(isRepinBlocked('digest')).toBe(true);
    expect(isRepinBlocked('unknown')).toBe(true);
    expect(isRepinBlocked('semver')).toBe(false);
    expect(isRepinBlocked('floating')).toBe(false);
  });
});

describe('classifyImagePin', () => {
  it('classifies an explicit semver tag (with and without v prefix) as semver', () => {
    expect(classifyImagePin('saelix/sencho:0.93.3')).toBe('semver');
    expect(classifyImagePin('saelix/sencho:v1.2.3')).toBe('semver');
    expect(classifyImagePin('ghcr.io/studio-saelix/sencho:1.0.0-rc.1')).toBe('semver');
  });

  it('classifies latest, implicit, and other moving tags as floating', () => {
    expect(classifyImagePin('saelix/sencho:latest')).toBe('floating');
    expect(classifyImagePin('saelix/sencho')).toBe('floating'); // implicit latest
    expect(classifyImagePin('saelix/sencho:dev')).toBe('floating');
    expect(classifyImagePin('saelix/sencho:edge')).toBe('floating');
  });

  it('does not mistake a registry port for a tag', () => {
    // The colon before the last slash is a registry port, not a tag separator,
    // so an untagged image on a custom-port registry is floating, not semver.
    expect(classifyImagePin('registry.example.com:5000/sencho')).toBe('floating');
    expect(classifyImagePin('registry.example.com:5000/sencho:0.93.3')).toBe('semver');
  });

  it('classifies a digest pin as digest', () => {
    expect(classifyImagePin('saelix/sencho@sha256:abc123')).toBe('digest');
    expect(classifyImagePin('saelix/sencho:0.93.3@sha256:abc123')).toBe('digest');
  });

  it('classifies interpolated, empty, or blank references as unknown', () => {
    expect(classifyImagePin('saelix/sencho:${SENCHO_TAG}')).toBe('unknown');
    expect(classifyImagePin('${SENCHO_IMAGE}')).toBe('unknown');
    expect(classifyImagePin('')).toBe('unknown');
    expect(classifyImagePin('   ')).toBe('unknown');
  });
});

describe('buildTargetImageRef', () => {
  it('swaps only the tag and keeps the registry and repository', () => {
    expect(buildTargetImageRef('saelix/sencho:0.93.3', '0.94.0')).toBe('saelix/sencho:0.94.0');
    expect(buildTargetImageRef('ghcr.io/studio-saelix/sencho:1.0.0', '1.1.0')).toBe(
      'ghcr.io/studio-saelix/sencho:1.1.0',
    );
  });

  it('preserves a v prefix on the current tag', () => {
    expect(buildTargetImageRef('saelix/sencho:v0.93.3', '0.94.0')).toBe('saelix/sencho:v0.94.0');
  });

  it('preserves a -dev repository variant (only the tag is replaced)', () => {
    expect(buildTargetImageRef('ghcr.io/studio-saelix/sencho-dev:0.93.3', '0.94.0')).toBe(
      'ghcr.io/studio-saelix/sencho-dev:0.94.0',
    );
  });

  it('drops any digest suffix on the current ref', () => {
    expect(buildTargetImageRef('saelix/sencho:0.93.3@sha256:abc123', '0.94.0')).toBe(
      'saelix/sencho:0.94.0',
    );
  });

  it('adds a tag when the current ref has none', () => {
    expect(buildTargetImageRef('saelix/sencho', '0.94.0')).toBe('saelix/sencho:0.94.0');
    expect(buildTargetImageRef('registry.example.com:5000/sencho', '0.94.0')).toBe(
      'registry.example.com:5000/sencho:0.94.0',
    );
  });
});

describe('isValidImageRef', () => {
  it('accepts plausible registry/repo:tag and digest references', () => {
    expect(isValidImageRef('saelix/sencho:0.93.3')).toBe(true);
    expect(isValidImageRef('ghcr.io/studio-saelix/sencho-dev:v1.2.3')).toBe(true);
    expect(isValidImageRef('registry.example.com:5000/sencho@sha256:abc')).toBe(true);
  });

  it('rejects empty, whitespace, and control-character references', () => {
    expect(isValidImageRef('')).toBe(false);
    expect(isValidImageRef('saelix/sencho :0.93.3')).toBe(false);
    expect(isValidImageRef('saelix/sencho\n')).toBe(false);
  });

  it('rejects references with shell metacharacters or a leading separator', () => {
    expect(isValidImageRef('saelix/sencho;rm -rf /')).toBe(false);
    expect(isValidImageRef('$(touch pwned)')).toBe(false);
    expect(isValidImageRef(':leadingcolon')).toBe(false);
  });

  it('rejects an implausibly long reference', () => {
    expect(isValidImageRef('a'.repeat(513))).toBe(false);
  });
});

describe('resolveServiceImageFromContents', () => {
  const base = 'services:\n  sencho:\n    image: saelix/sencho:0.93.3\n';

  it('returns the service image and classifies its pin', () => {
    const resolved = resolveServiceImageFromContents([{ filePath: '/c/base.yml', content: base }], 'sencho');
    expect(resolved).toEqual({
      filePath: '/c/base.yml',
      imageRef: 'saelix/sencho:0.93.3',
      fileContent: base,
      pinKind: 'semver',
    });
  });

  it('lets a later -f override win (reverse precedence)', () => {
    // Docker Compose merges later -f files over earlier ones, so the resolver
    // must scan in reverse and return the highest-precedence declaration.
    const override = 'services:\n  sencho:\n    image: saelix/sencho:latest\n';
    const resolved = resolveServiceImageFromContents(
      [
        { filePath: '/c/base.yml', content: base },
        { filePath: '/c/override.yml', content: override },
      ],
      'sencho',
    );
    expect(resolved?.filePath).toBe('/c/override.yml');
    expect(resolved?.imageRef).toBe('saelix/sencho:latest');
    expect(resolved?.pinKind).toBe('floating');
  });

  it('falls back to the base file when the override does not set the image', () => {
    // A common override only tweaks ports/env; it must not shadow the base image.
    const override = 'services:\n  sencho:\n    ports:\n      - "1852:1852"\n';
    const resolved = resolveServiceImageFromContents(
      [
        { filePath: '/c/base.yml', content: base },
        { filePath: '/c/override.yml', content: override },
      ],
      'sencho',
    );
    expect(resolved?.filePath).toBe('/c/base.yml');
    expect(resolved?.imageRef).toBe('saelix/sencho:0.93.3');
  });

  it('skips a malformed override and resolves from the next readable file', () => {
    const malformed = 'services:\n  sencho:\n  image: : : bad';
    const resolved = resolveServiceImageFromContents(
      [
        { filePath: '/c/base.yml', content: base },
        { filePath: '/c/broken.yml', content: malformed },
      ],
      'sencho',
    );
    expect(resolved?.filePath).toBe('/c/base.yml');
  });

  it('returns null when no file declares a string image for the service', () => {
    const noImage = 'services:\n  sencho:\n    build: .\n';
    expect(resolveServiceImageFromContents([{ filePath: '/c/x.yml', content: noImage }], 'sencho')).toBeNull();
    expect(resolveServiceImageFromContents([{ filePath: '/c/x.yml', content: base }], 'other')).toBeNull();
  });
});

describe('patchComposeServiceImage', () => {
  it('rewrites only the target service image and preserves comments and other keys', () => {
    const content = [
      '# Sencho self-hosted',
      'services:',
      '  sencho:',
      '    image: saelix/sencho:0.93.3 # pinned',
      '    ports:',
      '      - "1852:1852"',
      '  db:',
      '    image: postgres:16',
      '',
    ].join('\n');
    const patched = patchComposeServiceImage(content, 'sencho', 'saelix/sencho:0.94.0');
    expect(patched).toContain('image: saelix/sencho:0.94.0');
    expect(patched).not.toContain('saelix/sencho:0.93.3');
    // Comments, sibling service, and unrelated keys survive the round-trip.
    expect(patched).toContain('# Sencho self-hosted');
    expect(patched).toContain('image: postgres:16');
    expect(patched).toContain('- "1852:1852"');
  });

  it('throws when the service has no image to patch (never silently no-ops)', () => {
    const content = 'services:\n  sencho:\n    build: .\n';
    expect(() => patchComposeServiceImage(content, 'sencho', 'saelix/sencho:0.94.0')).toThrow(/no image/i);
  });
});

describe('buildComposeReadArgs', () => {
  it('emits a throwaway root cat container that mounts the working dir read-only', () => {
    const args = buildComposeReadArgs('/opt/sencho', 'saelix/sencho:0.93.3', '/opt/sencho/docker-compose.yml');
    expect(args).toEqual([
      'run', '--rm',
      '--user', 'root',
      '--label', 'io.sencho.helper=compose-read',
      '--entrypoint', 'cat',
      '-v', '/opt/sencho:/opt/sencho:ro',
      '-w', '/opt/sencho',
      'saelix/sencho:0.93.3',
      '/opt/sencho/docker-compose.yml',
    ]);
  });

  it('keeps operator paths as discrete argv data (execFile spawns no shell)', () => {
    const args = buildComposeReadArgs('/srv/$(touch pwned)', 'img', '/srv/$(touch pwned)/compose.yml');
    expect(args).toContain('/srv/$(touch pwned):/srv/$(touch pwned):ro');
    expect(args[args.length - 1]).toBe('/srv/$(touch pwned)/compose.yml');
  });
});

describe('mapHostPathToContainerPath', () => {
  const same = { source: '/opt/sencho', destination: '/opt/sencho' };
  /** The mounts' own destinations, plus any further mount (a volume, say) of the container. */
  const mapPath = (host: string, mounts: Array<{ source: string; destination: string }>, otherDestinations: string[] = []) =>
    mapHostPathToContainerPath(host, mounts, [...mounts.map(m => m.destination), ...otherDestinations]);

  it('maps a file under a folder mount, at the same path or a different one', () => {
    expect(mapPath('/opt/sencho/compose.yaml', [same])).toEqual({
      containerPath: '/opt/sencho/compose.yaml', mountDestination: '/opt/sencho',
    });
    expect(mapPath('/opt/sencho/sub/compose.yaml', [{ source: '/opt/sencho', destination: '/stacks/self' }])).toEqual({
      containerPath: '/stacks/self/sub/compose.yaml', mountDestination: '/stacks/self',
    });
  });

  it('maps an exact file mount to its destination', () => {
    expect(mapPath('/opt/sencho/compose.yaml', [{ source: '/opt/sencho/compose.yaml', destination: '/etc/self.yaml' }])).toEqual({
      containerPath: '/etc/self.yaml', mountDestination: '/etc/self.yaml',
    });
  });

  it('picks the mount with the longest source', () => {
    const mounts = [
      { source: '/opt', destination: '/host-opt' },
      { source: '/opt/sencho', destination: '/self' },
      { source: '/opt/sencho/data', destination: '/data' },
    ];
    expect(mapPath('/opt/sencho/compose.yaml', mounts)?.containerPath).toBe('/self/compose.yaml');
    expect(mapPath('/opt/other/compose.yaml', mounts)?.containerPath).toBe('/host-opt/other/compose.yaml');
  });

  it('matches whole path segments only', () => {
    expect(mapPath('/opt/docker/x.yaml', [{ source: '/opt/dock', destination: '/d' }])).toBeNull();
    expect(mapPath('/opt/sencho-two/x.yaml', [same])).toBeNull();
  });

  it('ignores trailing slashes on a mount and normalizes the host path', () => {
    const mounts = [{ source: '/opt/sencho/', destination: '/self/' }];
    expect(mapPath('/opt/sencho//./compose.yaml', mounts)?.containerPath).toBe('/self/compose.yaml');
  });

  it('refuses relative paths and any .. segment', () => {
    expect(mapPath('opt/sencho/compose.yaml', [same])).toBeNull();
    expect(mapPath('/opt/sencho/../../etc/passwd', [same])).toBeNull();
    expect(mapPath('/opt/sencho/compose.yaml', [{ source: '/opt/sencho/..', destination: '/x' }])).toBeNull();
    expect(mapPath('/opt/sencho/compose.yaml', [{ source: '/opt/sencho', destination: 'relative' }])).toBeNull();
  });

  it('maps through a mount of the host root', () => {
    expect(mapPath('/opt/sencho/compose.yaml', [{ source: '/', destination: '/host' }])).toEqual({
      containerPath: '/host/opt/sencho/compose.yaml', mountDestination: '/host',
    });
  });

  describe('a mount nested over the mapped path', () => {
    const apps = { source: '/mnt/pool/apps', destination: '/apps' };
    const config = { source: '/mnt/pool/sencho-config', destination: '/apps/sencho' };

    it('refuses a path another bind mount shows different contents at', () => {
      expect(mapPath('/mnt/pool/apps/sencho/compose.yaml', [apps, config])).toBeNull();
      expect(mapPath('/mnt/pool/apps/sencho/deep/dir/compose.yaml', [apps, config])).toBeNull();
    });

    it('refuses a path a volume or tmpfs shadows, which is not a bind mount', () => {
      expect(mapPath('/mnt/pool/apps/sencho/compose.yaml', [apps], ['/apps/sencho'])).toBeNull();
    });

    it('refuses a single file another mount replaces', () => {
      expect(mapPath('/mnt/pool/apps/sencho/compose.yaml', [apps], ['/apps/sencho/compose.yaml'])).toBeNull();
    });

    it('still maps a sibling the nested mount does not cover', () => {
      expect(mapPath('/mnt/pool/apps/other/compose.yaml', [apps, config])).toEqual({
        containerPath: '/apps/other/compose.yaml', mountDestination: '/apps',
      });
      expect(mapPath('/mnt/pool/apps/sencho-two/compose.yaml', [apps, config])).toEqual({
        containerPath: '/apps/sencho-two/compose.yaml', mountDestination: '/apps',
      });
    });

    it('maps a path under the nested mount through that mount when its source matches', () => {
      expect(mapPath('/mnt/pool/sencho-config/compose.yaml', [apps, config])).toEqual({
        containerPath: '/apps/sencho/compose.yaml', mountDestination: '/apps/sencho',
      });
    });

    it('ignores a mount elsewhere and unusable destinations', () => {
      expect(mapPath('/mnt/pool/apps/sencho/compose.yaml', [apps], ['/data', 'relative', '/apps/sencho/../x'])?.containerPath)
        .toBe('/apps/sencho/compose.yaml');
    });
  });

  it('returns null with no mounts or no matching mount', () => {
    expect(mapPath('/opt/sencho/compose.yaml', [])).toBeNull();
    expect(mapPath('/srv/x/compose.yaml', [same])).toBeNull();
  });
});

describe('isShadowedByDeeperMount', () => {
  it('is true for a deeper destination that is the path or a parent of it, compared by whole segment', () => {
    expect(isShadowedByDeeperMount('/apps/sencho/compose.yaml', '/apps', ['/apps', '/apps/sencho'])).toBe(true);
    expect(isShadowedByDeeperMount('/apps/sencho/compose.yaml', '/apps', ['/apps/sencho/compose.yaml'])).toBe(true);
    expect(isShadowedByDeeperMount('/apps/sencho-two/compose.yaml', '/apps', ['/apps/sencho'])).toBe(false);
  });

  it('is false for the chosen mount, a shallower one, or none', () => {
    expect(isShadowedByDeeperMount('/apps/sencho/compose.yaml', '/apps/sencho', ['/apps/sencho', '/apps', '/'])).toBe(false);
    expect(isShadowedByDeeperMount('/apps/sencho/compose.yaml', '/apps', [])).toBe(false);
  });
});

describe('buildSelfUpdateComposeCmd (dependencies)', () => {
  // A Sencho-only recreate never touches the services it depends on: --no-deps
  // keeps Compose from recreating a Docker socket proxy (changed or unchanged),
  // which is what cut the connection when a different Compose version than the
  // running container's created it. The endpoint replacement is the only path
  // that recreates that service, deliberately and with its own confirmation.
  it('recreates Sencho alone and never lets Compose touch its depends_on services', () => {
    const cmd = buildSelfUpdateComposeCmd(['-f', '/opt/sencho/docker-compose.yml'], 'sencho', '/tmp/_sencho_err', '/app/data/.sencho-update-error', false);
    expect(cmd).toContain("up -d --no-deps --force-recreate 'sencho'");
    expect(cmd).not.toContain('--always-recreate-deps');
  });
});

describe('buildSelfUpdateComposeCmd (repin copy branch)', () => {
  const fFlags = ['-f', '/opt/sencho/docker-compose.yml'];
  const stderrTmp = '/tmp/_sencho_err';
  const errorFile = '/app/data/.sencho-update-error';

  it('copies the staged compose file onto the host before recreate', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, false, {
      stagedPath: '/app/data/.sencho-compose-patch',
      targetPath: '/opt/sencho/docker-compose.yml',
    });
    // The copy runs before the recreate so a failed write never half-applies.
    expect(cmd.indexOf('cp ')).toBeLessThan(cmd.indexOf('up -d --no-deps --force-recreate'));
    expect(cmd).toContain(
      `cp ${shQuote('/app/data/.sencho-compose-patch')} ${shQuote('/opt/sencho/docker-compose.yml')}`,
    );
  });

  it('aborts before recreate when the copy fails and records the error', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, false, {
      stagedPath: '/app/data/.sencho-compose-patch',
      targetPath: '/opt/sencho/docker-compose.yml',
    });
    // A failed copy writes the error file and exits 1 before any recreate.
    expect(cmd).toContain('exit 1');
    expect(cmd.indexOf('exit 1')).toBeLessThan(cmd.indexOf('up -d --no-deps --force-recreate'));
    expect(cmd).toContain('Failed to write the updated compose file');
  });

  it('shell-quotes the copy paths so metacharacters cannot break the command', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, false, {
      stagedPath: '/app/data/x; rm -rf /',
      targetPath: '/opt/sencho/y; echo pwned',
    });
    expect(cmd).toContain(shQuote('/app/data/x; rm -rf /'));
    expect(cmd).toContain(shQuote('/opt/sencho/y; echo pwned'));
    expect(cmd).not.toContain('cp /app/data/x; rm -rf /');
  });

  it('omits the copy step entirely when no composeCopy is supplied', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, false);
    expect(cmd).not.toContain('cp ');
    expect(cmd).not.toContain('Failed to write the updated compose file');
  });
});

describe('buildSelfUpdateRunArgs (repinWritable branch)', () => {
  const COMPOSE = 'COMPOSE_CMD';

  it('mounts the working dir read-write only when a repin is staged', () => {
    const args = buildSelfUpdateRunArgs(
      { workingDir: '/opt/sencho', imageName: 'img', dataDirHost: '/opt/sencho/data', hostBindMounts: [], repinWritable: true },
      COMPOSE,
    );
    expect(args).toContain('/opt/sencho:/opt/sencho:rw');
    expect(args).not.toContain('/opt/sencho:/opt/sencho:ro');
  });

  it('keeps the working dir read-only when no repin is staged (minimal write scope)', () => {
    const args = buildSelfUpdateRunArgs(
      { workingDir: '/opt/sencho', imageName: 'img', dataDirHost: '/opt/sencho/data', hostBindMounts: [], repinWritable: false },
      COMPOSE,
    );
    expect(args).toContain('/opt/sencho:/opt/sencho:ro');
    expect(args).not.toContain('/opt/sencho:/opt/sencho:rw');
  });
});

describe('buildComposeConfigValidateArgs', () => {
  it('runs compose config in a throwaway helper with the working dir mounted read-only', () => {
    const args = buildComposeConfigValidateArgs({
      workingDir: '/opt/sencho',
      imageName: 'saelix/sencho:1.0.0',
      configFiles: 'docker-compose.yml,/opt/sencho/override.yml',
      hostBindMounts: [{ source: '/etc/sencho', destination: '/etc/sencho' }],
    });
    expect(args).toContain('/opt/sencho:/opt/sencho:ro');
    expect(args).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(args).toContain('/etc/sencho:/etc/sencho:ro');
    const cmd = args[args.length - 1];
    expect(cmd).toContain('docker compose');
    expect(cmd).toContain('config');
    expect(cmd).toContain(shQuote('docker-compose.yml'));
    expect(cmd).toContain(shQuote('/opt/sencho/override.yml'));
  });

  it.each([
    ['a custom project', 'operator-project', true],
    ['no project label', null, false],
  ])('passes %s to the preliminary render so it matches staging and replacement', (_label, project, expected) => {
    const args = buildComposeConfigValidateArgs({
      workingDir: '/opt/sencho',
      imageName: 'saelix/sencho:1.0.0',
      configFiles: 'docker-compose.yml',
      hostBindMounts: [],
      project,
    });
    const cmd = args[args.length - 1];
    if (expected) {
      expect(cmd).toContain(`'-p' ${shQuote(project!)}`);
      expect(cmd.indexOf('-p')).toBeLessThan(cmd.indexOf(shQuote('docker-compose.yml')));
      expect(cmd.endsWith(' config')).toBe(true);
    } else {
      expect(cmd).not.toContain(' -p ');
    }
  });
});

describe('isSenchoDevRepository', () => {
  it('returns true for the floating dev tag', () => {
    expect(isSenchoDevRepository('ghcr.io/studio-saelix/sencho-dev:dev')).toBe(true);
  });

  it('returns true for an immutable dev-<sha> tag', () => {
    expect(isSenchoDevRepository('ghcr.io/studio-saelix/sencho-dev:dev-a1b2c3d')).toBe(true);
  });

  it('returns true for a digest-pinned reference', () => {
    expect(
      isSenchoDevRepository('ghcr.io/studio-saelix/sencho-dev@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    ).toBe(true);
  });

  it('returns true for a reference with both tag and digest', () => {
    expect(
      isSenchoDevRepository('ghcr.io/studio-saelix/sencho-dev:dev@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    ).toBe(true);
  });

  it('returns false for the stable sencho repository', () => {
    expect(isSenchoDevRepository('ghcr.io/studio-saelix/sencho:1.2.3')).toBe(false);
  });

  it('returns false for the hardened repository', () => {
    expect(isSenchoDevRepository('ghcr.io/studio-saelix/sencho-hardened:1.2.3')).toBe(false);
  });

  it('returns false for the Docker Hub stable repository', () => {
    expect(isSenchoDevRepository('saelix/sencho:latest')).toBe(false);
  });

  it('returns false for an unrelated image', () => {
    expect(isSenchoDevRepository('docker.io/library/nginx:latest')).toBe(false);
  });

  it('returns false for an interpolated variable', () => {
    expect(isSenchoDevRepository('${SENCHO_IMAGE}')).toBe(false);
  });

  it('returns false for a registry-with-port reference to an unrelated repository', () => {
    expect(isSenchoDevRepository('localhost:5000/something:dev')).toBe(false);
  });

  it('returns false for empty or malformed references', () => {
    expect(isSenchoDevRepository('')).toBe(false);
    expect(isSenchoDevRepository('   ')).toBe(false);
  });
});

describe('isSenchoDevFloatingTag', () => {
  it('returns true only for the floating dev tag', () => {
    expect(isSenchoDevFloatingTag('ghcr.io/studio-saelix/sencho-dev:dev')).toBe(true);
  });

  it('returns false for an immutable dev-<sha> tag (not the floating dev tag)', () => {
    expect(isSenchoDevFloatingTag('ghcr.io/studio-saelix/sencho-dev:dev-a1b2c3d')).toBe(false);
  });

  it('returns false for a digest-pinned reference (disqualifies floating)', () => {
    expect(
      isSenchoDevFloatingTag('ghcr.io/studio-saelix/sencho-dev@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    ).toBe(false);
  });

  it('returns false for a reference with both tag and digest (still digest-pinned)', () => {
    expect(
      isSenchoDevFloatingTag('ghcr.io/studio-saelix/sencho-dev:dev@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    ).toBe(false);
  });

  it('returns false for the stable sencho repository', () => {
    expect(isSenchoDevFloatingTag('ghcr.io/studio-saelix/sencho:1.2.3')).toBe(false);
  });

  it('returns false for the hardened repository', () => {
    expect(isSenchoDevFloatingTag('ghcr.io/studio-saelix/sencho-hardened:1.2.3')).toBe(false);
  });

  it('returns false for the Docker Hub stable repository', () => {
    expect(isSenchoDevFloatingTag('saelix/sencho:latest')).toBe(false);
  });

  it('returns false for an unrelated image', () => {
    expect(isSenchoDevFloatingTag('docker.io/library/nginx:latest')).toBe(false);
  });

  it('returns false for an interpolated variable', () => {
    expect(isSenchoDevFloatingTag('${SENCHO_IMAGE}')).toBe(false);
  });

  it('returns false for a registry-with-port reference to an unrelated repository', () => {
    expect(isSenchoDevFloatingTag('localhost:5000/something:dev')).toBe(false);
  });

  it('returns false for empty or malformed references', () => {
    expect(isSenchoDevFloatingTag('')).toBe(false);
    expect(isSenchoDevFloatingTag('   ')).toBe(false);
  });
});

describe('parseMountPoints', () => {
  it('reads the mount point field and decodes its octal escapes', () => {
    const text = [
      '36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue',
      '37 36 0:50 / /apps/with\\040space rw - overlay overlay rw',
      '',
    ].join('\n');
    expect(parseMountPoints(text)).toEqual(['/mnt2', '/apps/with space']);
  });
});

describe('resolveMountDestinations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-mount-dest-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const info = (...points: string[]) => {
    const file = path.join(dir, `mountinfo-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, points.map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n'));
    return file;
  };
  const none = path.join(dir, 'no-such-mountinfo');

  it('adds where a destination that runs through a symlink really is, and keeps the recorded one', async () => {
    fs.mkdirSync(path.join(dir, 'v2', 'sencho'), { recursive: true });
    fs.symlinkSync('v2', path.join(dir, 'current'));
    const recorded = path.join(dir, 'current', 'sencho');

    const view = await resolveMountDestinations([recorded], none);

    expect(view.destinations).toContain(recorded);
    expect(view.destinations).toContain(fs.realpathSync(path.join(dir, 'v2', 'sencho')));
    expect(view.hides(fs.realpathSync(path.join(dir, 'v2', 'sencho')))).toBe(false);
  });

  it('takes the live mount points, which a symlink retargeted after the start does not move', async () => {
    fs.mkdirSync(path.join(dir, 'v3', 'sencho'), { recursive: true });
    fs.rmSync(path.join(dir, 'current'));
    fs.symlinkSync('v3', path.join(dir, 'current'));
    const recorded = path.join(dir, 'current', 'sencho');

    const view = await resolveMountDestinations([recorded], info(path.join(dir, 'v2', 'sencho')));

    expect(view.destinations).toContain(path.join(dir, 'v2', 'sencho'));
  });

  it('says a mount is hidden when another is on its path, or a parent path is mounted after it', async () => {
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
    fs.symlinkSync('run', path.join(dir, 'var-run'));

    expect((await resolveMountDestinations([], info('/a', '/a', '/b'))).hides('/a')).toBe(true);
    expect((await resolveMountDestinations([], info('/a', '/b'))).hides('/a')).toBe(false);
    // From the live list: /run/sencho is mounted first, then /run over all of it.
    expect((await resolveMountDestinations([], info('/run/sencho', '/run'))).hides('/run/sencho')).toBe(true);
    expect((await resolveMountDestinations([], info('/run', '/run/sencho'))).hides('/run/sencho')).toBe(false);
    // Without a live list: two recorded destinations that resolve to one path.
    const run = fs.realpathSync(path.join(dir, 'run'));
    expect((await resolveMountDestinations([path.join(dir, 'run'), path.join(dir, 'var-run')], none)).hides(run)).toBe(true);
  });

  it('uses live mount points that Docker did not record only when a recorded destination runs through a symlink', async () => {
    fs.mkdirSync(path.join(dir, 'plain'), { recursive: true });
    const plain = path.join(dir, 'plain');
    const submount = path.join(plain, 'dataset');

    // A recursive submount of a bound folder is not recorded and shows the host's own file.
    expect((await resolveMountDestinations([plain], info(plain, submount))).destinations).not.toContain(submount);
    // With a symlinked destination in the list, an unrecorded point may be where that mount really is.
    const linked = path.join(dir, 'current', 'sencho');
    expect((await resolveMountDestinations([plain, linked], info(plain, submount))).destinations).toContain(submount);
    expect((await resolveMountDestinations([plain, path.join(dir, 'nowhere')], info(plain, submount))).destinations).toContain(submount);
  });

  it('keeps only the recorded form of a destination that does not exist or is not absolute', async () => {
    const missing = path.join(dir, 'missing', 'mount');
    const view = await resolveMountDestinations([missing, 'relative/path'], none);
    expect(view.destinations).toEqual([missing, 'relative/path', missing]);
  });
});

describe('crossesAbsoluteSymlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-abs-link-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (...parts: string[]) => path.join(dir, ...parts);

  it('is false for plain files and for relative links that stay inside the mount', async () => {
    fs.mkdirSync(at('real'), { recursive: true });
    fs.writeFileSync(at('real', 'compose.yaml'), 'x');
    fs.symlinkSync('real', at('rel'));
    expect(await crossesAbsoluteSymlink(dir, at('real', 'compose.yaml'))).toBe(false);
    expect(await crossesAbsoluteSymlink(dir, at('rel', 'compose.yaml'))).toBe(false);
    expect(await crossesAbsoluteSymlink(dir, at('absent', 'compose.yaml'))).toBe(false);
  });

  it('is true for an absolute link, including one reached through a relative link', async () => {
    fs.symlinkSync(at('real'), at('abs'));
    fs.symlinkSync('abs', at('chain'));
    expect(await crossesAbsoluteSymlink(dir, at('abs', 'compose.yaml'))).toBe(true);
    expect(await crossesAbsoluteSymlink(dir, at('chain', 'compose.yaml'))).toBe(true);
  });

  it('is true for a link that leaves the mount, a link loop, and a path outside the mount', async () => {
    fs.symlinkSync('../..', at('up'));
    fs.symlinkSync('loop2', at('loop1'));
    fs.symlinkSync('loop1', at('loop2'));
    expect(await crossesAbsoluteSymlink(dir, at('up', 'x'))).toBe(true);
    expect(await crossesAbsoluteSymlink(dir, at('loop1'))).toBe(true);
    expect(await crossesAbsoluteSymlink(dir, '/elsewhere/compose.yaml')).toBe(true);
  });
});
