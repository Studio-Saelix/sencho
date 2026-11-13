/**
 * Unit tests for collectServiceHealthcheckEvidence. Mocks Docker list/inspect
 * and image inspect; asserts structural evidence states and that Test command
 * text never appears in returned evidence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectServiceHealthcheckEvidence } from '../services/healthcheck/collectServiceHealthcheckEvidence';
import type { EffectiveModel, EffService } from '../services/preflight/effectiveModel';
import DockerController from '../services/DockerController';

function svc(over: Partial<EffService> = {}): EffService {
  const hasHealthcheck = over.hasHealthcheck ?? false;
  const composeHealthcheck = over.composeHealthcheck ?? (hasHealthcheck ? 'active' : 'absent');
  return {
    name: 'web', image: 'nginx:1.27', ports: [], binds: [], namedVolumes: [], storageMounts: [],
    privileged: false, restart: 'unless-stopped', envKeys: [],
    enabledProxyApiFlags: [],
    dockerEndpointHosts: [],
    networks: [], extraHosts: [], labelKeys: [],
    ...over,
    hasHealthcheck,
    composeHealthcheck,
  };
}

function model(services: EffService[]): EffectiveModel {
  return { projectName: 'proj', services, networks: {}, volumes: {} };
}

function mockDocker(opts: {
  list?: unknown[];
  listError?: Error;
  inspectById?: Record<string, { Config?: { Image?: string; Healthcheck?: { Test?: unknown } } }>;
  inspectError?: Error;
  image?: { Config?: { Healthcheck?: { Test?: unknown } } } | 'missing' | 'error';
  imageError?: Error;
}) {
  const getContainer = vi.fn((id: string) => ({
    inspect: vi.fn(async () => {
      if (opts.inspectError) throw opts.inspectError;
      const hit = opts.inspectById?.[id];
      if (!hit) {
        const err = Object.assign(new Error('not found'), { statusCode: 404 });
        throw err;
      }
      return hit;
    }),
  }));
  const listContainers = vi.fn(async () => {
    if (opts.listError) throw opts.listError;
    return opts.list ?? [];
  });
  const getDocker = vi.fn(() => ({ listContainers, getContainer }));
  const inspectImage = vi.fn(async () => {
    if (opts.imageError) throw opts.imageError;
    if (opts.image === 'missing' || opts.image === 'error') {
      throw Object.assign(new Error('No such image'), { statusCode: 404 });
    }
    return { inspect: opts.image ?? { Config: {} }, history: [] };
  });
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker,
    inspectImage,
  } as unknown as DockerController);
  return { listContainers, getContainer, inspectImage };
}

describe('collectServiceHealthcheckEvidence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns compose-declared for an active Compose healthcheck without Docker calls', async () => {
    const { listContainers } = mockDocker({});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ hasHealthcheck: true, composeHealthcheck: 'active' })]), true,
    );
    expect(evidence.web).toEqual({ state: 'compose-declared', origin: 'compose', consistentReplicas: null });
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('returns explicitly-disabled for Compose disablement', async () => {
    mockDocker({});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'disabled' })]), true,
    );
    expect(evidence.web.state).toBe('explicitly-disabled');
  });

  it('lists containers by Compose projectName, not the stack directory name', async () => {
    const { listContainers } = mockDocker({
      list: [{
        Id: 'c1',
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:1.27',
      }],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
    });
    const m: EffectiveModel = {
      projectName: 'qa-hc-1713',
      services: [svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })],
      networks: {},
      volumes: {},
    };
    const evidence = await collectServiceHealthcheckEvidence(1, 'qa-healthcheck', m, true);
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['com.docker.compose.project=qa-hc-1713'] },
    });
    expect(evidence.web.state).toBe('runtime-inherited');
  });

  it('recognizes runtime-inherited healthchecks and never returns Test text', async () => {
    mockDocker({
      list: [{
        Id: 'c1',
        Names: ['/proj-web-1'],
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:1.27',
      }],
      inspectById: {
        c1: {
          Config: {
            Image: 'nginx:1.27',
            Healthcheck: { Test: ['CMD-SHELL', 'curl -f http://x/?token=secret-token || exit 1'] },
          },
        },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web).toEqual({
      state: 'runtime-inherited',
      origin: 'runtime',
      consistentReplicas: true,
    });
    expect(JSON.stringify(evidence)).not.toContain('secret-token');
    expect(JSON.stringify(evidence)).not.toContain('CMD-SHELL');
  });

  it('matches containers via composeServiceMatch when the service label is absent', async () => {
    mockDocker({
      list: [{ Id: 'c1', Names: ['/web'], Image: 'nginx:1.27' }],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ name: 'web', composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('runtime-inherited');
  });

  it('ignores stale image replicas and uses local-image evidence', async () => {
    mockDocker({
      list: [{
        Id: 'c1',
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:old',
      }],
      inspectById: {
        c1: { Config: { Image: 'nginx:old', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
      image: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('local-image-inherited');
    expect(evidence.web.origin).toBe('local-image');
  });

  it('reports inconsistent-replicas when coverage mixes', async () => {
    mockDocker({
      list: [
        { Id: 'c1', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
        { Id: 'c2', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
      ],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
        c2: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['NONE'] } } },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('inconsistent-replicas');
  });

  it('reports unverifiable when Docker is unavailable', async () => {
    mockDocker({});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent' })]), false,
    );
    expect(evidence.web.state).toBe('unverifiable');
  });

  it('reports unverifiable for a missing local image', async () => {
    mockDocker({ list: [], image: 'missing' });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
  });

  it('reports unverifiable for build-only services with no image', async () => {
    mockDocker({ list: [] });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: undefined })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
  });

  it('reports absent when local image has no healthcheck', async () => {
    mockDocker({ list: [], image: { Config: {} } });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web).toEqual({
      state: 'absent',
      origin: 'local-image',
      consistentReplicas: null,
    });
  });

  it('reports absent when matching replicas lack a healthcheck even if the local image has one', async () => {
    mockDocker({
      list: [{
        Id: 'c1',
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:1.27',
      }],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['NONE'] } } },
      },
      image: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web).toEqual({
      state: 'absent',
      origin: 'runtime',
      consistentReplicas: true,
    });
  });

  it('reports unverifiable when some replica inspects fail amid otherwise full coverage', async () => {
    mockDocker({
      list: [
        { Id: 'c1', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
        { Id: 'gone', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
      ],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
    expect(evidence.web.origin).toBe('runtime');
  });

  it('treats a disappearing container as inspect failure and falls through', async () => {
    mockDocker({
      list: [{ Id: 'gone', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' }],
      inspectById: {},
      image: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('local-image-inherited');
  });

  it('never logs registry credentials from an image that cannot be inspected', async () => {
    const image = 'user:Ab/cD+eF9xyz=:x@registry.example.com/app:latest';
    // The message docker-modem builds from Docker 29.9.3's HTTP 400 body for
    // this reference: it quotes only the repository name after the credential's
    // first `/`, and a colon in the password cuts that quote at the prefix.
    const dockerError = new Error(
      '(HTTP code 400) unexpected - invalid reference format: repository name (cD+eF9xyz=) must be lowercase ',
    );
    mockDocker({ list: [], image: 'error', imageError: dockerError });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
    const logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).not.toContain('Ab/cD+eF9xyz=');
    expect(logged).not.toContain('cD+eF9xyz=');
    expect(logged).not.toContain('eF9xyz');
    expect(logged).toContain('must be lowercase');
    expect(logged).toContain('[redacted]@registry.example.com/app:latest');
    const imageWarn = warn.mock.calls.find(args => String(args[0]).includes('image inspect failed'));
    expect(imageWarn).toBeDefined();
    expect(imageWarn?.[1]).toBe('[redacted]@registry.example.com/app:latest');
    expect(String(imageWarn?.[2])).not.toContain('eF9xyz');
    expect(String(imageWarn?.[2])).toContain('must be lowercase');
  });

  // Docker decodes the request path before its reference parser runs, and the
  // parser normalizes a familiar Docker Hub name. The warning must not carry
  // the credential in either the authored or the daemon's spelling.
  it.each([
    {
      name: 'an encoded slash',
      image: 'user:Ab%2fSuperSecret:x@registry.example.com/app:latest',
      quoted: 'SuperSecret',
      forbidden: ['SuperSecret', '%2f'],
      rest: 'registry.example.com/app:latest',
    },
    {
      name: 'an encoded letter',
      image: 'user:Ab/Super%53ecret:x@registry.example.com/app:latest',
      quoted: 'SuperSecret',
      forbidden: ['SuperSecret', '%53'],
      rest: 'registry.example.com/app:latest',
    },
    {
      name: 'an encoded colon',
      image: 'user:Ab/SuperSecret%3ax@registry.example.com/app:latest',
      quoted: 'SuperSecret',
      forbidden: ['SuperSecret', '%3a'],
      rest: 'registry.example.com/app:latest',
    },
    {
      name: 'an encoded token-only multi-segment prefix',
      image: 't%6fkenonly/foo%2fSuperSecret:x@registry.example.com/app:latest',
      quoted: 'tokenonly/foo/SuperSecret',
      forbidden: ['SuperSecret', 'tokenonly/foo', '%2f', '%6f'],
      rest: 'registry.example.com/app:latest',
    },
    {
      name: 'a decoded byte Docker replaces before it quotes the name',
      image: 'user:Ab%2f%FFSuperSecret:x@registry.example.com/app:latest',
      quoted: '\uFFFDSuperSecret',
      forbidden: ['SuperSecret', '%FF'],
      rest: 'registry.example.com/app:latest',
    },
    {
      name: 'an encoded credential on a digest pin',
      image: `user:Ab%2fSuperSecret:x@registry.example.com/app:latest@sha256:${'a'.repeat(64)}`,
      quoted: 'SuperSecret',
      forbidden: ['SuperSecret', '%2f'],
      rest: `registry.example.com/app:latest@sha256:${'a'.repeat(64)}`,
    },
    {
      name: 'a canonical Docker Hub name',
      image: 'docker.io/Pass:x@registry.example.com',
      quoted: 'library/Pass',
      forbidden: ['Pass', 'library/Pass'],
      rest: 'registry.example.com',
    },
    {
      name: 'the legacy Docker Hub index domain',
      image: 'index.docker.io/Pass:x@registry.example.com',
      quoted: 'library/Pass',
      forbidden: ['Pass', 'library/Pass'],
      rest: 'registry.example.com',
    },
  ])('never logs a credential Docker decodes or normalizes for $name', async ({ image, quoted, forbidden, rest }) => {
    const dockerError = new Error(
      `(HTTP code 400) unexpected - invalid reference format: repository name (${quoted}) must be lowercase `,
    );
    const { inspectImage } = mockDocker({ list: [], image: 'error', imageError: dockerError });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
    expect(inspectImage).toHaveBeenCalledWith(image);
    const logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
    for (const fragment of forbidden) expect(logged).not.toContain(fragment);
    expect(logged).toContain('must be lowercase');
    expect(logged).toContain(`[redacted]@${rest}`);
    const imageWarn = warn.mock.calls.find(args => String(args[0]).includes('image inspect failed'));
    expect(imageWarn).toBeDefined();
    expect(imageWarn?.[1]).toBe(`[redacted]@${rest}`);
    expect(String(imageWarn?.[2])).not.toContain(quoted);
    expect(String(imageWarn?.[2])).toContain('must be lowercase');
  });

  it('never logs registry credentials from the compose project label', async () => {
    mockDocker({ listError: new Error('daemon down'), image: { Config: {} } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m: EffectiveModel = {
      projectName: 'user:p4ssw0rdXYZ@registry.example.com/app',
      services: [svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })],
      networks: {},
      volumes: {},
    };
    await collectServiceHealthcheckEvidence(1, 'proj', m, true);
    const logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).not.toContain('p4ssw0rdXYZ');
    expect(logged).toContain('[redacted]@registry.example.com/app');
  });

  it('never logs credentials carried by a replica inspect error', async () => {
    mockDocker({
      list: [{ Id: 'c1', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' }],
      inspectError: new Error('inspect failed for token:tok3nvalue@registry.example.com/app:1.0'),
      image: { Config: {} },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('absent');
    const logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).not.toContain('tok3nvalue');
    expect(logged).toContain('[ComposeDoctor] Healthcheck container inspect failed');
  });
});

describe('collectServiceHealthcheckEvidence list failure', () => {
  beforeEach(() => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn(async () => { throw new Error('daemon down'); }),
        getContainer: vi.fn(),
      }),
      inspectImage: vi.fn(async () => ({
        inspect: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
        history: [],
      })),
    } as unknown as DockerController);
  });
  afterEach(() => vi.restoreAllMocks());

  it('falls through to local-image evidence when the container list fails', async () => {
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('local-image-inherited');
  });
});
