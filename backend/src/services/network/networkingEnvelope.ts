import { NETWORKING_SCHEMA_VERSION, type NetworkingEnvelope } from './networkingTypes';

export function okEnvelope<T extends object>(
  runtimeAvailable: boolean,
  fields: T,
): NetworkingEnvelope & T {
  return {
    schemaVersion: NETWORKING_SCHEMA_VERSION,
    runtimeAvailable,
    generatedAt: new Date().toISOString(),
    ...fields,
  };
}

export function runtimeUnavailableEnvelope() {
  return {
    schemaVersion: NETWORKING_SCHEMA_VERSION,
    runtimeAvailable: false,
    error: 'Docker networking runtime is unavailable',
    code: 'runtime-unavailable' as const,
  };
}
