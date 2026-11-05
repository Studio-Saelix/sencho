/**
 * Domain model for the read-only node bootstrap preflight.
 *
 * `BootstrapFacts` is the single input to both the evidence mapper and the plan
 * builder, and both are pure functions of it. That keeps every verdict and every
 * previewed command unit-testable without an SSH server, and it makes the plan
 * digest a function of observed host state plus the two chosen directories.
 */

export type BootstrapStatus = 'pass' | 'warn' | 'blocked' | 'unknown';

export type BootstrapCheckCategory =
  | 'identity'
  | 'host'
  | 'privileges'
  | 'docker'
  | 'storage'
  | 'network'
  | 'paths'
  | 'conflicts';

export type BootstrapCheckId =
  | 'ssh_host_key'
  | 'ssh_auth'
  | 'os_supported'
  | 'arch_supported'
  | 'clock_skew'
  | 'sudo'
  | 'docker_cli'
  | 'docker_daemon'
  | 'compose_plugin'
  | 'docker_socket'
  | 'apt_source'
  | 'disk_space'
  | 'compose_dir'
  | 'agent_dir'
  | 'path_separation'
  | 'path_persistence'
  | 'agent_conflict'
  | 'existing_workloads'
  | 'node_name'
  | 'hub_url'
  | 'hub_reachable';

export interface BootstrapTarget {
  host: string;
  port: number;
  username: string;
  /** Validated IP actually dialed, recorded for audit. */
  address: string;
}

export interface HostKeyObservation {
  algorithm: string;
  /** OpenSSH display form, SHA256:<base64 without padding>. */
  fingerprint: string;
  /** "<host> <algorithm> <base64>" for operator comparison. */
  knownHostsLine: string;
}

export interface PathObservation {
  input: string;
  normalized: string;
  realPath: string | null;
  exists: boolean;
  isDirectory: boolean;
  isFinalSymlink: boolean;
  hasSymlinkAncestor: boolean;
  owner: string | null;
  group: string | null;
  mode: string | null;
  readableByUser: boolean;
  writableByUser: boolean;
  readableBySudo: boolean;
  writableBySudo: boolean;
  parentWritableByUser: boolean | null;
  nearestExistingAncestor: string | null;
  filesystem: { type: string; source: string; mountPoint: string } | null;
  freeBytes: number | null;
  mountInFstab: boolean | null;
  probeError: string | null;
}

export interface ComposeDirObservation extends PathObservation {
  stackCount: number | null;
  stackNames: string[];
  /** A partial or failed inventory never proves that a stack is absent. */
  inventoryTruncated: boolean;
  inventoryError: string | null;
  rootComposeFile: boolean;
}

export interface AgentDirObservation extends PathObservation {
  entries: string[];
  entriesTruncated: boolean;
  inventoryError: string | null;
  hasComposeFile: boolean;
  hasCaFile: boolean;
  hasMarker: boolean;
  markerProject: string | null;
  markerComposeDir: string | null;
  markerAgentDir: string | null;
}

export interface AgentInstallObservation {
  projectContainers: Array<{
    name: string;
    workingDir: string | null;
    configFiles: string | null;
    image: string;
    status: string;
  }>;
  dataVolumeExists: boolean | null;
  dataVolumeNames: string[];
  defaultDirHasComposeFile: boolean;
}

export type DockerPackageName =
  | 'docker-ce'
  | 'docker-ce-cli'
  | 'containerd.io'
  | 'docker-buildx-plugin'
  | 'docker-compose-plugin';

export interface DockerPackage {
  name: DockerPackageName;
  installedVersion: string | null;
  candidateVersion: string | null;
  /** Repository URI apt reports for the candidate version, when known. */
  candidateSource?: string | null;
}

export interface BootstrapPaths {
  composeDir: ComposeDirObservation;
  agentDir: AgentDirObservation;
}

export interface RepositoryObservation {
  /** False when the repository probe did not run to completion. */
  probeComplete: boolean;
  /** A Docker source file exists. Existence alone proves nothing about its provenance. */
  dockerSourceConfigured: boolean;
  /** A Docker keyring file exists; whether it parses is keyringVerified. */
  keyringPresent: boolean;
  /** Null when the source exists but could not be read or parsed. */
  sourceVerified: boolean | null;
  keyringVerified: boolean | null;
  candidateSourceVerified: boolean | null;
  /** Human-readable reason the source or keyring is not provably official. */
  problem: string | null;
}

