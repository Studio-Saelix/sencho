import fs from 'fs';
import path from 'path';

import { loadDotEnv } from '../services/ImageUpdateService';

/**
 * Merge compose variable maps with Docker Compose precedence:
 * request overrides, then .env, then process.env overrides both.
 */
export function mergeComposeEnvVars(
  dotEnv: Record<string, string> = {},
  requestEnv?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...dotEnv };
  if (requestEnv) {
    for (const [key, value] of Object.entries(requestEnv)) {
      if (typeof value === 'string') merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Best-effort read of a stack project `.env` file from disk. */
export function loadDotEnvFromProjectDir(projectDir: string): Record<string, string> {
  const baseResolved = path.resolve(projectDir);
  const envPath = path.resolve(baseResolved, '.env');
  if (!envPath.startsWith(baseResolved + path.sep)) {
    return {};
  }
  try {
    if (!fs.existsSync(envPath)) return {};
    return loadDotEnv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

/** Resolve compose env for registry discovery on a project directory. */
export function resolveComposeEnvForDiscovery(
  projectDir: string,
  requestEnv?: Record<string, string>,
): Record<string, string> {
  return mergeComposeEnvVars(loadDotEnvFromProjectDir(projectDir), requestEnv);
}

/** Resolve compose env for inline compose content discovery. */
export function resolveComposeEnvForContent(
  requestEnv?: Record<string, string>,
): Record<string, string> {
  return mergeComposeEnvVars({}, requestEnv);
}
