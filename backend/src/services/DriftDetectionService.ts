import DockerController from './DockerController';
import type { DependencyContainer, DependencyNetwork } from './DockerController';
import { FileSystemService } from './FileSystemService';
import { declaredFromEffectiveModel } from '../helpers/effectiveToDeclaredCompose';
import type { DeclaredCompose, DeclaredService } from '../helpers/composeDependencyParse';
import { parseMissingRequiredVars } from '../helpers/envVarParse';
import { parseEffectiveModel } from './preflight/effectiveModel';
import {
  compareStackNetworks,
  fromDeclaredCompose,
  type ManagedNetworkAttachmentPredicate,
} from './network/normalize';
import { resolveManagedMeshAttachment } from './network/managedMeshAttachment';
import { sanitizeForLog, redactSensitiveText } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { isCleanOneShotCompletion } from '../utils/oneShotCompletion';

const MAX_RENDER_ERROR = 600;

/**
 * Spatial drift engine: compares a stack's effective compose model (from
 * `docker compose config`) against the live Docker runtime and reports where
 * the two diverge. Read-only and stateless. It does NOT persist findings, track change-over-time, or compare
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
  | 'ports-mismatch'
  | 'network-undeclared'
  | 'network-missing';

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
  /** Every network on the node (for resolving foreign vs stack-owned attachments). */
  networks?: DependencyNetwork[];
  /** Authoritative runtime attachments that are intentionally absent from authored Compose. */
  managedNetworkAttachment?: ManagedNetworkAttachmentPredicate;
  /** Set when the compose file could not be parsed. */
  parseError?: string;
}

/** Add a network to a service's accumulated undeclared-attachment set. */
function addNetwork(map: Map<string, Set<string>>, service: string, network: string): void {
  let set = map.get(service);
  if (!set) {
    set = new Set();
    map.set(service, set);
  }
  set.add(network);
}

/**
 * Network-level drift: a service attached to a network not declared in compose
 * (stack-owned-undeclared or owned by another stack) is one finding per service;
 * declared networks that no running service uses or that are absent from the
 * runtime are one stack-level finding. Reuses the same comparison the Network
 * Inspector uses, so the two surfaces never disagree.
 */
function networkDriftFindings(
  stack: string,
  declared: DeclaredCompose,
  containers: DependencyContainer[],
  networks: DependencyNetwork[],
  managedNetworkAttachment?: ManagedNetworkAttachmentPredicate,
): StackDriftFinding[] {
  // Runtime resource names use the Compose project (top-level `name:` when set),
  // not the stack directory, so a stack with `name:` resolves its networks the
  // same way Docker does. Containers are still attributed to the stack directory.
  const normalized = fromDeclaredCompose(declared, declared.projectName ?? stack);
  const facts = compareStackNetworks(
    normalized,
    { containers, networks, volumes: [] },
    stack,
    managedNetworkAttachment,
  );
  const findings: StackDriftFinding[] = [];

  const serviceByContainer = new Map(containers.map(c => [c.name, c.service ?? c.name]));
  const undeclaredByService = new Map<string, Set<string>>();
  for (const a of facts.runtimeOnlyAttachments) addNetwork(undeclaredByService, a.service ?? a.container, a.network);
  for (const a of facts.foreignNetworkAttachments) addNetwork(undeclaredByService, serviceByContainer.get(a.container) ?? a.container, a.network);

  for (const [service, nets] of undeclaredByService) {
    const list = [...nets].sort();
    const joined = list.join(', ');
    findings.push({
      kind: 'network-undeclared',
      service,
      detail: `Service "${service}" is attached to ${list.length > 1 ? 'networks' : 'a network'} not declared in compose: ${joined}.`,
      actual: joined,
    });
  }

  // declaredButUnused holds compose keys; resolve them to runtime names so the
  // finding lists every missing network in one consistent namespace.
  const unusedNames = facts.declaredButUnused.map(key => normalized.networks[key]?.runtimeName ?? key);
  const missing = [...new Set([...unusedNames, ...facts.missingFromRuntime])].sort();
  if (missing.length > 0) {
    const joined = missing.join(', ');
    findings.push({
      kind: 'network-missing',
      service: '',
      detail: `Declared ${missing.length > 1 ? 'networks are' : 'network is'} unused by running services or absent from the runtime: ${joined}.`,
      expected: joined,
    });
  }

  return findings;
}

/**
 * Pure diff step (no Docker / FS access) so it is directly unit-testable.
 * Running/restarting containers drive image/port comparison. Clean one-shot
 * completions (exit 0 + explicit declared restart "no", including normalized
 * `deploy.restart_policy.condition: none`) satisfy service presence without
 * counting as hasContainers. Omitting restart does not qualify. Network
 * comparison still uses only running/restarting attachments.
 */
