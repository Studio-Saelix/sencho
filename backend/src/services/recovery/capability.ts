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
  VolumeProtectionReason,
  VolumeProtectionState,
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

/** Called by the slice that ships an engine, at startup. */
export function registerBackupEngine(engine: BackupEngine): void {
  if (registeredEngines.some((e) => e.engineId === engine.engineId)) return;
  registeredEngines.push(engine);
}

export function getRegisteredEngines(): readonly BackupEngine[] {
  return registeredEngines;
}

/** Test seam: forget registered engines. */
export function resetBackupEnginesForTests(): void {
  registeredEngines.length = 0;
}

function status(state: VolumeProtectionState, reason: VolumeProtectionReason): VolumeProtectionStatus {
  return { capability: VOLUME_PROTECTION_CAPABILITY, version: VOLUME_PROTECTION_CAPABILITY_VERSION, state, reason };
}

export function getLocalVolumeProtectionStatus(): VolumeProtectionStatus {
  const schema = DatabaseService.getInstance().getRecoverySchemaOutcome();
  if (schema.kind === 'newer') return status('unavailable', 'schema_newer_than_build');
  if (schema.kind !== 'current') return status('unavailable', 'recovery_store_unavailable');
  if (registeredEngines.length === 0) return status('unavailable', 'engine_not_installed');
  return status('available', 'engine_registered');
}

export function buildLocalRecoveryNodeDescriptor(): RecoveryNodeDescriptor {
  return { contractVersion: RECOVERY_CONTRACT_VERSION, volumeProtection: getLocalVolumeProtectionStatus() };
}

const STATES: ReadonlySet<string> = new Set<VolumeProtectionState>(['available', 'unavailable', 'update_required', 'unknown']);
const REASONS: ReadonlySet<string> = new Set<VolumeProtectionReason>([
  'engine_registered', 'engine_not_installed', 'schema_newer_than_build', 'recovery_store_unavailable',
  'node_contract_older', 'hub_contract_older', 'node_unreachable', 'descriptor_invalid',
]);

/** Parse an untrusted descriptor from another node; null when it is not one. */
export function parseRecoveryNodeDescriptor(data: unknown): RecoveryNodeDescriptor | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { contractVersion, volumeProtection } = data as Record<string, unknown>;
  if (typeof contractVersion !== 'number' || !Number.isInteger(contractVersion) || contractVersion < 1) return null;
  if (!volumeProtection || typeof volumeProtection !== 'object') return null;
  const vp = volumeProtection as Record<string, unknown>;
  if (vp.capability !== VOLUME_PROTECTION_CAPABILITY) return null;
  if (typeof vp.version !== 'number' || !Number.isInteger(vp.version)) return null;
  if (typeof vp.state !== 'string' || !STATES.has(vp.state)) return null;
  if (typeof vp.reason !== 'string' || !REASONS.has(vp.reason)) return null;
  return {
    contractVersion,
    volumeProtection: {
      capability: VOLUME_PROTECTION_CAPABILITY,
      version: vp.version,
      state: vp.state as VolumeProtectionState,
      reason: vp.reason as VolumeProtectionReason,
    },
  };
}

/**
 * The hub's view of a remote node's volume protection, from its descriptor
 * read. An old node answers 404 for the descriptor route: update required. A
 * node that cannot be reached, or answers with something else, is unknown.
 */
export function resolveRemoteVolumeProtection(read: NodeProxyJsonRead): VolumeProtectionStatus {
  if (read.kind === 'route_missing') return status('update_required', 'node_contract_older');
  if (read.kind !== 'ok') return status('unknown', 'node_unreachable');
  const descriptor = parseRecoveryNodeDescriptor(read.data);
  if (!descriptor) return status('unknown', 'descriptor_invalid');
  if (descriptor.contractVersion < RECOVERY_CONTRACT_VERSION) return status('update_required', 'node_contract_older');
  if (descriptor.contractVersion > RECOVERY_CONTRACT_VERSION) return status('update_required', 'hub_contract_older');
  const vp = descriptor.volumeProtection;
  if (vp.version < VOLUME_PROTECTION_CAPABILITY_VERSION) return status('update_required', 'node_contract_older');
  if (vp.version > VOLUME_PROTECTION_CAPABILITY_VERSION) return status('update_required', 'hub_contract_older');
  return status(vp.state, vp.reason);
}
