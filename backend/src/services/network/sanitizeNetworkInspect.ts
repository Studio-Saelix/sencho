/**
 * Privacy-safe network inspect DTO for the Networking page. Returns structural
 * fields and label keys only; never label values or IPAM secrets.
 */
import type { DependencyNetwork, DependencySnapshot } from '../DockerController';
import type { SanitizedNetworkInspect } from './networkingTypes';

interface RawNetworkInspect {
  Id?: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Attachable?: boolean;
  Ingress?: boolean;
  EnableIPv6?: boolean;
  Labels?: Record<string, string>;
  IPAM?: {
    Config?: Array<{ Subnet?: string; Gateway?: string }>;
  };
  Containers?: Record<string, unknown>;
}

export function sanitizeNetworkInspect(
  raw: RawNetworkInspect,
  snapshotNet: DependencyNetwork | undefined,
): SanitizedNetworkInspect {
  const subnets: string[] = [];
  const gateways: string[] = [];
  for (const cfg of raw.IPAM?.Config ?? []) {
    if (typeof cfg.Subnet === 'string' && cfg.Subnet) subnets.push(cfg.Subnet);
    if (typeof cfg.Gateway === 'string' && cfg.Gateway) gateways.push(cfg.Gateway);
  }

  return {
    id: raw.Id ?? snapshotNet?.id ?? '',
    name: raw.Name ?? snapshotNet?.name ?? '',
    driver: raw.Driver ?? snapshotNet?.driver ?? 'bridge',
    scope: raw.Scope ?? snapshotNet?.scope ?? 'local',
    internal: raw.Internal === true,
    attachable: raw.Attachable === true,
    ingress: raw.Ingress === true,
    enableIPv6: raw.EnableIPv6 === true,
    stack: snapshotNet?.stack ?? null,
    composeProject: snapshotNet?.composeProject ?? null,
    connectedCount: raw.Containers ? Object.keys(raw.Containers).length : 0,
    labelKeys: Object.keys(raw.Labels ?? {}).sort(),
    subnets,
    gateways,
  };
}

export function findSnapshotNetwork(
  snapshot: DependencySnapshot,
  idOrName: string,
): DependencyNetwork | undefined {
  return snapshot.networks.find(n => n.id === idOrName || n.name === idOrName);
}
