/** Wire types for the bootstrap preflight. A deliberate subset of the backend shapes. */

export type BootstrapStatus = 'pass' | 'warn' | 'blocked' | 'unknown';

export interface BootstrapCheck {
  id: string;
  category: string;
  label: string;
  status: BootstrapStatus;
  summary: string;
  observed?: string;
  remediation?: string;
}

export interface PathFacts {
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
  writableBySudo: boolean;
  parentWritableByUser: boolean | null;
  nearestExistingAncestor: string | null;
  filesystem: { type: string; source: string; mountPoint: string } | null;
  freeBytes: number | null;
  probeError: string | null;
}

export interface ComposeDirFacts extends PathFacts {
  stackCount: number | null;
  stackNames: string[];
  inventoryTruncated: boolean;
  inventoryError: string | null;
  rootComposeFile: boolean;
}

export interface AgentDirFacts extends PathFacts {
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

export interface BootstrapInspection {
  observedAt: number;
  target: { host: string; port: number; username: string; address: string };
  hostKey: { algorithm: string; fingerprint: string; knownHostsLine: string };
  paths: { composeDir: ComposeDirFacts; agentDir: AgentDirFacts };
  agent: {
    projectContainers: Array<{ name: string; workingDir: string | null; configFiles: string | null; image: string; status: string }>;
    dataVolumeExists: boolean | null;
    dataVolumeNames: string[];
    defaultDirHasComposeFile: boolean | null;
    defaultDirRealPath?: string | null;
  };
  dockerRoot: { path: string | null; freeBytes: number | null; filesystemType: string | null };
  checks: BootstrapCheck[];
  blockers: number;
  warnings: number;
}

export interface BootstrapPlanStep {
  id: string;
  title: string;
  rationale: string;
  effect: string;
  privilege: 'user' | 'sudo';
  command: string | null;
  target?: { path: string; mode: string | null; owner: string | null; group: string | null; preserveExisting: boolean };
  file?: { path: string; mode: string; content: string; redacted: boolean };
  disruptive: boolean;
  reversible: string;
  pointOfNoReturn: boolean;
  timeoutMs: number;
}

export interface BootstrapPlan {
  version: number;
  generatedAt: number;
  target: { host: string; port: number; username: string; address: string };
  targetName: string;
  hostKeyFingerprint: string;
  hubUrl: string;
  paths: {
    composeDir: { input: string; realPath: string | null; exists: boolean; created: boolean; stackCount?: number | null };
    agentDir: { input: string; realPath: string | null; exists: boolean; created: boolean };
  };
  projectName: string;
  containerName: string;
  dataVolume: string;
  image: { ref: string; digest: string | null; resolvedAt: string };
  stages: Array<{ id: string; title: string; steps: BootstrapPlanStep[] }>;
  skipped: Array<{ id: string; reason: string }>;
  sources: Array<{ name: string; url: string; keyFingerprint: string | null }>;
  versions: Record<string, string | null>;
  redactions: Array<{ placeholder: string; purpose: string }>;
  verification: Array<{ id: string; title: string; expected: string; slice: 'S2' | 'S3' }>;
  notices: string[];
  evidenceDigest: string;
  digest: string;
}

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

export type BootstrapStep = 'target' | 'preflight' | 'plan';

export interface BootstrapForm {
  targetName: string;
  host: string;
  port: string;
  username: string;
  privateKey: string;
  passphrase: string;
  composeDir: string;
  agentDir: string;
}
