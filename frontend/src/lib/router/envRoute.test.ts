import { describe, it, expect } from 'vitest';
import {
  envFileBasename,
  envFileForRouteUrl,
  normalizeEnvFileQuery,
  resolveEnvFilePath,
} from './envRoute';

const envFiles = [
  '/home/user/compose/radarr/.env',
  '/home/user/compose/radarr/.env.prod',
];

describe('envRoute', () => {
  it('extracts basename from absolute paths', () => {
    expect(envFileBasename('/home/user/compose/radarr/.env.prod')).toBe('.env.prod');
    expect(envFileBasename('C:\\compose\\stack\\.env')).toBe('.env');
  });

  it('resolves basename and legacy absolute URL tokens to full paths', () => {
    expect(resolveEnvFilePath('.env.prod', envFiles)).toBe('/home/user/compose/radarr/.env.prod');
    expect(resolveEnvFilePath('/home/user/compose/radarr/.env.prod', envFiles)).toBe(
      '/home/user/compose/radarr/.env.prod',
    );
    expect(resolveEnvFilePath('.env.missing', envFiles)).toBeNull();
  });

  it('omits default env file from route URLs', () => {
    expect(envFileForRouteUrl('/home/user/compose/radarr/.env', envFiles, 'env')).toBeNull();
    expect(envFileForRouteUrl('/home/user/compose/radarr/.env.prod', envFiles, 'env')).toBe('.env.prod');
    expect(envFileForRouteUrl('/home/user/compose/radarr/.env.prod', envFiles, 'compose')).toBeNull();
  });

  it('normalizes legacy absolute env query values to basenames', () => {
    expect(normalizeEnvFileQuery('/home/user/compose/radarr/.env.prod')).toBe('.env.prod');
    expect(normalizeEnvFileQuery('.env.prod')).toBe('.env.prod');
    expect(normalizeEnvFileQuery('')).toBeNull();
  });
});
