/**
 * DTOs for the node-scoped Networking operator page. These payloads never carry
 * raw Docker label values or inspect secrets; label keys only on detail views.
 */
import type { StackNetworkFacts } from './types';

/** Phase A row: identity and ownership from the dependency snapshot only. */
export interface NetworkingNetworkBase {
  id: string;
  name: string;
  driver: string;
  scope: string;
  isSystem: boolean;
  composeProject: string | null;
  stack: string | null;
  connectedCount: number;
  isSencho: boolean;
}

export interface NetworkingExposureSummary {
  publishingStackCount: number;
  broadExposureCount: number;
  unclassifiedStackCount: number;
}

/** Phase B row: inventory enrichment after stack facts and findings exist. */
export interface NetworkingNetworkRow extends NetworkingNetworkBase {
  sharedStackCount: number;
  exposureSummary: NetworkingExposureSummary | null;
  findingIds: string[];
}

export const NETWORKING_FINDING_KINDS = [
  'external-network-missing',
  'network-missing',
  'network-undeclared',
  'declared-network-unused',
  'foreign-network-attachment',
  'alias-collision',
  'network-mode-host',
  'exposure-unclassified',
  'exposure-all-interfaces',
  'exposure-internal-conflict',
  'shared-network',
  'network-name-collision',
] as const;

export type NetworkingFindingKind = typeof NETWORKING_FINDING_KINDS[number];

export type NetworkingFindingSeverity = 'info' | 'warning' | 'error';

export interface NetworkingFinding {
  id: string;
  kind: NetworkingFindingKind;
  severity: NetworkingFindingSeverity;
  title: string;
  message: string;
  stack?: string;
  network?: string;
  service?: string;
}

export interface NodeNetworkingOverview {
  networkCount: number;
  stackCount: number;
  connectedContainerCount: number;
  systemNetworkCount: number;
  exposedStackCount: number;
  unknownExposureStackCount: number;
  missingExternalCount: number;
  networkCollisionCount: number;
  findingCount: number;
  renderFailedStacks: string[];
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
}

export interface NetworkingTopologyNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  stack: string | null;
  isSystem: boolean;
  findingIds: string[];
  containers: NetworkingTopologyContainer[];
}

export interface NetworkingTopology {
  networks: NetworkingTopologyNetwork[];
  includeSystem: boolean;
}

export interface NodeNetworkingAggregate {
  overview: NodeNetworkingOverview;
  networks: NetworkingNetworkRow[];
  findings: NetworkingFinding[];
  topology?: NetworkingTopology;
  stackFacts: StackNetworkFacts[];
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

export type NetworkingAggregateDepth = 'overview' | 'findings' | 'topology';
