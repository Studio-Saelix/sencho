export type NetworkingOwnership = 'system' | 'sencho-managed' | 'compose-managed' | 'unmanaged';
export type NetworkingFindingSeverity = 'critical' | 'high' | 'medium' | 'info';

export type NetworkingFindingKind =
  | 'external-network-missing'
  | 'network-missing'
  | 'network-undeclared'
  | 'declared-network-unused'
  | 'foreign-network-attachment'
  | 'alias-collision'
  | 'network-mode-host'
  | 'exposure-unclassified'
  | 'exposure-all-interfaces'
  | 'shared-network'
  | 'network-name-collision'
  | 'service-name-collision'
  | 'large-flat-network'
  | 'advanced-driver-caveat'
  | 'runtime-unavailable'
  | 'exposure-intent-mismatch'
  | 'port-conflict-node'
  | 'port-conflict-internal'
  | 'sensitive-service-broad-exposure'
  | 'exposure-port-vs-dossier'
  | 'reverse-proxy-undocumented'
  | 'new-network';

/** The finding kinds that count as "drift", shared by the Networks-table drift
 *  filter/count and the Overview drift metric so the two never diverge. (Topology
 *  drift is keyed off each container's own driftFlags, not this list.) */
export const NETWORK_DRIFT_FINDING_KINDS: readonly NetworkingFindingKind[] = [
  'network-undeclared',
  'network-missing',
  'declared-network-unused',
  'foreign-network-attachment',
  'external-network-missing',
];

export function isNetworkDriftFindingKind(kind: NetworkingFindingKind): boolean {
  return (NETWORK_DRIFT_FINDING_KINDS as readonly string[]).includes(kind);
}

export interface NetworkingNetworkBase {
  id: string;
  name: string;
  driver: string;
  scope: string;
  isSystem: boolean;
  ingress: boolean;
  enableIPv6?: boolean;
  composeProject: string | null;
  stack: string | null;
  connectedCount: number;
  isSencho: boolean;
  ownership: NetworkingOwnership;
  declaredByStacks: string[];
  declaredExternalByStacks: string[];
  isExternalDependency: boolean;
}

export interface NetworkingNetworkRow extends NetworkingNetworkBase {
  sharedStackCount: number;
  exposureSummary: {
    publishingStackCount: number;
    broadExposureCount: number;
    unclassifiedStackCount: number;
  } | null;
  findingIds: string[];
  serviceNames: string[];
}

export type NetworkingRecommendedAction =
  | { kind: 'open-stack'; label: string; stack: string }
  | { kind: 'open-stack-networking'; label: string; stack: string }
  | { kind: 'open-stack-doctor'; label: string; stack: string }
  | { kind: 'open-stack-editor'; label: string; stack: string }
  | { kind: 'open-stack-dossier'; label: string; stack: string }
  | { kind: 'open-stack-drift'; label: string; stack: string }
  | { kind: 'set-exposure-intent'; label: string; stack: string; service?: string }
  | { kind: 'create-network'; label: string; networkName: string; requiresAdmin: true }
  | { kind: 'copy-compose-snippet'; label: string; snippetKind: 'external-network'; networkName: string }
  | { kind: 'copy-docker-command'; label: string; commandKind: 'network-create'; networkName: string }
  | { kind: 'filter-topology'; label: string; networkName?: string; stack?: string }
  | { kind: 'inspect-network'; label: string; networkId: string }
  | { kind: 'open-docs'; label: string; docsPath: string }
  | { kind: 'refresh'; label: string };

export type NetworkingFindingSource = 'live' | 'doctor';

export interface DoctorFindingMetadata {
  ruleId: string;
  ranAt: string;
  title: string;
  message: string;
  service?: string;
  sourcePath?: string;
  remediation?: string;
  severity: NetworkingFindingSeverity;
}

