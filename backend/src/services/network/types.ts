/**
 * Types for the Compose Network Inspector: the structural networking facts a
 * Community user can read for a stack, derived from the rendered effective model
 * and the live Docker snapshot. Like the preflight model, these facts never
 * carry an environment value or a label value.
 */

/** Valid exposure-intent values (stored separately from these facts). The
 *  union is derived from this array so the two cannot drift; the frontend
 *  mirrors the same set. */
export const EXPOSURE_INTENTS = [
  'internal', 'same-node', 'lan', 'reverse-proxy', 'public', 'temporary', 'unknown',
] as const;

export type ExposureIntent = typeof EXPOSURE_INTENTS[number];

/** A top-level network declared by the stack's effective model. */
export interface NetworkFactNetwork {
  /** Compose network key. */
  key: string;
  /** Resolved docker network name. */
  name: string;
  external: boolean;
  internal: boolean;
  /** True when deploying this stack creates the network (not external, not the implicit default). */
  createdByStack: boolean;
}

/** A host-published port of a service. */
export interface NetworkFactPort {
  /** '' / '0.0.0.0' / '::' means all interfaces. */
  hostIp: string;
  startPort: number;
  endPort: number;
  protocol: string;
  /** Bound on every interface (broad exposure). */
  allInterfaces: boolean;
  /** Bound only to loopback (127.0.0.1 / ::1). */
  loopbackOnly: boolean;
}

/** One service's networking facts. */
export interface NetworkFactService {
  name: string;
  /** Network membership by network key, with aliases. */
  networks: { key: string; aliases: string[] }[];
  publishedPorts: NetworkFactPort[];
  networkMode?: string;
  extraHosts: string[];
}

/** Runtime-vs-Compose disagreements, computed only when the runtime is available. */
export interface NetworkDriftFacts {
  /** Running container attached to a stack-owned network not declared in Compose. */
  runtimeOnlyAttachments: { container: string; service: string | null; network: string }[];
  /** Declared network (non-external, non-default) that no running service uses. */
  declaredButUnused: string[];
  /** Declared network whose runtime network does not exist. */
  missingFromRuntime: string[];
  /** Running container attached to a network owned by another stack or unmanaged. */
  foreignNetworkAttachments: { container: string; network: string }[];
}

export type NetworkRuntimeState = 'available' | 'unavailable';

/**
 * The full per-stack networking facts payload returned by GET /:stackName/networking.
 * Kept a flat DTO (the frontend mirrors it) rather than a discriminated union;
 * the pairing invariants are enforced by the single producer
 * (`assembleStackNetworkFacts`), not by the type: when `renderable` is false,
 * `renderError` is set and `networks`/`services`/`drift` are empty; when
 * `runtime` is `'unavailable'`, `drift` is empty (never computed against an
 * absent snapshot).
 */
export interface StackNetworkFacts {
  stack: string;
  /** True when the effective model rendered; false carries only a redacted, structural error. */
  renderable: boolean;
  /** Redacted render error when not renderable; never raw docker stderr. */
  renderError: string | null;
  /** Whether the live Docker snapshot was available; drift is computed only when 'available'. */
  runtime: NetworkRuntimeState;
  networks: NetworkFactNetwork[];
  services: NetworkFactService[];
  drift: NetworkDriftFacts;
}
