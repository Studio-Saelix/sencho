/**
 * Unit tests for TemplateService: compose YAML generation,
 * env string generation, conditional env_file, and cache clearing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import YAML from 'yaml';
import { TemplateService } from '../services/TemplateService';

// Parse the generated compose and return the single service block keyed by
// `name`. Asserting on the parsed structure (rather than exact text lines)
// keeps the tests stable across the YAML emitter's quoting choices.
function serviceOf(yaml: string, name = 'app'): Record<string, unknown> {
  const parsed = YAML.parse(yaml) as { services?: Record<string, Record<string, unknown>> };
  expect(parsed.services).toBeDefined();
  return parsed.services![name];
}

describe('TemplateService', () => {
  let service: TemplateService;

  beforeEach(() => {
    service = new TemplateService();
  });

  // ─── generateComposeFromTemplate ─────────────────────────────────────

  describe('generateComposeFromTemplate', () => {
    it('generates minimal compose with just image and restart policy', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'nginx', description: 'Web server', image: 'nginx:latest',
      }, 'app'));
      expect(svc.image).toBe('nginx:latest');
      expect(svc.restart).toBe('unless-stopped');
      expect(svc.ports).toBeUndefined();
      expect(svc.volumes).toBeUndefined();
      expect(svc.env_file).toBeUndefined();
    });

    it('includes ports when template has port mappings', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'nginx', description: 'Web server', image: 'nginx:latest',
        ports: ['80:80', '443:443/tcp'],
      }, 'app'));
      expect(svc.ports).toEqual(['80:80', '443:443/tcp']);
    });

    it('handles string volumes with host:container format', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: ['/host/data:/container/data'],
      }, 'app'));
      expect(svc.volumes).toEqual(['/host/data:/container/data']);
    });

    it('handles string volumes with single path (named volume)', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: ['/data'],
      }, 'app'));
      expect(svc.volumes).toEqual(['/data']);
    });

    it('handles object volumes with container and bind', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: [{ container: '/config', bind: './config' }],
      }, 'app'));
      expect(svc.volumes).toEqual(['./config:/config']);
    });

    it('generates bind path from container folder when bind is not specified', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: [{ container: '/app/data' }],
      }, 'app'));
      expect(svc.volumes).toEqual(['./data:/app/data']);
    });

    it('adds :ro suffix for readonly volumes', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: [{ container: '/config', bind: './config', readonly: true }],
      }, 'app'));
      expect(svc.volumes).toEqual(['./config:/config:ro']);
    });

    it('includes env_file only when env vars are present', () => {
      const withEnv = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        env: [{ name: 'TZ', default: 'UTC' }],
      }, 'app'));
      const withoutEnv = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest', env: [],
      }, 'app'));
      expect(withEnv.env_file).toEqual(['.env']);
      expect(withoutEnv.env_file).toBeUndefined();
    });

    it('does not include env_file when env is undefined', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
      }, 'app'));
      expect(svc.env_file).toBeUndefined();
    });

    it('handles string volumes with options (e.g., host:container:ro)', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: ['/host/config:/config:ro'],
      }, 'app'));
      expect(svc.volumes).toEqual(['/host/config:/config:ro']);
    });

    it('skips object volumes without container path', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: [{ container: '' }],
      }, 'app'));
      // Empty container is skipped, leaving no volume entries; the key is
      // omitted entirely rather than emitted as an empty list.
      expect(svc.volumes).toBeUndefined();
    });

    it('uses the supplied service name as the compose service key', () => {
      const yaml = service.generateComposeFromTemplate({
        title: 'Plex', description: 'Media server', image: 'plex:latest',
      }, 'plex');
      const parsed = YAML.parse(yaml) as { services: Record<string, unknown> };
      expect(Object.keys(parsed.services)).toEqual(['plex']);
    });

    it('escapes values that would break hand-built YAML (round-trips intact)', () => {
      // Registry values containing YAML structural characters (newlines,
      // indentation, anchors, flow collectors, colon-space) must survive a
      // serialize/parse round-trip rather than injecting sibling keys.
      const hostileImage = 'evil:latest\n    privileged: true';
      const yaml = service.generateComposeFromTemplate({
        title: 'x', description: 'Test', image: hostileImage,
        ports: ['*anchor', '8080:80\n    cap_add: [ALL]'],
        volumes: ['/h: weird:/c # not-a-comment'],
      }, 'app');
      const svc = serviceOf(yaml);
      expect(svc.image).toBe(hostileImage);
      expect(svc.ports).toEqual(['*anchor', '8080:80\n    cap_add: [ALL]']);
      expect(svc.volumes).toEqual(['/h: weird:/c # not-a-comment']);
      // None of the injected sibling keys may escape into the service block.
      expect(svc).not.toHaveProperty('privileged');
      expect(svc).not.toHaveProperty('cap_add');
    });

    it('keeps later valid volumes when an earlier entry is skipped', () => {
      const svc = serviceOf(service.generateComposeFromTemplate({
        title: 'app', description: 'Test', image: 'test:latest',
        volumes: [{ container: '' }, { container: '/config', bind: './config' }],
      }, 'app'));
      expect(svc.volumes).toEqual(['./config:/config']);
    });
  });

  // ─── generateEnvString ───────────────────────────────────────────────

  describe('generateEnvString', () => {
    it('converts key-value pairs to env file format', () => {
      const result = service.generateEnvString({
        TZ: 'America/New_York',
        PUID: '1000',
        PGID: '1000',
      });

      expect(result).toBe('TZ=America/New_York\nPUID=1000\nPGID=1000');
    });

    it('returns empty string for empty object', () => {
      expect(service.generateEnvString({})).toBe('');
    });

    it('handles values with special characters', () => {
      const result = service.generateEnvString({
        PASSWORD: 'p@ss=word!',
        URL: 'http://localhost:1852',
      });

      expect(result).toContain('PASSWORD=p@ss=word!');
      expect(result).toContain('URL=http://localhost:1852');
    });
  });

  // ─── clearCache ──────────────────────────────────────────────────────

  describe('clearCache', () => {
    it('calls CacheService.invalidate with the correct key', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // clearCache should not throw even when cache is empty
      expect(() => service.clearCache()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith('[Templates] Cache invalidated');

      consoleSpy.mockRestore();
    });
  });
});
