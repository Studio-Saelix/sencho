import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  discoverRegistryReferences,
} from '../services/registryReferenceDiscovery';
import {
  mergeComposeEnvVars,
  resolveComposeEnvForDiscovery,
} from '../helpers/registryDeliveryComposeEnv';

describe('registryDeliveryComposeEnv', () => {
  const envKey = 'SENCHO_REGDELIVERY_TEST_REGISTRY';

  afterEach(() => {
    delete process.env[envKey];
  });

  it('resolves registry host from project .env variables', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-compose-env-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  app:\n    image: ${REGISTRY}/org/private:latest\n',
    );
    fs.writeFileSync(path.join(dir, '.env'), 'REGISTRY=ghcr.io\n');

    const env = resolveComposeEnvForDiscovery(dir);
    const result = discoverRegistryReferences(dir, env);
    expect(result.referencedHosts).toEqual(['ghcr.io']);
  });

  it('lets process environment override .env for compose variables', () => {
    const dir = path.join(process.env.TMPDIR || '/tmp', `sencho-compose-env-override-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      `services:\n  app:\n    image: \${${envKey}}/org/private:latest\n`,
    );
    fs.writeFileSync(path.join(dir, '.env'), `${envKey}=ghcr.io\n`);

    process.env[envKey] = 'quay.io';
    const env = resolveComposeEnvForDiscovery(dir);
    const result = discoverRegistryReferences(dir, env);
    expect(result.referencedHosts).toEqual(['quay.io']);
  });

  it('merges request env over .env before process overrides', () => {
    const merged = mergeComposeEnvVars({ FOO: 'from-dotenv' }, { FOO: 'from-request' });
    expect(merged.FOO).toBe('from-request');

    const previous = process.env.BAR;
    process.env.BAR = 'from-process';
    try {
      const withProcess = mergeComposeEnvVars({ BAR: 'from-dotenv' });
      expect(withProcess.BAR).toBe('from-process');
    } finally {
      if (previous === undefined) delete process.env.BAR;
      else process.env.BAR = previous;
    }
  });

  it('ignores unsafe request env keys', () => {
    const merged = mergeComposeEnvVars({}, { '__proto__': 'evil', REGISTRY: 'ghcr.io' });
    expect(merged.REGISTRY).toBe('ghcr.io');
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
  });
});
