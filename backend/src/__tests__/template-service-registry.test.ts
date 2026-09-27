/**
 * Registry-fetch tests for TemplateService.getTemplates: the response-size cap
 * surfaces a clean error instead of letting an oversized body propagate, the
 * fetch is issued with the size-limit axios options, and both registry formats
 * reach `compose.yaml` with renderable port specs.
 *
 * Port fixtures are verbatim LinuxServer.io payloads. That API sends port values
 * as strings, never sends a `protocol` key, and for some apps carries the
 * protocol inside the container value, so a fixture invented to match the
 * mapper's assumption would pass while real catalogues failed to render.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import axios from 'axios';
import YAML from 'yaml';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: (e: unknown): boolean => !!(e as { isAxiosError?: boolean })?.isAxiosError,
  },
}));

const mockedGet = vi.mocked(axios.get);

let tmpDir: string;
let TemplateService: typeof import('../services/TemplateService').TemplateService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ TemplateService } = await import('../services/TemplateService'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockedGet.mockReset();
  DatabaseService.getInstance().updateGlobalSetting('template_registry_url', '');
});

/**
 * The LinuxServer.io HTTP body the mapper reads. Returned as the axios `data`,
 * so it is the body itself: `{ data: { repositories: { linuxserver } } }`.
 */
function lsioPayload(apps: Record<string, unknown>): unknown {
  return { data: { repositories: { linuxserver: apps } } };
}

/** The single service block of a generated compose file. */
function serviceOf(yaml: string, name: string): Record<string, unknown> {
  const parsed = YAML.parse(yaml) as { services: Record<string, Record<string, unknown>> };
  return parsed.services[name];
}