export function assembleStackDrift(input: AssembleStackDriftInput): StackDriftReport {
  const { stack, declared, containers, parseError } = input;
  const networks = input.networks ?? [];
  // Public contract: at least one running/restarting container (not "satisfied").
  const hasContainers = containers.some((c) => RUNNING_STATES.has(c.state));

  // A parse failure means the declared model is untrustworthy: report drift
  // rather than risk a false in-sync. hasContainers still reflects runtime.
  if (parseError) {
    return { stack, status: 'drifted', hasComposeFile: false, hasContainers, findings: [], parseError };
  }

  const declaredByName = new Map<string, DeclaredService>();
  for (const svc of declared.services) declaredByName.set(svc.name, svc);

  const runtimeByService = new Map<string, RuntimeService>();
  const oneShotSatisfied = new Set<string>();
  for (const c of containers) {
    const name = c.service ?? c.name;
    if (RUNNING_STATES.has(c.state)) {
      const agg = runtimeByService.get(name) ?? { images: new Set<string>(), ports: new Set<string>() };
      if (c.image) agg.images.add(normalizeImageRef(c.image));
      for (const p of c.ports) agg.ports.add(portKey(p.publishedPort, p.protocol));
      runtimeByService.set(name, agg);
      continue;
    }
    const declaredRestart = declaredByName.get(name)?.restart;
    if (isCleanOneShotCompletion({
      state: c.state,
      exitCode: c.exitCode,
      restartPolicy: declaredRestart,
    })) {
      oneShotSatisfied.add(name);
    }
  }

  const servicePresent = (serviceName: string): boolean =>
    runtimeByService.has(serviceName) || oneShotSatisfied.has(serviceName);

  // Nothing running and no declared service satisfied by a clean one-shot: the
  // stack is defined on disk but not deployed. One status conveys this.
  if (!hasContainers && !declared.services.some((svc) => servicePresent(svc.name))) {
    return { stack, status: 'missing-runtime', hasComposeFile: true, hasContainers: false, findings: [] };
  }

  const findings: StackDriftFinding[] = [];

  // Declared service with no running container and no clean one-shot completion.
  for (const svc of declared.services) {
    if (!servicePresent(svc.name)) {
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

  // Image / port divergence for services present on both sides (running only).
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

  findings.push(...networkDriftFindings(
    stack,
    declared,
    containers,
    networks,
    input.managedNetworkAttachment,
  ));

  const status: StackDriftStatus = findings.length > 0 ? 'drifted' : 'in-sync';
  return { stack, status, hasComposeFile: true, hasContainers, findings };
}

type RenderDeclaredResult =
  | { ok: true; declared: DeclaredCompose }
  | { ok: false; parseError: string };

async function renderDeclaredCompose(nodeId: number, stackName: string): Promise<RenderDeclaredResult> {
  try {
    const { ComposeService } = await import('./ComposeService');
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered === null) {
      const missing = parseMissingRequiredVars(result.stderr);
      return {
        ok: false,
        parseError: missing.length
          ? `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`
          : 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.',
      };
    }
    try {
      const model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
      return { ok: true, declared: declaredFromEffectiveModel(model) };
    } catch (parseErr) {
      console.warn('[Drift] Effective model parse failed for %s:',
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(parseErr, 'unknown')));
      return { ok: false, parseError: 'Sencho could not parse the rendered Compose model.' };
    }
  } catch (err) {
    console.error('[Drift] Effective model render failed for stack %s:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'render failed')));
    const message = redactSensitiveText(getErrorMessage(err, 'docker compose could not be started.'))
      .slice(0, MAX_RENDER_ERROR)
      .trim();
    return { ok: false, parseError: message || 'Sencho could not run docker compose on this node.' };
  }
}

/**
 * Builds the drift report for one stack on one node: renders the effective
 * compose model, takes a Docker snapshot, and diffs them. Fails closed at each
 * boundary: a render failure is reported as a parse error (drifted, never
 * in-sync), and a Docker failure is reported as 'unreachable' rather than crashing.
 */
export async function buildStackDriftReport(nodeId: number, stackName: string): Promise<StackDriftReport> {
  const fs = FileSystemService.getInstance(nodeId);
  const render = await renderDeclaredCompose(nodeId, stackName);

  if (!render.ok) {
    let hasContainers = false;
    try {
      const stacks = await fs.getStacks();
      const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
      hasContainers = snapshot.containers.some((c) => c.stack === stackName && RUNNING_STATES.has(c.state));
    } catch {
      // Docker unreachable: hasContainers stays false; render error is still the headline.
    }
    return {
      stack: stackName,
      status: 'drifted',
      hasComposeFile: false,
      hasContainers,
      findings: [],
      parseError: render.parseError,
    };
  }

  let containers: DependencyContainer[];
  let networks: DependencyNetwork[] = [];
  try {
    // The snapshot needs the full known-stacks set to resolve each container to
    // its stack; we then filter to this one. Do not narrow to [stackName] or
    // resolution breaks.
    const stacks = await fs.getStacks();
    const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
    containers = snapshot.containers.filter((c) => c.stack === stackName);
    networks = snapshot.networks;
  } catch (error) {
    console.error('[Drift] Docker snapshot failed for stack %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'snapshot failed')));
    return {
      stack: stackName,
      status: 'unreachable',
      hasComposeFile: true,
      hasContainers: false,
      findings: [],
    };
  }

  const managedNetworkAttachment = await resolveManagedMeshAttachment(nodeId, stackName);
  return assembleStackDrift({
    stack: stackName,
    declared: render.declared,
    containers,
    networks,
    managedNetworkAttachment,
  });
}
