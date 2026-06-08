import DockerController from './DockerController';
import type { DependencyContainer } from './DockerController';
import { FileSystemService } from './FileSystemService';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import type { DeclaredCompose, DeclaredService } from '../helpers/composeDependencyParse';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';

/**
 * Spatial drift engine: compares a stack's on-disk compose model against the
 * live Docker runtime and reports where the two diverge. Read-only and
 * stateless. It does NOT persist findings, track change-over-time, or compare
 * against a last-applied hash: temporal drift ("the file changed since you
 * deployed"), env-key/value comparison, the cross-fleet rollup, and
 * unknown-source (orphan containers with no on-disk stack) belong to the
 * persistence-backed Drift Ledger that builds on this engine. The pure
 * assembleStackDrift step is exported so that layer can call it per stack.
 */

/** High-level alignment of a stack's runtime against its compose source. */
export type StackDriftStatus = 'in-sync' | 'drifted' | 'missing-runtime' | 'unreachable';

/** A specific, service-scoped reason a stack is drifted. */
export type DriftFindingKind =
  | 'service-missing'
  | 'service-undeclared'
  | 'image-mismatch'
  | 'ports-mismatch';

export interface StackDriftFinding {
  kind: DriftFindingKind;
  /** Compose service (or runtime service identity) the finding applies to. */
  service: string;
  /** Specific, actionable description of the divergence. */
  detail: string;
  /** Declared/expected value, when the finding compares two values. */
  expected?: string;
  /** Observed runtime value, when the finding compares two values. */
  actual?: string;
}

export interface StackDriftReport {
  stack: string;
  status: StackDriftStatus;
  /** True when a parseable compose file is present (false on a parse failure). */
  hasComposeFile: boolean;
  /** True when the stack has at least one running container. */
  hasContainers: boolean;
  findings: StackDriftFinding[];
  /** Set when the compose file could not be parsed; status is then 'drifted'. */
  parseError?: string;
}

// Container states that count as actually deployed. 'restarting' is included
// deliberately: a crash-looping container is still the live deployment attempt,
// so excluding it would falsely read the stack as missing-runtime.
const RUNNING_STATES = new Set(['running', 'restarting']);

/**
 * Normalizes an image reference so equivalent forms compare equal: the implicit
 * Docker Hub registry (`docker.io/`, plus its `library/` namespace for official
 * images) is stripped and a missing tag defaults to `:latest`. A digest-pinned
 * reference is left intact, so a digest runtime vs a tag-only declaration reads
 * as a mismatch. That is intentional: the engine prefers reporting an actionable
 * difference over hiding one, and never reports a false in-sync.
 */
export function normalizeImageRef(ref: string): string {
  let s = ref.trim();
  if (!s) return s;
  if (s.startsWith('docker.io/')) {
    s = s.slice('docker.io/'.length);
    if (s.startsWith('library/')) s = s.slice('library/'.length);
  }
  if (s.includes('@')) return s; // digest-pinned: an exact ref, no :latest defaulting applies
  const lastSlash = s.lastIndexOf('/');
  const lastColon = s.lastIndexOf(':');
  const hasTag = lastColon > lastSlash; // a ':' after the last '/' is the tag
  return hasTag ? s : `${s}:latest`;
}

const portKey = (publishedPort: number, protocol: string): string => `${publishedPort}/${protocol}`;

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function formatPorts(ports: Set<string>): string {
  return ports.size ? [...ports].sort().join(', ') : 'none';
}

/** Runtime aggregate for one service across its (possibly replicated) containers. */
interface RuntimeService {
  images: Set<string>;
  ports: Set<string>;
}

export interface AssembleStackDriftInput {
  stack: string;
  declared: DeclaredCompose;
  /** All runtime containers belonging to this stack (any state). */
  containers: DependencyContainer[];
  /** Set when the compose file could not be parsed. */
  parseError?: string;
}

/**
 * Pure diff step (no Docker / FS access) so it is directly unit-testable. Only
 * running containers are compared, since a stopped container publishes no ports
 * and is not "deployed": a declared service with no running container is
 * service-missing, a running container with no matching service is
 * service-undeclared, and image / port differences are checked only for services
 * present on both sides so a missing/undeclared service is not double-reported.
 */