export interface BootstrapFacts {
  target: BootstrapTarget;
  hostKey: HostKeyObservation;
  os: { id: string; versionId: string; codename: string; prettyName: string; arch: string; kernel: string } | null;
  user: { name: string; uid: number; group: string; isRoot: boolean; sudoNonInteractive: boolean } | null;
  docker: {
    cliInstalled: boolean;
    /** True when the CLI probe itself timed out, errored or was truncated. */
    cliProbeUnknown: boolean;
    serverVersion: string | null;
    composeVersion: string | null;
    serviceActive: boolean | null;
    serviceEnabled: boolean | null;
    socketAccess: 'user' | 'sudo' | 'none';
    rootDir: string | null;
    /** The local unix socket every Docker command is pinned to. */
    endpoint: string;
  };
  repo: RepositoryObservation;
  packages: DockerPackage[];
  paths: {
    composeDir: ComposeDirObservation;
    agentDir: AgentDirObservation;
  };
  agent: AgentInstallObservation;
  dockerRoot: { path: string | null; freeBytes: number | null; filesystemType: string | null };
  containers: {
    total: number;
    sample: Array<{ name: string; image: string; project: string | null }>;
    agentContainer: string | null;
    /** False when the container list is truncated or could not be read. */
    complete: boolean;
    error: string | null;
  };
  clockSkewMs: number | null;
  hub: { url: string; reachable: boolean | null; statusCode: number | null; tlsTrusted: boolean | null };
}

interface BootstrapCheckBase {
  id: BootstrapCheckId;
  category: BootstrapCheckCategory;
  label: string;
  summary: string;
  observed?: string;
}

/** Every non-pass must carry a remediation, as with EnvironmentCheck. */
export type BootstrapCheck =
  | (BootstrapCheckBase & { status: 'pass' })
  | (BootstrapCheckBase & { status: 'warn' | 'blocked' | 'unknown'; remediation: string });

export interface BootstrapInspection {
  observedAt: number;
  target: BootstrapTarget;
  hostKey: HostKeyObservation;
  paths: {
    composeDir: ComposeDirObservation;
    agentDir: AgentDirObservation;
  };
  agent: AgentInstallObservation;
  dockerRoot: { path: string | null; freeBytes: number | null; filesystemType: string | null };
  checks: BootstrapCheck[];
  blockers: number;
  warnings: number;
}

export type BootstrapStageId =
  | 'docker_repository'
  | 'docker_packages'
  | 'docker_service'
  | 'compose_dir'
  | 'agent_dir'
  | 'agent_project'
  | 'agent_start';

export type BootstrapStepEffect =
  | 'package-metadata'
  | 'package-install'
  | 'service-change'
  | 'directory-create'
  | 'file-write'
  | 'container-start';

export interface BootstrapPlanStep {
  id: string;
  title: string;
  rationale: string;
  effect: BootstrapStepEffect;
  privilege: 'user' | 'sudo';
  /** Exact command, with secrets as {{PLACEHOLDERS}}. Null for a pure file write. */
  command: string | null;
  target?: {
    path: string;
    mode: string | null;
    owner: string | null;
    group: string | null;
    preserveExisting: boolean;
  };
  file?: { path: string; mode: string; content: string; redacted: boolean };
  disruptive: boolean;
  reversible: 'yes' | 'no' | 'unknown';
  pointOfNoReturn: boolean;
  timeoutMs: number;
}

export interface BootstrapPlanPath {
  input: string;
  realPath: string | null;
  exists: boolean;
  created: boolean;
  stackCount?: number | null;
}

export interface BootstrapPlan {
  version: 1;
  generatedAt: number;
  target: BootstrapTarget;
  targetName: string;
  hostKeyFingerprint: string;
  hubUrl: string;
  paths: {
    composeDir: BootstrapPlanPath;
    agentDir: BootstrapPlanPath;
  };
  projectName: string;
  containerName: string;
  dataVolume: string;
  image: { ref: string; digest: string | null; resolvedAt: 'execution' };
  stages: Array<{ id: BootstrapStageId; title: string; steps: BootstrapPlanStep[] }>;
  skipped: Array<{ id: BootstrapStageId; reason: string }>;
  sources: Array<{ name: string; url: string; keyFingerprint: string | null }>;
  versions: Record<string, string | null>;
  redactions: Array<{ placeholder: string; purpose: string }>;
  verification: Array<{ id: string; title: string; expected: string; slice: 'S2' | 'S3' }>;
  notices: string[];
  evidenceDigest: string;
  digest: string;
}

/** Everything the UI needs from a completed inspection, blocked or not. */
export interface BootstrapPreflightResult {
  inspection: BootstrapInspection;
  plan: BootstrapPlan | null;
  blocked: boolean;
}

export interface BootstrapCapabilities {
  supported: { os: string[]; arch: string[] };
  defaults: { composeDir: string; agentDir: string };
  fixed: {
    projectName: string;
    containerName: string;
    dataVolume: string;
    dataMount: string;
    image: string;
  };
  limits: {
    maxPathLength: number;
    blockBelowComposeFreeBytes: number;
    warnBelowComposeFreeBytes: number;
    blockBelowAgentFreeBytes: number;
    warnBelowAgentFreeBytes: number;
    blockBelowDockerRootFreeBytes: number;
    warnBelowDockerRootFreeBytes: number;
  };
  pathPolicy: {
    reservedPrefixes: string[];
    exactRoots: string[];
    deniedFilesystems: string[];
  };
}

export interface BootstrapHostKeyResult {
  host: string;
  port: number;
  address: string;
  algorithm: string;
  fingerprint: string;
  knownHostsLine: string;
  trust: 'trusted' | 'unknown' | 'changed';
  pinnedFingerprint: string | null;
}
