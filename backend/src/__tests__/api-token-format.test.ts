import { describe, it, expect } from 'vitest';
import {
  API_TOKEN_PREFIX,
  API_TOKEN_TOTAL_LEN,
  API_TOKEN_REGEX,
  generateApiToken,
  looksLikeApiToken,
  verifyApiTokenChecksum,
} from '../utils/apiTokenFormat';

describe('apiTokenFormat.generateApiToken', () => {
  it('emits tokens with the sen_sk_ prefix', () => {
    const token = generateApiToken();
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
  });

  it('emits tokens of exactly 56 characters', () => {
    expect(generateApiToken().length).toBe(API_TOKEN_TOTAL_LEN);
    expect(API_TOKEN_TOTAL_LEN).toBe(56);
  });

  it('emits tokens that match the canonical regex', () => {
    expect(API_TOKEN_REGEX.test(generateApiToken())).toBe(true);
  });

  it('uses only base62 characters in the body (no dashes, no underscores)', () => {
    const body = generateApiToken().slice(API_TOKEN_PREFIX.length);
    expect(/^[A-Za-z0-9]+$/.test(body)).toBe(true);
    expect(body.includes('-')).toBe(false);
    expect(body.includes('_')).toBe(false);
  });
});

describe('apiTokenFormat.verifyApiTokenChecksum (accept path)', () => {
  it('accepts a freshly generated token', () => {
    expect(verifyApiTokenChecksum(generateApiToken())).toBe(true);
  });
});

describe('apiTokenFormat.looksLikeApiToken / verifyApiTokenChecksum (reject path)', () => {
  it('rejects an empty string', () => {
    expect(looksLikeApiToken('')).toBe(false);
    expect(verifyApiTokenChecksum('')).toBe(false);
  });

  it('rejects a JWT-shaped token', () => {
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzY29wZSI6ImFwaV90b2tlbiJ9.signature';
    expect(looksLikeApiToken(jwtLike)).toBe(false);
    expect(verifyApiTokenChecksum(jwtLike)).toBe(false);
  });

  it('rejects a token with the wrong prefix', () => {
    const token = generateApiToken();
    const swapped = 'sen_pk_' + token.slice(API_TOKEN_PREFIX.length);
    expect(looksLikeApiToken(swapped)).toBe(false);
    expect(verifyApiTokenChecksum(swapped)).toBe(false);
  });

  it('rejects a token with one character truncated', () => {
    const truncated = generateApiToken().slice(0, -1);
    expect(verifyApiTokenChecksum(truncated)).toBe(false);
  });

  it('rejects a token with one extra character', () => {
    const longer = generateApiToken() + 'A';
    expect(verifyApiTokenChecksum(longer)).toBe(false);
  });

  it('rejects a token containing a dash', () => {
    const token = generateApiToken();
    const mutated = token.slice(0, 20) + '-' + token.slice(21);
    expect(verifyApiTokenChecksum(mutated)).toBe(false);
  });

  it('rejects a token containing an underscore in the body', () => {
    const token = generateApiToken();
    const mutated = token.slice(0, 30) + '_' + token.slice(31);
    expect(verifyApiTokenChecksum(mutated)).toBe(false);
  });

  it('rejects a single-char mutation inside the random portion', () => {
    const token = generateApiToken();
    const mutateAt = API_TOKEN_PREFIX.length + 5;
    const original = token[mutateAt];
    const replacement = original === 'a' ? 'b' : 'a';
    const mutated = token.slice(0, mutateAt) + replacement + token.slice(mutateAt + 1);
    expect(mutated).not.toBe(token);
    expect(verifyApiTokenChecksum(mutated)).toBe(false);
  });

  it('rejects a single-char mutation inside the checksum portion', () => {
    const token = generateApiToken();
    const mutateAt = API_TOKEN_TOTAL_LEN - 3;
    const original = token[mutateAt];
    const replacement = original === 'a' ? 'b' : 'a';
    const mutated = token.slice(0, mutateAt) + replacement + token.slice(mutateAt + 1);
    expect(mutated).not.toBe(token);
    expect(verifyApiTokenChecksum(mutated)).toBe(false);
  });
});

describe('apiTokenFormat: bulk generator integrity', () => {
  it('produces 10000 tokens with no collisions and all valid checksums', () => {
    const seen = new Set<string>();
    const iterations = 10_000;
    for (let i = 0; i < iterations; i++) {
      const token = generateApiToken();
      expect(verifyApiTokenChecksum(token)).toBe(true);
      seen.add(token);
    }
    expect(seen.size).toBe(iterations);
  });
});
