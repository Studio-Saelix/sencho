import { createHash, randomInt, timingSafeEqual } from 'crypto';

// Sencho secret key prefix. Tokens issued from Settings → API are opaque
// (not JWTs): a base62 random body plus a base62 checksum so malformed or
// typoed keys are rejected before any SQLite lookup, and so secret scanners
// (GitHub, TruffleHog, GitGuardian) have a recognisable signature.
export const API_TOKEN_PREFIX = 'sen_sk_';

const RANDOM_LEN = 43;
const CHECKSUM_LEN = 6;

export const API_TOKEN_BODY_LEN = RANDOM_LEN + CHECKSUM_LEN;
export const API_TOKEN_TOTAL_LEN = API_TOKEN_PREFIX.length + API_TOKEN_BODY_LEN;
export const API_TOKEN_REGEX = /^sen_sk_[A-Za-z0-9]{49}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function base62Encode32(value: number): string {
  let n = value >>> 0;
  let out = '';
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return out;
}

function computeChecksum(random: string): string {
  const hash = createHash('sha256').update(random).digest();
  return base62Encode32(hash.readUInt32BE(0));
}

export function generateApiToken(): string {
  let random = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    random += ALPHABET[randomInt(0, 62)];
  }
  return API_TOKEN_PREFIX + random + computeChecksum(random);
}

export function looksLikeApiToken(token: string): boolean {
  return token.length === API_TOKEN_TOTAL_LEN && API_TOKEN_REGEX.test(token);
}

export function verifyApiTokenChecksum(token: string): boolean {
  if (!looksLikeApiToken(token)) return false;
  const random = token.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + RANDOM_LEN);
  const checksum = token.slice(API_TOKEN_PREFIX.length + RANDOM_LEN);
  const expected = computeChecksum(random);
  return timingSafeEqual(Buffer.from(checksum, 'utf8'), Buffer.from(expected, 'utf8'));
}
