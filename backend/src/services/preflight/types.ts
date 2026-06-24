import type { EffectiveModel } from './effectiveModel';
import type { ExposureIntent } from '../network/types';

/** Graded severity of a single preflight finding. */
export type PreflightSeverity = 'blocker' | 'high' | 'warning' | 'info';

/**
 * Overall outcome of a run. `pass` = renderable with no findings;
 * `unrenderable` = the effective model could not be produced; `never-run` =
 * no run is stored yet. Otherwise the value is the highest finding severity.
 */
export type PreflightStatus = 'never-run' | 'pass' | 'unrenderable' | PreflightSeverity;

/** A single deterministic finding. Never carries an environment value. */
export interface PreflightFinding {
  ruleId: string;
  severity: PreflightSeverity;
  /** Short headline: what Sencho detected. */
  title: string;
  /** Why it matters. */
  message: string;
  /** Where it came from (service name, top-level key, or host path). */
  sourcePath?: string;
  /** Suggested fix. */
  remediation?: string;
  /** Service the finding is scoped to, when applicable. */
  service?: string;
}

/** The full report returned by both the GET (latest) and POST (run) routes. */
export interface PreflightReport {
  stack: string;
  /** Epoch ms of the run, or null when never run. */
  ranAt: number | null;
  ranBy: string | null;
  renderable: boolean;
  /** Redacted, truncated render error when `renderable` is false. */
  renderError: string | null;
  status: PreflightStatus;
  highestSeverity: PreflightSeverity | null;
  sourceHash: string | null;
  renderedHash: string | null;
  findings: PreflightFinding[];
}

/** A declared `env_file:` that is required and absent on disk (names only). */
export interface MissingEnvFile {
  rawPath: string;
  services: string[];
}

/** A host port bound by a running container on the target node. */
export interface NodePortBinding {
  publishedPort: number;
  protocol: string;
  /** '' / '0.0.0.0' / '::' means all interfaces. */
  ip: string;
  /** Resolved Sencho stack owning the binding, or null when unmanaged. */
  stack: string | null;
}

/** Pre-resolved existence/ownership of a single bind-mount source. */
export interface BindCheck {
  service: string;
  /** Absolute source path as rendered by `docker compose config`. */
  source: string;
  target: string;
  /** True when the source resolves inside the node's compose base dir. */
  withinBase: boolean;
  /** Existence is only probed for `withinBase` sources (others are unverifiable). */
  exists: boolean;
  /** File owner uid when statted on a POSIX host, else null. */
  ownerUid: number | null;
}

/**
 * Everything the pure rule functions need, computed once by the service so the
 * rules stay synchronous and individually testable. No field ever holds an
 * environment value.
 */
export interface PreflightContext {
  stackName: string;
  /** The node's platform, so POSIX-only rules can skip themselves on Windows. */
  platform: NodeJS.Platform;
  /** The rendered effective model, or null when it could not be produced. */
  model: EffectiveModel | null;
  renderable: boolean;
  /** Redacted + truncated render error, or null. */
  renderError: string | null;
  /** Variable names Compose reported as unset (defaulted to empty string). */
  unsetEnvVars: string[];
  /** Declared `env_file:` paths that are required but absent on disk (names only). */
  missingEnvFiles: MissingEnvFile[];
  /** Service names parsed from the literal source file (pre-render). */
  sourceServiceNames: string[];
  /** Whether the source file could be read; gates source-derived checks so an
   *  unreadable source cannot be mistaken for an empty one. */
  sourceReadable: boolean;
  nodePorts: NodePortBinding[];
  existingNetworkNames: Set<string>;
  existingVolumeNames: Set<string>;
  existingContainers: { name: string; stack: string | null }[];
  /** Whether the node's Docker snapshot was collected; gates node-state checks so
   *  an unavailable snapshot cannot be mistaken for an empty node. */
  nodeStateAvailable: boolean;
  bindChecks: BindCheck[];
  /** Stack-level exposure classification, or null when unset. */
  stackIntent: ExposureIntent | null;
  /** Per-service exposure overrides (a service falls back to stackIntent when absent). */
  serviceIntents: Record<string, ExposureIntent>;
  /** Host ports referenced by the dossier's documented access URLs. */
  accessUrlPorts: Set<number>;
  /** Whether the dossier records any access URL (gates the port-vs-documented rule). */
  hasAccessUrls: boolean;
}
