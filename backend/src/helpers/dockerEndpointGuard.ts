import { parse as parseYaml } from 'yaml';
import DockerController from '../services/DockerController';
import SelfIdentityService from '../services/SelfIdentityService';
import { NodeRegistry } from '../services/NodeRegistry';
import {
  resolveDockerEndpointProvider,
  type DockerEndpointContainer,
} from '../services/DockerEndpointProvider';
import { getRuntimeContainerIdCandidates, matchesContainerId, workingDirMatchesStack } from './selfStackGuard';
import { getErrorMessage } from '../utils/errors';

/**
 * Fail-closed guard for lifecycle operations that would stop or recreate the
 * container carrying this node's Docker API: Sencho itself, or the socket proxy
 * Sencho reaches Docker through. Recreating the proxy cuts the connection the
 * operation is using, and the rollback that follows dies the same way, so the
 * operation is refused before it starts and the reason names the safe path.
 *
 * One evaluator, two call sites: the mutating Compose entry points
 * (`ComposeService`) and container stop/restart (`DockerController`). Scheduler,
 * webhook, GitOps, Blueprint, mesh, and bulk update all reach one of the two.
 */
export const DOCKER_ENDPOINT_PROTECTED_CODE = 'docker_endpoint_protected';

/** Label that marks a service as carrying this node's Docker connection when detection misses it. */
export const INFRASTRUCTURE_LABEL = 'io.sencho.infrastructure';

export type EndpointMutation =
  /** `compose up -d`: a protected service is refused only when it would be recreated. */
  | { kind: 'up' }
  /** Pull then `up -d`: a fresh image would recreate it, so a protected service is refused. */
  | { kind: 'update' }
  /** Stop, down, delete. */
  | { kind: 'stop' }
  /** Restart: the provider is refused, Sencho is not (restarting Sencho is the intended way to bounce it). */
  | { kind: 'restart' }
  /** A service-scoped operation: refused only when it targets a protected service. */
  | { kind: 'service'; service: string; restart?: boolean };

export type EndpointRefusalReason = 'sencho' | 'provider' | 'labeled' | 'invalid_label' | 'unresolved';

export interface DockerEndpointRefusal {
  reason: EndpointRefusalReason;
  service: string | null;
  message: string;
}

export class DockerEndpointProtectedError extends Error {
  readonly code = DOCKER_ENDPOINT_PROTECTED_CODE;
  readonly reason: EndpointRefusalReason;
  readonly service: string | null;

  constructor(refusal: DockerEndpointRefusal) {
    super(refusal.message);
    this.name = 'DockerEndpointProtectedError';
    this.reason = refusal.reason;
    this.service = refusal.service;
    Object.setPrototypeOf(this, DockerEndpointProtectedError.prototype);
  }
}

export function isDockerEndpointProtectedError(error: unknown): error is DockerEndpointProtectedError {
  return error instanceof DockerEndpointProtectedError;
}

type ListedContainer = {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
};

/** What the Compose layer supplies, so this module never imports `ComposeService`. */
export interface EndpointGuardProbes {
  /** Rendered `docker compose config` YAML for the stack, null when it cannot be rendered. */
  renderConfig(): Promise<string | null>;
  /** The config hash Compose would assign `service` now, null when it cannot be computed. */
  configHash(service: string): Promise<string | null>;
}

export interface EndpointGuardInput {
  nodeId: number;
  stackName: string;
  mutation: EndpointMutation;
  probes: EndpointGuardProbes;
}

type Protected = { containers: ListedContainer[]; role: 'sencho' | 'provider' | 'labeled' };

function serviceOf(container: ListedContainer): string | null {
  return container.Labels?.['com.docker.compose.service'] ?? null;
}

function isDockerUnavailable(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  const message = String(err?.message ?? '').toLowerCase();
  return err?.code === 'ECONNREFUSED'
    || (err?.code === 'ENOENT' && /docker\.sock/i.test(err.message ?? ''))
    || message.includes('econnrefused')
    || message.includes('cannot connect to the docker daemon');
}

