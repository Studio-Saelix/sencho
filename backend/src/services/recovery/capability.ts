import { DatabaseService } from '../DatabaseService';
import type { NodeProxyJsonRead } from '../../helpers/nodeProxyJson';
import {
  RECOVERY_CONTRACT_VERSION,
  VOLUME_PROTECTION_CAPABILITY,
  VOLUME_PROTECTION_CAPABILITY_VERSION,
} from './types';
import type {
  BackupEngine,
  RecoveryNodeDescriptor,
  VolumeProtectionStatus,
} from './types';

/**
 * Volume-protection capability, version 1.
 *
 * A node reports its own status in its recovery descriptor; the hub reads it
 * and resolves the skew. `available` needs a registered engine, which no build
 * has yet, so every node reports `unavailable` and nothing claims protection.
 * `update_required` is only a real contract mismatch (a node without the
 * descriptor route, or a different contract version), never "this build has no
 * engine".
 */

const registeredEngines: BackupEngine[] = [];
let localHealthProvider: (() => LocalVolumeProtectionHealth) | null = null;

/**
 * Whether this node can protect volumes right now, as the engine's cached health
 * snapshot reports it. Never awaited by a read path: the provider answers from
 * its cache and may schedule a background refresh.
 */
export type LocalVolumeProtectionHealth =
  | { state: 'available' }
  | {
      state: 'unavailable';
      reason:
        | 'engine_starting'
        | 'helper_unavailable'
        | 'repository_not_initialized'
        | 'repository_unavailable'
        | 'repository_key_unavailable';
    };

/** Called at startup by the change that ships an engine (which also adds the capability key). */
export function registerBackupEngine(
  engine: BackupEngine,
  health?: () => LocalVolumeProtectionHealth,
): void {
  if (health) localHealthProvider = health;
  if (registeredEngines.some((e) => e.engineId === engine.engineId)) return;
  registeredEngines.push(engine);
}

export function getRegisteredEngines(): readonly BackupEngine[] {
  return registeredEngines;
}

/** Test seam: forget registered engines and their health provider. */
export function resetBackupEnginesForTests(): void {
  registeredEngines.length = 0;
  localHealthProvider = null;
}

const KEY = { capability: VOLUME_PROTECTION_CAPABILITY, version: VOLUME_PROTECTION_CAPABILITY_VERSION } as const;

export function getLocalVolumeProtectionStatus(): VolumeProtectionStatus {
  const schema = DatabaseService.getInstance().getRecoverySchemaOutcome();
  if (schema.kind === 'newer') return { ...KEY, state: 'unavailable', reason: 'schema_newer_than_build' };
  if (schema.kind !== 'current') return { ...KEY, state: 'unavailable', reason: 'recovery_store_unavailable' };
  if (registeredEngines.length === 0) return { ...KEY, state: 'unavailable', reason: 'engine_not_installed' };
  // The engine is registered, so this build can protect volumes. Whether it can
  // do so right now is the cached health snapshot: the helper digest is pinned
  // and present, the repository is provisioned and opens with the stored key,
  // and boot finished. A read never waits on a container.
  const health = localHealthProvider?.();
  if (health && health.state === 'unavailable') {
    return { ...KEY, state: 'unavailable', reason: health.reason };
  }
  return { ...KEY, state: 'available', reason: 'engine_registered' };
}

export function buildLocalRecoveryNodeDescriptor(): RecoveryNodeDescriptor {
  return { contractVersion: RECOVERY_CONTRACT_VERSION, volumeProtection: getLocalVolumeProtectionStatus() };
}

const NODE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'engine_not_installed',
  'schema_newer_than_build',
  'recovery_store_unavailable',
  'engine_starting',
  'helper_unavailable',
  'repository_not_initialized',
  'repository_unavailable',
  'repository_key_unavailable',
]);

/**
 * The state and reason a node may report about itself. `update_required` and
 * `unknown` are the hub's conclusions, so a node claiming them (or pairing a
 * state with a reason that contradicts it) is not a valid descriptor.
 */
function nodeReportedStatus(version: number, state: unknown, reason: unknown): VolumeProtectionStatus | null {
  if (state === 'available' && reason === 'engine_registered') {
    return { capability: VOLUME_PROTECTION_CAPABILITY, version, state, reason };
  }
  if (state === 'unavailable' && typeof reason === 'string' && NODE_UNAVAILABLE_REASONS.has(reason)) {
    return {
      capability: VOLUME_PROTECTION_CAPABILITY,
      version,
      state,
      reason: reason as Extract<VolumeProtectionStatus, { state: 'unavailable' }>['reason'],
    };
  }
  return null;
}

/** Parse an untrusted descriptor from another node; null when it is not one. */
export function parseRecoveryNodeDescriptor(data: unknown): RecoveryNodeDescriptor | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { contractVersion, volumeProtection } = data as Record<string, unknown>;
  if (typeof contractVersion !== 'number' || !Number.isInteger(contractVersion) || contractVersion < 1) return null;
  if (!volumeProtection || typeof volumeProtection !== 'object') return null;
  const vp = volumeProtection as Record<string, unknown>;
  if (vp.capability !== VOLUME_PROTECTION_CAPABILITY) return null;
  if (typeof vp.version !== 'number' || !Number.isInteger(vp.version)) return null;
  const reported = nodeReportedStatus(vp.version, vp.state, vp.reason);
  return reported ? { contractVersion, volumeProtection: reported } : null;
}

/**
 * The hub's view of a remote node's volume protection, from its descriptor
 * read. An old node answers 404 for the descriptor route: update required. A
 * node that cannot be reached is unknown; one that answers with a refusal or an
 * error is unknown too, but says so, so a revoked token does not read as a
 * network fault.
 */
export function resolveRemoteVolumeProtection(read: NodeProxyJsonRead): VolumeProtectionStatus {
  switch (read.kind) {
    case 'route_missing':
      return { ...KEY, state: 'update_required', reason: 'node_contract_older' };
    case 'no_target':
    case 'transport':
      return { ...KEY, state: 'unknown', reason: 'node_unreachable' };
    case 'http':
      return read.status === 401 || read.status === 403
        ? { ...KEY, state: 'unknown', reason: 'node_refused' }
        : { ...KEY, state: 'unknown', reason: 'node_error' };
    case 'ok':
      break;
  }
  const descriptor = parseRecoveryNodeDescriptor(read.data);
  if (!descriptor) return { ...KEY, state: 'unknown', reason: 'descriptor_invalid' };
  if (descriptor.contractVersion < RECOVERY_CONTRACT_VERSION) return { ...KEY, state: 'update_required', reason: 'node_contract_older' };
  if (descriptor.contractVersion > RECOVERY_CONTRACT_VERSION) return { ...KEY, state: 'update_required', reason: 'hub_contract_older' };
  const vp = descriptor.volumeProtection;
  if (vp.version < VOLUME_PROTECTION_CAPABILITY_VERSION) return { ...KEY, state: 'update_required', reason: 'node_contract_older' };
  if (vp.version > VOLUME_PROTECTION_CAPABILITY_VERSION) return { ...KEY, state: 'update_required', reason: 'hub_contract_older' };
  return vp;
}
