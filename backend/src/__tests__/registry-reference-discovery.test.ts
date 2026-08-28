import { describe, it, expect } from 'vitest';
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

  it('rejects oversized Dockerfiles', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-refdisc-big-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'x'.repeat(1_048_577));

    expect(() => discoverRegistryReferences(dir)).toThrow(/size limit/i);
  });
});
