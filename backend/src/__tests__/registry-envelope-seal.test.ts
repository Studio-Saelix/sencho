import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RegistryDeliveryAuthEntry } from '../helpers/registryDeliveryContext';
import {
  buildSealedAuthsAad,
  fingerprintOf,
  getOrCreateSealingKey,
  openAuths,
  parseSealingKeyBase64,
  resetSealingKeyCacheForTests,
  sealAuths,
  type SealedAuthsV1,
} from '../helpers/registryEnvelopeSeal';

const SAMPLE_AUTHS: RegistryDeliveryAuthEntry[] = [
  { host: 'ghcr.io', username: 'u', password: 's3cret-token-value', expiresAt: 1_700_000_000_000 },
];

describe('registryEnvelopeSeal', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-seal-'));
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

  it('getOrCreateSealingKey persists PKCS8 PEM at 0600 and returns a stable fingerprint', () => {
    const first = getOrCreateSealingKey();
    expect(first.publicKeyRaw).toHaveLength(32);
    expect(first.publicKeyBase64).toBe(first.publicKeyRaw.toString('base64'));
    expect(first.fingerprint).toBe(fingerprintOf(first.publicKeyRaw));

    const keyFile = path.join(dataDir, 'registry-seal.key');
    const fd = fs.openSync(keyFile, 'r');
    try {
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      expect(buf.toString('utf-8')).toContain('BEGIN PRIVATE KEY');
    } finally {
      fs.closeSync(fd);
    }

    resetSealingKeyCacheForTests();
    const second = getOrCreateSealingKey();
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('self-heals permissive key file permissions', () => {
    getOrCreateSealingKey();
    const keyFile = path.join(dataDir, 'registry-seal.key');
    fs.chmodSync(keyFile, 0o644);
    resetSealingKeyCacheForTests();
    getOrCreateSealingKey();
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('round-trips sealAuths and openAuths with matching AAD', () => {
    const key = getOrCreateSealingKey();
    const aad = buildSealedAuthsAad('src-1', 'jti-abc', 'prep-9');
    const sealed = sealAuths(key.publicKeyRaw, SAMPLE_AUTHS, aad);
    expect(sealed.v).toBe(1);
    expect(Buffer.from(sealed.epk, 'base64')).toHaveLength(32);
    expect(Buffer.from(sealed.n, 'base64')).toHaveLength(12);
    expect(JSON.stringify(sealed)).not.toContain('"password"');
    expect(JSON.stringify(sealed)).not.toContain(SAMPLE_AUTHS[0]!.password);
    expect(openAuths(sealed, aad)).toEqual(SAMPLE_AUTHS);
  });

  it('rejects decrypt with the wrong recipient key', () => {
    const recipient = getOrCreateSealingKey();
    const aad = buildSealedAuthsAad('src', 'jti', undefined);
    const sealed = sealAuths(recipient.publicKeyRaw, SAMPLE_AUTHS, aad);

    // Replace the on-disk key with a different keypair.
    resetSealingKeyCacheForTests();
    fs.rmSync(path.join(dataDir, 'registry-seal.key'));
    getOrCreateSealingKey();

    expect(() => openAuths(sealed, aad)).toThrow('Registry delivery envelope failed to decrypt');
  });

  it('rejects decrypt when AAD mismatches', () => {
    const key = getOrCreateSealingKey();
    const sealed = sealAuths(
      key.publicKeyRaw,
      SAMPLE_AUTHS,
      buildSealedAuthsAad('src', 'jti', 'prep'),
    );
    expect(() => openAuths(sealed, buildSealedAuthsAad('src', 'jti', 'other'))).toThrow(
      'Registry delivery envelope failed to decrypt',
    );
  });

  it('rejects tampered ciphertext', () => {
    const key = getOrCreateSealingKey();
    const aad = buildSealedAuthsAad('src', 'jti', undefined);
    const sealed = sealAuths(key.publicKeyRaw, SAMPLE_AUTHS, aad);
    const ct = Buffer.from(sealed.ct, 'base64');
    ct[0] ^= 0xff;
    const tampered: SealedAuthsV1 = { ...sealed, ct: ct.toString('base64') };
    expect(() => openAuths(tampered, aad)).toThrow('Registry delivery envelope failed to decrypt');
  });

  it('rejects truncated ciphertext (missing GCM tag)', () => {
    const key = getOrCreateSealingKey();
    const aad = buildSealedAuthsAad('src', 'jti', undefined);
    const sealed = sealAuths(key.publicKeyRaw, SAMPLE_AUTHS, aad);
    expect(() => openAuths({ ...sealed, ct: Buffer.alloc(8).toString('base64') }, aad)).toThrow(
      'Registry delivery envelope failed to decrypt',
    );
  });

  it('rejects unknown seal version', () => {
    const key = getOrCreateSealingKey();
    const aad = buildSealedAuthsAad('src', 'jti', undefined);
    const sealed = sealAuths(key.publicKeyRaw, SAMPLE_AUTHS, aad);
    expect(() => openAuths({ ...sealed, v: 2 }, aad)).toThrow(
      'Registry delivery envelope failed to decrypt',
    );
  });

  it('rejects all-zero recipient public key at seal time', () => {
    expect(() => sealAuths(Buffer.alloc(32, 0), SAMPLE_AUTHS, 'aad')).toThrow(
      'X25519 public key rejected',
    );
  });

  it('parseSealingKeyBase64 accepts a valid 32-byte key and rejects malformed input', () => {
    const key = getOrCreateSealingKey();
    expect(parseSealingKeyBase64(undefined)).toBeNull();
    expect(parseSealingKeyBase64(key.publicKeyBase64)?.equals(key.publicKeyRaw)).toBe(true);
    expect(() => parseSealingKeyBase64('not-base64!!!')).toThrow(
      'Registry delivery discovery response failed validation',
    );
    expect(() => parseSealingKeyBase64(Buffer.alloc(16).toString('base64'))).toThrow(
      'Registry delivery discovery response failed validation',
    );
    expect(() => parseSealingKeyBase64(Buffer.alloc(32, 0).toString('base64'))).toThrow(
      'Registry delivery discovery response failed validation',
    );
  });

  it('rejects a low-order shared secret when ECDH yields all zeros', () => {
    // Craft a seal path that would produce a zero IKM by stubbing diffieHellman.
    const key = getOrCreateSealingKey();
    const original = crypto.diffieHellman;
    try {
      (crypto as { diffieHellman: typeof crypto.diffieHellman }).diffieHellman = () => Buffer.alloc(32, 0);
      expect(() => sealAuths(key.publicKeyRaw, SAMPLE_AUTHS, 'aad')).toThrow(
        'X25519 shared secret rejected',
      );
    } finally {
      (crypto as { diffieHellman: typeof crypto.diffieHellman }).diffieHellman = original;
    }
  });

  it('openAuths fails closed without creating a key when the key file is missing', () => {
    const recipient = crypto.generateKeyPairSync('x25519');
    const recipientRaw = Buffer.from(
      (recipient.publicKey.export({ format: 'jwk' }) as { x?: string }).x!,
      'base64url',
    );
    const sealed = sealAuths(recipientRaw, SAMPLE_AUTHS, 'aad');
    const keyFile = path.join(dataDir, 'registry-seal.key');
    expect(() => fs.statSync(keyFile)).toThrow(/ENOENT/);
    expect(() => openAuths(sealed, 'aad')).toThrow('Registry delivery envelope failed to decrypt');
    expect(() => fs.statSync(keyFile)).toThrow(/ENOENT/);
  });
});