/** Services whose label value is exactly "true" are marked; any other value is invalid. */
export function readInfrastructureLabels(renderedYaml: string): { marked: string[]; invalid: Array<{ service: string; value: string }> } {
  const marked: string[] = [];
  const invalid: Array<{ service: string; value: string }> = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(renderedYaml);
  } catch {
    return { marked, invalid };
  }
  const services = (parsed as { services?: Record<string, { labels?: unknown }> } | null)?.services;
  if (!services || typeof services !== 'object') return { marked, invalid };
  for (const [name, service] of Object.entries(services)) {
    const labels = service?.labels;
    let value: string | undefined;
    if (Array.isArray(labels)) {
      const entry = labels.find(item => typeof item === 'string' && item.startsWith(`${INFRASTRUCTURE_LABEL}=`));
      if (typeof entry === 'string') value = entry.slice(INFRASTRUCTURE_LABEL.length + 1);
    } else if (labels && typeof labels === 'object') {
      const raw = (labels as Record<string, unknown>)[INFRASTRUCTURE_LABEL];
      if (raw !== undefined && raw !== null) value = String(raw);
    }
    if (value === undefined) continue;
    if (value === 'true') marked.push(name);
    else invalid.push({ service: name, value });
  }
  return { marked, invalid };
}

const REAPPLY_PATH = 'Fleet -> Node Updates';

function refusalFor(role: Protected['role'], service: string, provider: DockerEndpointContainer | null, selfProject: string | null): DockerEndpointRefusal {
  if (role === 'sencho') {
    return {
      reason: 'sencho',
      service,
      message: `Service "${service}" is the running Sencho instance, and this operation would stop or recreate it. `
        + `Use Reapply in ${REAPPLY_PATH} to recreate Sencho from its current Compose configuration.`,
    };
  }
  const shared = provider?.project != null && provider.project === selfProject;
  const how = shared
    ? `Use Reapply in ${REAPPLY_PATH} to recreate Sencho's stack on purpose.`
    : 'Recreate it from the host (docker compose up -d) while Sencho is idle.';
  return {
    reason: role,
    service,
    message: `Service "${service}" carries the Docker connection Sencho is using, and this operation would stop or recreate it. `
      + `Sencho would lose its Docker API mid-operation and its rollback could not reach Docker. ${how}`,
  };
}

/** The stack's containers (running or stopped), matched by project name or working directory. */
async function listStackContainers(nodeId: number, stackName: string): Promise<ListedContainer[]> {
  const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
  const all = await DockerController.getInstance(nodeId).getDocker().listContainers({ all: true }) as ListedContainer[];
  return all.filter(container => {
    const labels = container.Labels ?? {};
    return labels['com.docker.compose.project'] === stackName
      || workingDirMatchesStack(labels['com.docker.compose.project.working_dir'], stackName, composeDir);
  });
}

async function wouldRecreate(
  input: EndpointGuardInput,
  stackContainers: ListedContainer[],
  service: string,
): Promise<boolean> {
  const hash = await input.probes.configHash(service);
  if (!hash) return true;
  const running = stackContainers.filter(container => serviceOf(container) === service);
  if (running.length === 0) return false;
  return running.some(container => container.Labels?.['com.docker.compose.config-hash'] !== hash);
}

/**
 * Returns the refusal for a mutation that would stop or recreate the container
 * carrying this node's Docker API, or null when the mutation may run. Remote
 * nodes are never evaluated: their lifecycle is proxied to their own Sencho.
 */