describe('TemplateService.getTemplates registry size cap', () => {
  it('issues the fetch with content/body size limits', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockResolvedValueOnce({ data: { data: { repositories: { linuxserver: {} } } } });

    await service.getTemplates();

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const [, options] = mockedGet.mock.calls[0];
    expect(options?.maxContentLength).toBe(25 * 1024 * 1024);
    expect(options?.maxBodyLength).toBe(25 * 1024 * 1024);
  });

  it('maps an oversized-response error to a clean size-limit message', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'maxContentLength size of 26214400 exceeded',
    });

    await expect(service.getTemplates()).rejects.toThrow(/response exceeded the size limit/i);
  });

  it('maps other registry failures to the generic fetch error', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockRejectedValueOnce({ isAxiosError: true, message: 'ECONNREFUSED' });

    await expect(service.getTemplates()).rejects.toThrow(/Could not fetch templates from registry$/);
  });

  it('maps the default LinuxServer.io response shape into templates', async () => {
    const service = new TemplateService();
    service.clearCache();
    // Real plex payload: it declares no ports at all.
    mockedGet.mockResolvedValueOnce({
      data: lsioPayload({
        plex: {
          name: 'plex',
          description: 'Media server',
          stars: 100,
          arch: ['x86-64'],
          github: 'https://github.com/linuxserver/docker-plex',
          readme: 'https://docs.example/plex',
          config: {
            volumes: [{ path: '/config' }],
            environment: [{ name: 'PUID', desc: 'User ID', default: '1000' }],
          },
        },
      }),
    });

    const templates = await service.getTemplates();
    const plex = templates.find(t => t.title === 'plex');
    expect(plex).toBeDefined();
    expect(plex!.image).toBe('lscr.io/linuxserver/plex:latest');
    expect(plex!.source).toBe('linuxserver');
    expect(plex!.ports).toEqual([]);
    expect(plex!.volumes).toEqual([{ container: '/config', bind: './config' }]);
    expect(plex!.env).toEqual([{ name: 'PUID', label: 'User ID', default: '1000' }]);
    expect(plex!.categories).toEqual(['Media']);
  });

  it('gives a port one protocol when LinuxServer.io embeds it in the container value', async () => {
    const service = new TemplateService();
    service.clearCache();
    // Verbatim swag payload. The third entry carries /udp in `internal` and
    // sends no `protocol` key, which is what produced '443:443/udp/tcp'.
    mockedGet.mockResolvedValueOnce({
      data: lsioPayload({
        swag: {
          name: 'swag',
          description: 'An nginx reverse proxy with automatic ACME certs',
          config: {
            ports: [
              { external: '443', internal: '443', desc: 'HTTPS port', optional: false },
              { external: '80', internal: '80', desc: 'HTTP port', optional: true },
              { external: '443', internal: '443/udp', desc: 'QUIC (HTTP/3) port', optional: true },
            ],
          },
        },
      }),
    });

    const templates = await service.getTemplates();
    const swag = templates.find(t => t.title === 'swag')!;
    expect(swag.ports).toEqual(['443:443/tcp', '80:80/tcp', '443:443/udp']);
    // The generated compose is what Docker Compose will be asked to render.
    const svc = serviceOf(service.generateComposeFromTemplate(swag, 'swag'), 'swag');
    expect(svc.ports).toEqual(['443:443/tcp', '80:80/tcp', '443:443/udp']);
  });

  it('gives a udp-only LinuxServer.io app a single protocol (wireguard)', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockResolvedValueOnce({
      data: lsioPayload({
        wireguard: {
          name: 'wireguard',
          description: 'A blazingly fast, modern, lightweight VPN',
          config: { ports: [{ external: '51820', internal: '51820/udp', desc: 'wireguard port' }] },
        },
      }),
    });

    const templates = await service.getTemplates();
    const wireguard = templates.find(t => t.title === 'wireguard')!;
    expect(wireguard.ports).toEqual(['51820:51820/udp']);
  });

  it('normalizes structured ports from a custom registry too', async () => {
    const service = new TemplateService();
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    service.clearCache();
    // A custom registry publishing structured ports, plus a Portainer-style
    // string. Both must reach compose.yaml as renderable specs.
    mockedGet.mockResolvedValueOnce({
      data: {
        version: '3',
        templates: [
          {
            type: 1,
            title: 'structured',
            image: 'example/structured:latest',
            ports: [{ external: '8443', internal: '443/udp' }],
          },
          {
            type: 1,
            title: 'stringform',
            image: 'example/stringform:latest',
            ports: ['8080:80/udp'],
          },
        ],
      },
    });

    const templates = await service.getTemplates();
    expect(templates.map(t => t.title)).toEqual(['structured', 'stringform']);
    expect(templates.find(t => t.title === 'structured')!.ports).toEqual(['8443:443/udp']);
    expect(templates.find(t => t.title === 'stringform')!.ports).toEqual(['8080:80/udp']);
  });

  it('drops a custom-registry port entry it cannot represent and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new TemplateService();
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    service.clearCache();
    mockedGet.mockResolvedValueOnce({
      data: {
        version: '3',
        templates: [{
          type: 1,
          title: 'mixed',
          image: 'example/mixed:latest',
          ports: [{ note: 'no port here' }, '8080:80'],
        }],
      },
    });

    const templates = await service.getTemplates();
    expect(templates[0].ports).toEqual(['8080:80']);
    expect(warn.mock.calls.some(c => c.join(' ').includes('templates.example'))).toBe(true);
    warn.mockRestore();
  });

  it('maps an LSIO payload served from a non-LSIO host', async () => {
    const service = new TemplateService();
    // A mirror or caching proxy in front of the LinuxServer.io API serves the
    // same body from a different hostname. Choosing the mapper by hostname sent
    // this body to the Portainer mapper, which found no templates and returned
    // an empty App Store with no error.
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://mirror.internal/catalogue.json',
    );
    service.clearCache();
    mockedGet.mockResolvedValueOnce({
      data: lsioPayload({
        wireguard: {
          name: 'wireguard',
          description: 'A lightweight VPN',
          config: { ports: [{ external: '51820', internal: '51820/udp' }] },
        },
      }),
    });

    const templates = await service.getTemplates();
    const wireguard = templates.find(t => t.title === 'wireguard');
    expect(wireguard).toBeDefined();
    expect(wireguard!.source).toBe('linuxserver');
    expect(wireguard!.ports).toEqual(['51820:51820/udp']);
  });

  it.each([
    ['a Portainer v1 top-level array', [{ type: 1, title: 'x', image: 'x:1' }]],
    ['an unrelated object', { hello: 'world' }],
    ['an empty body', {}],
    ['a string body', 'not a catalogue'],
    ['a null catalogue under the LinuxServer key', { data: { repositories: { linuxserver: null } } }],
    ['null', null],
  ])('errors instead of returning an empty catalogue for %s', async (_label, body) => {
    const service = new TemplateService();
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    service.clearCache();
    mockedGet.mockResolvedValueOnce({ data: body });

    await expect(service.getTemplates()).rejects.toThrow(/not in a format Sencho reads/);
  });

  it('names both supported shapes and the unsupported v1 format in that error', async () => {
    const service = new TemplateService();
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    service.clearCache();
    mockedGet.mockResolvedValueOnce({ data: { unexpected: true } });

    await expect(service.getTemplates()).rejects.toThrow(
      /data\.repositories\.linuxserver[\s\S]*templates array[\s\S]*v1/,
    );
  });

  it('accepts an empty Portainer catalogue without erroring', async () => {
    const service = new TemplateService();
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    service.clearCache();
    // A registry with nothing in it is a valid answer, not an unreadable one.
    mockedGet.mockResolvedValueOnce({ data: { version: '3', templates: [] } });

    await expect(service.getTemplates()).resolves.toEqual([]);
  });

  it('accepts an empty LSIO catalogue without erroring', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockResolvedValueOnce({ data: lsioPayload({}) });

    await expect(service.getTemplates()).resolves.toEqual([]);
  });

  it('caches per registry URL, so a changed URL is never served a stale catalogue', async () => {
    const service = new TemplateService();
    service.clearCache();

    mockedGet.mockResolvedValueOnce({ data: lsioPayload({ plex: { name: 'plex', description: 'p' } }) });
    const first = await service.getTemplates();
    expect(first.map(t => t.title)).toEqual(['plex']);

    // Same registry: served from cache, no second fetch.
    const cached = await service.getTemplates();
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(cached.map(t => t.title)).toEqual(['plex']);

    // Operator points at a different registry. A shared key would keep serving
    // the previous catalogue until its 24h TTL expired.
    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    mockedGet.mockResolvedValueOnce({
      data: { version: '3', templates: [{ type: 1, title: 'other', image: 'example/other:latest' }] },
    });
    const switched = await service.getTemplates();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(switched.map(t => t.title)).toEqual(['other']);

    // Switching back finds the original entry still cached, not refetched.
    DatabaseService.getInstance().updateGlobalSetting('template_registry_url', '');
    const back = await service.getTemplates();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(back.map(t => t.title)).toEqual(['plex']);
  });

  it('clearCache drops every registry, including one that is no longer configured', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockResolvedValueOnce({ data: lsioPayload({ plex: { name: 'plex', description: 'p' } }) });
    await service.getTemplates();

    DatabaseService.getInstance().updateGlobalSetting(
      'template_registry_url',
      'https://templates.example/catalogue.json',
    );
    service.clearCache();
    mockedGet.mockResolvedValueOnce({
      data: { version: '3', templates: [{ type: 1, title: 'other', image: 'example/other:latest' }] },
    });
    const afterClear = await service.getTemplates();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(afterClear.map(t => t.title)).toEqual(['other']);
  });

  it('maps LSIO :ro volume paths and skips optional volumes (fail2ban)', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockResolvedValueOnce({
      data: {
        data: {
          repositories: {
            linuxserver: {
              fail2ban: {
                name: 'fail2ban',
                description: 'Ban IPs',
                config: {
                  volumes: [
                    { path: '/config', host_path: '/path/to/fail2ban/config', optional: false },
                    { path: '/var/log:ro', host_path: '/var/log', optional: false },
                    {
                      path: '/remotelogs/nginx:ro',
                      host_path: '/path/to/nginx/log',
                      optional: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });

    const templates = await service.getTemplates();
    const fail2ban = templates.find(t => t.title === 'fail2ban')!;
    expect(fail2ban.volumes).toEqual([
      { container: '/config', bind: './config' },
      { container: '/var/log', bind: '/var/log', readonly: true },
    ]);

    const yaml = service.generateComposeFromTemplate(fail2ban, 'fail2ban');
    const parsed = YAML.parse(yaml) as { services: { fail2ban: { volumes: string[] } } };
    expect(parsed.services.fail2ban.volumes).toEqual([
      './config:/config',
      '/var/log:/var/log:ro',
    ]);
  });

  it('maps LSIO :ro volume with placeholder host_path (mame)', async () => {
    const service = new TemplateService();
    service.clearCache();
    mockedGet.mockResolvedValueOnce({
      data: {
        data: {
          repositories: {
            linuxserver: {
              mame: {
                name: 'mame',
                description: 'MAME',
                config: {
                  volumes: [
                    { path: '/config', host_path: '/path/to/config', optional: false },
                    { path: '/mame:ro', host_path: '/path/to/mame/assets', optional: false },
                  ],
                },
              },
            },
          },
        },
      },
    });

    const templates = await service.getTemplates();
    const mame = templates.find(t => t.title === 'mame');
    expect(mame!.volumes).toEqual([
      { container: '/config', bind: './config' },
      { container: '/mame', bind: './mame', readonly: true },
    ]);
  });
});
