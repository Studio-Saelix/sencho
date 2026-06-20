import { describe, it, expect } from 'vitest';
import { isLikelySecretKey } from '../helpers/secretClassification';

describe('isLikelySecretKey', () => {
  it('flags keys whose segments are known secret words', () => {
    for (const k of [
      'DB_PASSWORD', 'API_KEY', 'PRIVATE_KEY', 'CLIENT_SECRET', 'WEBHOOK_SECRET',
      'GITHUB_TOKEN', 'APP_PASS', 'JWT_SECRET', 'AUTH_TOKEN', 'REDIS_PASSWORD',
      'SECRET_KEY_BASE', 'MAIL_PASSPHRASE',
    ]) {
      expect(isLikelySecretKey(k), k).toBe(true);
    }
  });

  it('flags connection-string keys whose segments are innocuous', () => {
    for (const k of ['DATABASE_URL', 'REDIS_URL', 'MONGO_URI', 'MONGODB_URI', 'AMQP_URL', 'DSN']) {
      expect(isLikelySecretKey(k), k).toBe(true);
    }
  });

  it('does not flag innocuous keys that merely contain a secret word as a substring', () => {
    for (const k of [
      'KEYCLOAK_URL', 'APP_PORT', 'NODE_ENV', 'LOG_LEVEL', 'PUBLIC_URL',
      'COMPASS_HOST', 'BYPASS_CACHE', 'TZ', 'SERVER_NAME', 'AUTHORS_FILE',
    ]) {
      expect(isLikelySecretKey(k), k).toBe(false);
    }
  });

  it('is case-insensitive and trims, and rejects empty', () => {
    expect(isLikelySecretKey('  db_password ')).toBe(true);
    expect(isLikelySecretKey('Api_Key')).toBe(true);
    expect(isLikelySecretKey('')).toBe(false);
  });
});
