/**
 * Pure classifier for missing Compose external networks.
 * Async rendering/snapshot resolution lives at API/deploy boundaries only.
 */

import type { EffectiveModel, EffDriverKind, EffResource } from '../preflight/effectiveModel';
import {
  isValidDockerNetworkName,
  RESERVED_SYSTEM_NETWORK_NAMES,
} from './dockerNetworkName';

export type DriverKind = EffDriverKind;

export type UnsupportedFeature =
  | 'driver_opts'
  | 'custom_ipam'
  | 'labels'
  | 'internal'
  | 'attachable'
  | 'ipv4_disabled'
  | 'ipv6_enabled';

export type BlockReason =
  | 'invalid_name'
  | 'reserved_system'
  | 'unsupported_driver'
  | 'unsupported_options';

export interface SafeCreationSpec {
  driver: 'bridge';
  options: 'default';
}

export interface KeyDeclaration {
  key: string;
  driverKind: DriverKind;
  unsupportedFeatures: UnsupportedFeature[];
}

export interface MissingExternalNetwork {
  name: string;
  keys: string[];
  declarations: KeyDeclaration[];
  safe: boolean;
  blockReason?: BlockReason;
  unsupportedFeatures: UnsupportedFeature[];
  creationSpec: SafeCreationSpec | null;
}

const UNSUPPORTED_FEATURE_ORDER: readonly UnsupportedFeature[] = [
  'driver_opts',
  'custom_ipam',
  'labels',
  'internal',
  'attachable',
  'ipv4_disabled',
  'ipv6_enabled',
];

const SAFE_CREATION_SPEC: SafeCreationSpec = { driver: 'bridge', options: 'default' };

function stableSortFeatures(features: Iterable<UnsupportedFeature>): UnsupportedFeature[] {
  const set = new Set(features);
  return UNSUPPORTED_FEATURE_ORDER.filter((f) => set.has(f));
}

function featuresForResource(net: EffResource): UnsupportedFeature[] {
  const features: UnsupportedFeature[] = [];
  if (net.hasDriverOpts) features.push('driver_opts');
  if (net.hasCustomIpam) features.push('custom_ipam');
  if (net.hasLabels) features.push('labels');
  if (net.internal) features.push('internal');
  if (net.attachable) features.push('attachable');
  if (net.ipv4Enabled === false) features.push('ipv4_disabled');
  if (net.ipv6Enabled === true) features.push('ipv6_enabled');
  return features;
}

function isSafeDriverKind(kind: DriverKind): boolean {
  return kind === 'default' || kind === 'bridge';
}

function classifyKey(key: string, net: EffResource): KeyDeclaration {
  return {
    key,
    driverKind: net.driverKind ?? 'default',
    unsupportedFeatures: featuresForResource(net),
  };
}

function blockReasonForGroup(
  name: string,
  declarations: KeyDeclaration[],
): { safe: boolean; blockReason?: BlockReason; unsupportedFeatures: UnsupportedFeature[] } {
  if (!isValidDockerNetworkName(name)) {
    return { safe: false, blockReason: 'invalid_name', unsupportedFeatures: [] };
  }
  if (RESERVED_SYSTEM_NETWORK_NAMES.has(name)) {
    return { safe: false, blockReason: 'reserved_system', unsupportedFeatures: [] };
  }

  const unsupportedFeatures = stableSortFeatures(
    declarations.flatMap((d) => d.unsupportedFeatures),
  );
  const hasUnsafeDriver = declarations.some((d) => !isSafeDriverKind(d.driverKind));
  if (hasUnsafeDriver) {
    return {
      safe: false,
      blockReason: 'unsupported_driver',
      unsupportedFeatures,
    };
  }
  if (unsupportedFeatures.length > 0) {
    return {
      safe: false,
      blockReason: 'unsupported_options',
      unsupportedFeatures,
    };
  }
  return { safe: true, unsupportedFeatures: [] };
}

/**
 * Classify missing external networks from an already-rendered effective model
 * and a set of live Docker network names. Synchronous; no I/O.
 */
export function classifyMissingExternalNetworks(
  model: EffectiveModel,
  existingNetworkNames: ReadonlySet<string>,
): MissingExternalNetwork[] {
  const byRuntimeName = new Map<string, KeyDeclaration[]>();

  for (const [key, net] of Object.entries(model.networks)) {
    if (!net.external) continue;
    if (existingNetworkNames.has(net.name)) continue;
    const declaration = classifyKey(key, net);
    const list = byRuntimeName.get(net.name) ?? [];
    list.push(declaration);
    byRuntimeName.set(net.name, list);
  }

  const groups: MissingExternalNetwork[] = [];
  for (const [name, declarations] of byRuntimeName) {
    declarations.sort((a, b) => a.key.localeCompare(b.key));
    const { safe, blockReason, unsupportedFeatures } = blockReasonForGroup(name, declarations);
    groups.push({
      name,
      keys: declarations.map((d) => d.key),
      declarations,
      safe,
      blockReason,
      unsupportedFeatures,
      creationSpec: safe ? SAFE_CREATION_SPEC : null,
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}
