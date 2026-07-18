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
  snapshot?: DependencySnapshot,
): SanitizedNetworkInspect {
  const subnets: string[] = [];
  const gateways: string[] = [];
  for (const cfg of raw.IPAM?.Config ?? []) {
    if (typeof cfg.Subnet === 'string' && cfg.Subnet) subnets.push(cfg.Subnet);
    if (typeof cfg.Gateway === 'string' && cfg.Gateway) gateways.push(cfg.Gateway);
  }

  const networkId = raw.Id ?? snapshotNet?.id ?? '';
  const networkName = raw.Name ?? snapshotNet?.name ?? '';
  const connectedContainers = snapshot
    ? snapshot.containers
      .filter((c) => c.networks.some((n) => n.id === networkId || n.name === networkName))
      .map((c) => {
        const attachment = c.networks.find((n) => n.id === networkId || n.name === networkName);
        return {
          name: c.name,
          service: c.service,
          stack: c.stack,
          ipv4: attachment?.ip ? attachment.ip.replace(/\/\d+$/, '') : null,
        };
      })
    : [];

  return {
    id: networkId,
    name: networkName,
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
    connectedContainers,
  };
}

export function findSnapshotNetwork(
  snapshot: DependencySnapshot,
  idOrName: string,
): DependencyNetwork | undefined {
  return snapshot.networks.find(n => n.id === idOrName || n.name === idOrName);
}