export async function evaluateDockerEndpointGuard(input: EndpointGuardInput): Promise<DockerEndpointRefusal | null> {
  const { nodeId, stackName, mutation } = input;
  if (NodeRegistry.getInstance().getNode(nodeId)?.type === 'remote') return null;

  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  const provider = await resolveDockerEndpointProvider();
  const providerContainer = provider.state === 'resolved' ? provider.provider : null;
  if (provider.state === 'unresolved') {
    console.warn('[DockerEndpointGuard] Docker endpoint provider unresolved; continuing without it:', provider.reason);
  }

  let stackContainers: ListedContainer[];
  try {
    stackContainers = await listStackContainers(nodeId, stackName);
  } catch (error) {
    // With Docker unreachable the operation fails by itself with its own error.
    if (isDockerUnavailable(error)) return null;
    return {
      reason: 'unresolved',
      service: null,
      message: `Sencho could not list the containers of "${stackName}" (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether this operation would stop the container that carries its Docker connection.`,
    };
  }
  // Nothing exists yet, so nothing can be stopped.
  if (stackContainers.length === 0) return null;

  const found: Protected[] = [];
  const selfContainers = stackContainers.filter(c => typeof c.Id === 'string' && self.isOwnContainer(c.Id));
  if (selfContainers.length > 0) found.push({ containers: selfContainers, role: 'sencho' });
  const providerContainers = providerContainer
    ? stackContainers.filter(c => c.Id === providerContainer.containerId)
    : [];
  if (providerContainers.length > 0) found.push({ containers: providerContainers, role: 'provider' });

  if (selfState === 'unresolved') {
    const candidates = await getRuntimeContainerIdCandidates();
    const mayBeSelf = candidates.length === 0
      || stackContainers.some(c => typeof c.Id === 'string' && candidates.some(id => matchesContainerId(c.Id as string, id)));
    if (mayBeSelf) {
      return {
        reason: 'unresolved',
        service: null,
        message: `Sencho could not identify its own container (${self.getUnresolvedReason() ?? 'Docker did not answer'}), so it cannot tell whether "${stackName}" is the stack it runs in. `
          + 'Check that the Docker endpoint allows container inspect requests, then retry.',
      };
    }
  }

  let labeled: Protected | null = null;
  try {
    const rendered = await input.probes.renderConfig();
    if (rendered) {
      const labels = readInfrastructureLabels(rendered);
      if (labels.invalid.length > 0) {
        const bad = labels.invalid[0];
        return {
          reason: 'invalid_label',
          service: bad.service,
          message: `Service "${bad.service}" sets ${INFRASTRUCTURE_LABEL} to "${bad.value}". The only accepted value is "true"; fix the label before this stack is changed.`,
        };
      }
      const labeledContainers = stackContainers.filter(c => {
        const service = serviceOf(c);
        return service !== null && labels.marked.includes(service);
      });
      if (labeledContainers.length > 0) labeled = { containers: labeledContainers, role: 'labeled' };
    }
  } catch (error) {
    console.warn('[DockerEndpointGuard] Could not read %s labels for %s:', INFRASTRUCTURE_LABEL, stackName, getErrorMessage(error, 'render failed'));
  }
  if (labeled) found.push(labeled);

  const selfProject = selfContainers[0]?.Labels?.['com.docker.compose.project'] ?? null;
  for (const entry of found) {
    const services = [...new Set(entry.containers.map(serviceOf).filter((s): s is string => s !== null))];
    for (const service of services) {
      if (mutation.kind === 'service' && mutation.service !== service) continue;
      const restartsSelf = mutation.kind === 'restart' || (mutation.kind === 'service' && mutation.restart === true);
      if (restartsSelf && entry.role === 'sencho') continue;
      if (mutation.kind === 'up' && !(await wouldRecreate(input, stackContainers, service))) continue;
      return refusalFor(entry.role === 'labeled' ? 'provider' : entry.role, service, providerContainer, selfProject);
    }
  }
  return null;
}

/**
 * Container-level guard for stop and restart. The provider container is always
 * refused; the Sencho container is refused on stop only (a restart brings it
 * back, which is the one intended way to bounce Sencho).
 */
export async function evaluateDockerEndpointContainer(
  containerId: string,
  action: 'stop' | 'restart',
): Promise<DockerEndpointRefusal | null> {
  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  const provider = await resolveDockerEndpointProvider();

  if (provider.state === 'resolved' && matchesContainerId(provider.provider.containerId, containerId)) {
    return refusalFor('provider', provider.provider.service ?? provider.provider.containerName, provider.provider, self.getIdentity().composeProjectName);
  }
  if (action !== 'stop') return null;

  let isSelf = self.isOwnContainer(containerId);
  if (!isSelf && selfState === 'unresolved') {
    const candidates = await getRuntimeContainerIdCandidates();
    isSelf = candidates.some(id => matchesContainerId(containerId, id));
  }
  if (!isSelf) return null;
  return refusalFor('sencho', self.getComposeLocation().service ?? 'sencho', null, null);
}
