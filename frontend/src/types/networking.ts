export const NETWORKING_SCHEMA_VERSION = 2 as const;

export type NetworkingOwnership = 'system' | 'sencho-managed' | 'compose-managed' | 'unmanaged';
export type NetworkingFindingSeverity = 'critical' | 'high' | 'medium' | 'info';

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
}

export type NetworkingRecommendedAction =
  | { kind: 'open-stack'; label: string; stack: string }
  | { kind: 'open-stack-networking'; label: string; stack: string }
  | { kind: 'open-stack-doctor'; label: string; stack: string }
  | { kind: 'open-stack-editor'; label: string; stack: string }
  | { kind: 'set-exposure-intent'; label: string; stack: string; service?: string }
  | { kind: 'create-network'; label: string; networkName: string; requiresAdmin: true }
  | { kind: 'copy-compose-snippet'; label: string; snippetKind: 'external-network'; networkName: string }
  | { kind: 'copy-docker-command'; label: string; commandKind: 'network-create'; networkName: string }
  | { kind: 'filter-topology'; label: string; networkName?: string; stack?: string }
  | { kind: 'inspect-network'; label: string; networkId: string }
  | { kind: 'open-docs'; label: string; docsPath: string }
  | { kind: 'refresh'; label: string };

export interface NetworkingFinding {
  id: string;
  kind: string;
  severity: NetworkingFindingSeverity;
  title: string;
  message: string;
  stack?: string;
  network?: string;
  service?: string;
  evidence: { label: string; value: string }[];
  recommendedActions: NetworkingRecommendedAction[];
}

export interface NodeNetworkingOverview {
  runtimeAvailable: boolean;
  networkCount: number | null;
  stackCount: number;
  connectedContainerCount: number | null;
  systemNetworkCount: number | null;
  exposedStackCount: number;
  unknownExposureStackCount: number;
  missingExternalCount: number;
  networkCollisionCount: number;
  findingCount: number;
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
  schemaVersion: typeof NETWORKING_SCHEMA_VERSION;
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
}
