import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSealedAuthsAad,
  getExistingSealingKey,
  getOrCreateSealingKey,
  openAuths,
  resetSealingKeyCacheForTests,
  sealAuths,
} from '../helpers/registryEnvelopeSeal';
import {
  buildSealedSecretAad,
  openSecret,
  sealSecret,
  secretFingerprint,
  type SealedSecretBinding,
} from '../helpers/sealedSecretSeal';

const SECRET = 'eyJhIjoic2VudGluZWwtdG9rZW4tdmFsdWUifQ';

function binding(overrides: Partial<SealedSecretBinding> = {}): SealedSecretBinding {
  return {
    purpose: 'edge-tunnel-run-token',
    deliverySourceId: 'source-1',
    slot: '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4',
    generation: 3,
    operationId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    ...overrides,
  };
}

describe('sealed secret envelope', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sealed-secret-seal-'));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    resetSealingKeyCacheForTests();
  });

  afterEach(() => {
    resetSealingKeyCacheForTests();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a secret bound to its purpose, node, slot, generation and operation', () => {
    const key = getOrCreateSealingKey();
    const sealed = sealSecret(key.publicKeyRaw, binding(), SECRET);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(openSecret(sealed, binding())).toBe(SECRET);
  });

  it.each([
    ['purpose', { purpose: 'other-purpose' }],
    ['delivery source', { deliverySourceId: 'source-2' }],
    ['slot', { slot: '11111111-1111-4111-8111-111111111111' }],
    ['generation', { generation: 4 }],
    ['operation', { operationId: '22222222-2222-4222-8222-222222222222' }],
  ] as const)('refuses to open when the %s differs', (_field, change) => {
    const key = getOrCreateSealingKey();
    const sealed = sealSecret(key.publicKeyRaw, binding(), SECRET);
    expect(() => openSecret(sealed, binding(change))).toThrow('Sealed secret failed to open');
  });

  it('names every bound field in the AAD', () => {
    expect(buildSealedSecretAad(binding())).toBe(
      'sencho-sealed-secret-v1|edge-tunnel-run-token|source-1|0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4|3|9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    );
  });

  it('does not open a registry envelope as a sealed secret, nor the reverse', () => {
    const key = getOrCreateSealingKey();
    const registryAad = buildSealedAuthsAad('source-1', 'att-1', 'prep-1');
    const registry = sealAuths(key.publicKeyRaw, [{ host: 'ghcr.io', username: 'u', password: 'p' }], buildSealedSecretAad(binding()));
    expect(() => openSecret(registry, binding())).toThrow('Sealed secret failed to open');

    const sealed = sealSecret(key.publicKeyRaw, binding(), SECRET);
    expect(() => openAuths(sealed, buildSealedSecretAad(binding()))).toThrow('Registry delivery envelope failed to decrypt');
    expect(() => openAuths(sealed, registryAad)).toThrow('Registry delivery envelope failed to decrypt');
  });

  it('refuses a payload whose fields do not match the request even under a matching AAD', async () => {
    const key = getOrCreateSealingKey();
    const { sealEnvelope } = await import('../helpers/registryEnvelopeSeal');
    const b = binding();
    const forged = sealEnvelope(
      key.publicKeyRaw,
      Buffer.from(JSON.stringify({ v: 1, purpose: b.purpose, slot: b.slot, generation: b.generation + 1, secret: SECRET }), 'utf8'),
      buildSealedSecretAad(b),
      { salt: 'sencho-sealed-secret-v1', info: `sencho-sealed-secret:${b.purpose}` },
    );
    expect(() => openSecret(forged, b)).toThrow('Sealed secret failed to open');
  });

  it('rejects malformed envelopes with the same generic message', () => {
    getOrCreateSealingKey();
    for (const sealed of [null, {}, { v: 1, epk: 'x', n: 'y', ct: 'z' }, 'string']) {
      expect(() => openSecret(sealed, binding())).toThrow('Sealed secret failed to open');
    }
  });

  it('keys the stored fingerprint to this node, so another key gives another value', () => {
    getOrCreateSealingKey();
    const first = secretFingerprint('edge-tunnel-run-token', binding().slot, SECRET);
    expect(first).not.toContain(SECRET.slice(0, 8));
    expect(secretFingerprint('edge-tunnel-run-token', binding().slot, SECRET)).toBe(first);
    expect(secretFingerprint('edge-tunnel-run-token', binding().slot, `${SECRET}x`)).not.toBe(first);

    fs.rmSync(path.join(dataDir, fs.readdirSync(dataDir)[0]), { force: true });
    resetSealingKeyCacheForTests();
    getOrCreateSealingKey();
    expect(secretFingerprint('edge-tunnel-run-token', binding().slot, SECRET)).not.toBe(first);
  });

  it('reads an existing key without creating one', () => {
    expect(getExistingSealingKey()).toBeNull();
    expect(fs.readdirSync(dataDir)).toHaveLength(0);
    const created = getOrCreateSealingKey();
    resetSealingKeyCacheForTests();
    expect(getExistingSealingKey()?.fingerprint).toBe(created.fingerprint);
  });
});