export interface NetworkingFinding {
  id: string;
  kind: NetworkingFindingKind;
  severity: NetworkingFindingSeverity;
  title: string;
  message: string;
  stack?: string;
  network?: string;
  service?: string;
  evidence: { label: string; value: string }[];
  recommendedActions: NetworkingRecommendedAction[];
  sources: NetworkingFindingSource[];
  doctorFindings: DoctorFindingMetadata[];
}

export interface NodeNetworkingOverview {
  runtimeAvailable: boolean;
  networkCount: number | null;
  stackCount: number;
  connectedContainerCount: number | null;
  systemNetworkCount: number | null;
  senchoManagedNetworkCount: number | null;
  composeManagedNetworkCount: number | null;
  unmanagedNetworkCount: number | null;
  externalDependencyNetworkCount: number | null;
  exposedStackCount: number;
  unknownExposureStackCount: number;
  missingExternalCount: number;
  networkCollisionCount: number;
  findingCount: number;
  /** Served from the backend memo after a recompute failure; data may lag recent changes. */
  degradedCache?: boolean;
  renderFailedStacks: string[];
}

export interface NetworkFactPort {
  hostIp: string | null;
  published: string | null;
  target: string;
  protocol: string;
}

export interface NetworkingTopologyContainer {
  id: string;
  name: string;
  ip: string;
  state: string;
  image: string;
  stack: string | null;
  service: string | null;
  composeAliases: string[];
  publishedPorts: NetworkFactPort[];
  exposureIntent: 'internal' | 'same-node' | 'lan' | 'reverse-proxy' | 'public' | 'temporary' | 'unknown' | null;
  findingIds: string[];
  driftFlags: string[];
  hostMode: boolean;
}

/** Client-computed detail model for the topology container drawer: aggregates a
 *  container's attachments across every network it belongs to (layoutGraph already
 *  dedupes containers cross-network; this preserves that full attachment list
 *  instead of collapsing it to a single `ip` string). */
export interface NetworkingTopologyContainerDetail {
  id: string;
  name: string;
  stack: string | null;
  service: string | null;
  image: string;
  state: string;
  attachments: { network: string; ip: string }[];
  composeAliases: string[];
  publishedPorts: NetworkFactPort[];
  exposureIntent: NetworkingTopologyContainer['exposureIntent'];
  findingIds: string[];
  driftFlags: string[];
}

export interface NetworkingTopologyNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  stack: string | null;
  isSystem: boolean;
  ingress: boolean;
  enableIPv6?: boolean;
  ownership: NetworkingOwnership;
  declaredByStacks: string[];
  declaredExternalByStacks: string[];
  isExternalDependency: boolean;
  runtimeState?: 'present' | 'missing';
  findingIds: string[];
  containers: NetworkingTopologyContainer[];
}

export interface NetworkingTopology {
  networks: NetworkingTopologyNetwork[];
  includeSystem: boolean;
}

export interface NetworkingActivity {
  id: number;
  category: string;
  message: string;
  timestamp: string | number;
  stack_name?: string | null;
}

export interface NetworkingEnvelope {
  /** Wire value from the responding node; older remotes send 1 or 2, so the
   *  frontend treats it as an open number and adapts, never a fixed literal. */
  schemaVersion: number;
  runtimeAvailable: boolean;
  generatedAt: string;
}

export interface NetworkingOverviewEnvelope extends NetworkingEnvelope {
  overview: NodeNetworkingOverview;
  networks: NetworkingNetworkRow[];
  findings: NetworkingFinding[];
  recentActivity: NetworkingActivity[];
}

export interface NetworkingTopologyEnvelope extends NetworkingEnvelope {
  networks: NetworkingTopologyNetwork[];
}

export interface SanitizedNetworkInspectContainer {
  name: string;
  service: string | null;
  stack: string | null;
  ipv4: string | null;
}

export interface SanitizedNetworkInspect {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  ingress: boolean;
  enableIPv6: boolean;
  stack: string | null;
  composeProject: string | null;
  connectedCount: number;
  labelKeys: string[];
  subnets: string[];
  gateways: string[];
  connectedContainers: SanitizedNetworkInspectContainer[];
}
