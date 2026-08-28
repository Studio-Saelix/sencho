/**
 * DTOs for the node-scoped Networking operator page. These payloads never carry
 * raw Docker label values or inspect secrets; label keys only on detail views.
 */
import type { StackNetworkFacts } from './types';

export const NETWORKING_SCHEMA_VERSION = 3;
export type NetworkingOwnership = 'system' | 'sencho-managed' | 'compose-managed' | 'unmanaged';

/** Phase A row: identity and ownership from the dependency snapshot only. */
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
  /** Compose service names attached to this network, from the dependency snapshot only (never labels). */
  serviceNames: string[];
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
  'shared-network',
  'network-name-collision',
  'service-name-collision',
  'large-flat-network',
  'advanced-driver-caveat',
  'runtime-unavailable',
  'exposure-intent-mismatch',
  // Doctor-only rules (cached, aggregated via doctorNetworkingFindings.ts)
  'port-conflict-node',
  'port-conflict-internal',
  'sensitive-service-broad-exposure',
  'exposure-port-vs-dossier',
  'reverse-proxy-undocumented',
  'new-network',
] as const;

export type NetworkingFindingKind = typeof NETWORKING_FINDING_KINDS[number];

export type NetworkingFindingSeverity = 'critical' | 'high' | 'medium' | 'info';

export type NetworkingFindingSource = 'live' | 'doctor';

/** One retained Doctor occurrence merged into (or standing in for) a unified finding.
 *  Never derived from message text; ruleId + structural fields only. */
export interface DoctorFindingMetadata {
  ruleId: string;
  ranAt: string;
  title: string;
  message: string;
  service?: string;
  sourcePath?: string;
  remediation?: string;
  /** Doctor's own severity translation, kept even when the merged card's canonical
   *  severity (live) differs, so provenance is never lost. */
  severity: NetworkingFindingSeverity;
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
  /** Which engine(s) detected this finding. A card merged from both engines keeps
   *  live severity/title/message as canonical and carries Doctor context in doctorFindings. */
  sources: NetworkingFindingSource[];
  /** Every retained Doctor occurrence that structurally matches this card (one-to-many:
   *  e.g. two broad-bind ports on one service both attach here). Empty for live-only findings. */
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
  /** True when this aggregate was served from the memo after a recompute failure (stale-on-error fallback). */
  degradedCache: boolean;
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
  publishedPorts: import('./types').NetworkFactPort[];
  exposureIntent: import('./types').ExposureIntent | null;
  findingIds: string[];
  driftFlags: string[];
  hostMode: boolean;
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

export interface NodeNetworkingAggregate {
  overview: NodeNetworkingOverview;
  networks: NetworkingNetworkRow[];
  findings: NetworkingFinding[];
  topology?: NetworkingTopology;
  stackFacts: StackNetworkFacts[];
  runtimeAvailable: boolean;
  recentActivity: import('../DatabaseService').NotificationHistory[];
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
  /** Strict allowlist join against the DependencySnapshot; never labels, MAC addresses,
   *  endpoint IDs, or raw Docker options. */
  connectedContainers: SanitizedNetworkInspectContainer[];
}

export interface NetworkingEnvelope {
  schemaVersion: typeof NETWORKING_SCHEMA_VERSION;
  runtimeAvailable: boolean;
  generatedAt: string;
}