export function assembleStackDrift(input: AssembleStackDriftInput): StackDriftReport {
  const { stack, declared, containers, parseError } = input;
  const hasContainers = containers.some((c) => RUNNING_STATES.has(c.state));

  // A parse failure means the declared model is untrustworthy: report drift
  // rather than risk a false in-sync. hasContainers still reflects runtime.
  if (parseError) {
    return { stack, status: 'drifted', hasComposeFile: false, hasContainers, findings: [], parseError };
  }

  const runtimeByService = new Map<string, RuntimeService>();
  for (const c of containers) {
    if (!RUNNING_STATES.has(c.state)) continue;
    const name = c.service ?? c.name;
    const agg = runtimeByService.get(name) ?? { images: new Set<string>(), ports: new Set<string>() };
    if (c.image) agg.images.add(normalizeImageRef(c.image));
    for (const p of c.ports) agg.ports.add(portKey(p.publishedPort, p.protocol));
    runtimeByService.set(name, agg);
  }

  // Nothing running: the stack is defined on disk but not deployed. One status
  // conveys this; per-service findings would just be noise.
  if (!hasContainers) {
    return { stack, status: 'missing-runtime', hasComposeFile: true, hasContainers: false, findings: [] };
  }

  const declaredByName = new Map<string, DeclaredService>();
  for (const svc of declared.services) declaredByName.set(svc.name, svc);

  const findings: StackDriftFinding[] = [];

  // Declared service with no running container.
  for (const svc of declared.services) {
    if (!runtimeByService.has(svc.name)) {
      findings.push({
        kind: 'service-missing',
        service: svc.name,
        detail: `Service "${svc.name}" is declared in compose but is not running.`,
      });
    }
  }

  // Running container with no matching declared service.
  for (const name of runtimeByService.keys()) {
    if (!declaredByName.has(name)) {
      findings.push({
        kind: 'service-undeclared',
        service: name,
        detail: `Service "${name}" is running but is not declared in compose.`,
      });
    }
  }

  // Image / port divergence for services present on both sides.
  for (const [name, svc] of declaredByName) {
    const runtime = runtimeByService.get(name);
    if (!runtime) continue;

    if (svc.image && runtime.images.size > 0) {
      const declaredImage = normalizeImageRef(svc.image);
      const runtimeImages = [...runtime.images];
      // Any running image that differs from the declared one is drift, so a
      // replica left on an old image is caught even when a sibling matches.
      if (runtimeImages.some((img) => img !== declaredImage)) {
        findings.push({
          kind: 'image-mismatch',
          service: name,
          detail: `Service "${name}" runs a different image than compose declares.`,
          expected: declaredImage,
          actual: runtimeImages.sort().join(', '),
        });
      }
    }

    // Ports compare as exact sets. The compose parser collapses a published
    // range (e.g. "8000-8002:80") to its first port, while the runtime reports
    // every port in the range, so a range can read as a mismatch. That errs
    // toward reporting drift rather than hiding it, consistent with the engine's
    // philosophy.
    const declaredPorts = new Set(svc.ports.map((p) => portKey(p.publishedPort, p.protocol)));
    if (!setsEqual(declaredPorts, runtime.ports)) {
      findings.push({
        kind: 'ports-mismatch',
        service: name,
        detail: `Service "${name}" publishes different ports than compose declares.`,
        expected: formatPorts(declaredPorts),
        actual: formatPorts(runtime.ports),
      });
    }
  }

  const status: StackDriftStatus = findings.length > 0 ? 'drifted' : 'in-sync';
  return { stack, status, hasComposeFile: true, hasContainers, findings };
}

/**
 * Builds the drift report for one stack on one node: reads the compose file,
 * takes a Docker snapshot, and diffs them. Fails closed at each boundary: a
 * compose read failure is reported as a parse error (drifted, never in-sync),
 * and a Docker failure is reported as 'unreachable' rather than crashing.
 */
export async function buildStackDriftReport(nodeId: number, stackName: string): Promise<StackDriftReport> {
  const fs = FileSystemService.getInstance(nodeId);

  let content: string;
  try {
    content = await fs.getStackContent(stackName);
  } catch (error) {
    console.error('[Drift] Failed to read compose for stack %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'read failed')));
    return {
      stack: stackName,
      status: 'drifted',
      hasComposeFile: false,
      hasContainers: false,
      findings: [],
      parseError: getErrorMessage(error, 'Failed to read compose file'),
    };
  }

  const declared = parseComposeDependencies(content);

  let containers: DependencyContainer[];
  try {
    // The snapshot needs the full known-stacks set to resolve each container to
    // its stack; we then filter to this one. Do not narrow to [stackName] or
    // resolution breaks.
    const stacks = await fs.getStacks();
    const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
    containers = snapshot.containers.filter((c) => c.stack === stackName);
  } catch (error) {
    // Docker is unreachable, so runtime drift cannot be assessed. The headline
    // failure is reachability; a separate parse error (if any) surfaces as
    // drifted once Docker is back, keeping the parseError-implies-drifted invariant.
    console.error('[Drift] Docker snapshot failed for stack %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'snapshot failed')));
    return {
      stack: stackName,
      status: 'unreachable',
      hasComposeFile: !declared.parseError,
      hasContainers: false,
      findings: [],
    };
  }

  return assembleStackDrift({ stack: stackName, declared, containers, parseError: declared.parseError });
}
