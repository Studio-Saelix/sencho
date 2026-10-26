import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { detectSopsContent } from '../services/gitops/sops/detect';
import { decryptSopsAgeDocument, SopsDecryptError } from '../services/gitops/sops/decode';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'sops');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

/**
 * These fixtures were produced by the real sops CLI (v3.13.3) with the
 * test-only age identity in fixtures/sops/test-only-identity.txt. They are
 * encrypted values authenticated with their key path, so they fail to decrypt
 * if that additional authenticated data is missing from the decoder.
 */
const identity = readFixture('test-only-identity.txt').trim();

describe('real sops fixtures (v3.13.3)', () => {
  it('decrypts a YAML document with nested maps, an array of maps, and a literal block', async () => {
    const fixture = readFixture('nested.enc.yaml');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity);
    expect(parseYaml(decrypted)).toEqual({
      api_token: 'tok_top_level',
      database: {
        host: 'db.internal',
        password: 'correct-horse-battery-staple',
      },
      tls: {
        cert_pem: '-----BEGIN CERTIFICATE-----\nMIIBfakecertificate\n-----END CERTIFICATE-----\n',
      },
      servers: [
        { name: 'one', token: 'tok-one' },
        { name: 'two', token: 'tok-two' },
      ],
    });
    expect(decrypted).not.toContain('ENC[AES256_GCM');
    expect(decrypted).not.toContain('sops:');
  });

  it('keeps JSON output in JSON instead of re-emitting YAML', async () => {
    const fixture = readFixture('secrets.enc.json');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity);
    expect(decrypted.trimStart().startsWith('{')).toBe(true);
    expect(JSON.parse(decrypted)).toEqual({
      api_key: 'json-key',
      database: { password: 'json-secret' },
    });
    expect(decrypted).toContain('"password": "json-secret"');
  });

  it('decrypts a dotenv store without its flattened sops_* metadata', async () => {
    const fixture = readFixture('secrets.enc.env');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity);
    expect(decrypted).toBe('DB_PASSWORD=hunter2\nAPI_TOKEN=tok-dotenv\n');
  });

  it('decrypts an INI store with a default-section key and a named section', async () => {
    const fixture = readFixture('settings.enc.ini');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity);
    expect(decrypted).toBe(
      'default_key=default-secret\n[database]\npassword=ini-secret\nhost=db.internal\n',
    );
  });

  it('escapes a newline value onto one line in a dotenv store', async () => {
    const fixture = readFixture('newline.enc.env');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity, 'compose-env');
    expect(decrypted).toBe('NL="line1\\nline2"\nPLAIN=x\n');
  });

  it('quotes dotenv values that Compose would otherwise rewrite', async () => {
    const fixture = readFixture('metachar.enc.env');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity, 'compose-env');
    expect(decrypted).toBe(
      'DOLLAR="a$$B"\nQUOTE="say \\"hi\\""\nSPACE=" padded"\n'
      + 'HASH="a #b"\nTAB="a\\tb"\nCR="a\\rb"\nPLAIN=x\n',
    );
  });

  it('keeps sops-faithful dotenv output when the file is consumed verbatim', async () => {
    const newline = readFixture('newline.enc.env');
    expect(await decryptSopsAgeDocument(newline, identity)).toBe(
      'NL=line1\\nline2\nPLAIN=x\n',
    );
    const metachar = readFixture('metachar.enc.env');
    expect(await decryptSopsAgeDocument(metachar, identity)).toBe(
      'DOLLAR=a$B\nQUOTE=say "hi"\nSPACE= padded\nHASH=a #b\nTAB=a\tb\nCR=a\rb\nPLAIN=x\n',
    );
  });

  it('keeps a nested map key named sops', async () => {
    const fixture = readFixture('nested-sops.enc.yaml');
    expect(detectSopsContent(fixture).kind).toBe('sops-age');

    const decrypted = await decryptSopsAgeDocument(fixture, identity);
    expect(parseYaml(decrypted)).toEqual({
      app: { sops: 'nested-secret', child: 'c' },
      top: 't',
    });
  });

  it('rejects a value whose key path was renamed', async () => {
    const fixture = readFixture('nested.enc.yaml');
    const renamed = fixture.replace(/^api_token:/m, 'renamed_token:');
    expect(renamed).not.toBe(fixture);
    const rejection = await decryptSopsAgeDocument(renamed, identity).catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(SopsDecryptError);
    expect(rejection).toMatchObject({ code: 'decrypt_failed' });
  });
});
