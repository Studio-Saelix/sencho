/**
 * Registry-fetch tests for TemplateService.getTemplates: the response-size
 * cap surfaces a clean error instead of letting an oversized body propagate,
 * and the fetch is issued with the size-limit axios options.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

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
});

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
    mockedGet.mockResolvedValueOnce({
      data: {
        data: {
          repositories: {
            linuxserver: {
              plex: {
                name: 'plex',
                description: 'Media server',
                stars: 100,
                arch: ['x86-64'],
                github: 'https://github.com/linuxserver/docker-plex',
                readme: 'https://docs.example/plex',
                config: {
                  ports: [{ external: 32400, internal: 32400, protocol: 'tcp' }],
                  volumes: [{ path: '/config' }],
                  environment: [{ name: 'PUID', desc: 'User ID', default: '1000' }],
                },
              },
            },
          },
        },
      },
    });

    const templates = await service.getTemplates();
    const plex = templates.find(t => t.title === 'plex');
    expect(plex).toBeDefined();
    expect(plex!.image).toBe('lscr.io/linuxserver/plex:latest');
    expect(plex!.source).toBe('linuxserver');
    expect(plex!.ports).toEqual(['32400:32400/tcp']);
    expect(plex!.volumes).toEqual([{ container: '/config', bind: './config' }]);
    expect(plex!.env).toEqual([{ name: 'PUID', label: 'User ID', default: '1000' }]);
    expect(plex!.categories).toEqual(['Media']);
  });
});
