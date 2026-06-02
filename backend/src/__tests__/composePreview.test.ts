/**
 * Unit tests for parseComposePreview: the pure compose-to-preview parser behind
 * the guided import scan. Covers port/volume/env normalization, the relative-
 * volume warning (1:1 path rule), and the non-throwing error paths.
 */
import { describe, it, expect } from 'vitest';
import { parseComposePreview } from '../helpers/composePreview';

describe('parseComposePreview', () => {
  it('extracts services, short-syntax ports, volumes, and env_file', () => {
    const yaml = `
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
      - "53:53/udp"
    volumes:
      - ./data:/usr/share/nginx/html
    env_file: web.env
`;
    const result = parseComposePreview(yaml);
    expect(result.parseError).toBeUndefined();
    expect(result.services).toHaveLength(1);
    const web = result.services[0];
    expect(web.name).toBe('web');
    expect(web.image).toBe('nginx:1.27');
    expect(web.ports).toEqual(['8080->80', '53->53']);
    expect(web.volumes).toEqual(['./data:/usr/share/nginx/html']);
    expect(web.envFiles).toEqual(['web.env']);
    // Relative bind source triggers the 1:1 path-rule warning.
    expect(result.warnings.some((w) => w.includes('1:1 path rule'))).toBe(true);
  });

  it('normalizes long-syntax ports and ip-prefixed short ports', () => {
    const yaml = `
services:
  api:
    ports:
      - target: 3001
        published: 2283
      - "127.0.0.1:9000:9000"
      - "5000"
`;
    const result = parseComposePreview(yaml);
    expect(result.services[0].ports).toEqual(['2283->3001', '9000->9000', '5000']);
  });

  it('handles env_file as an array of strings and {path} objects', () => {
    const yaml = `
services:
  app:
    env_file:
      - common.env
      - path: secrets.env
`;
    const result = parseComposePreview(yaml);
    expect(result.services[0].envFiles).toEqual(['common.env', 'secrets.env']);
  });

  it('does not warn for named or absolute volumes', () => {
    const yaml = `
services:
  db:
    volumes:
      - pgdata:/var/lib/postgresql/data
      - /opt/host/conf:/etc/conf
volumes:
  pgdata:
`;
    const result = parseComposePreview(yaml);
    expect(result.services[0].volumes).toEqual(['pgdata:/var/lib/postgresql/data', '/opt/host/conf:/etc/conf']);
    expect(result.warnings).toHaveLength(0);
  });

  it('reports a parseError for invalid YAML without throwing', () => {
    const result = parseComposePreview('services: [unclosed');
    expect(result.parseError).toBeDefined();
    expect(result.services).toHaveLength(0);
  });

  it('reports a parseError when there are no services', () => {
    const result = parseComposePreview("name: just-a-file\nversion: '3'");
    expect(result.parseError).toBe('No services found in this file.');
  });
});
