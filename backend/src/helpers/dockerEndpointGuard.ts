import { parse as parseYaml } from 'yaml';
import DockerController from '../services/DockerController';
import SelfIdentityService from '../services/SelfIdentityService';
import { NodeRegistry } from '../services/NodeRegistry';
import {
  resolveDockerEndpointProvider,
  type DockerEndpointContainer,
  type DockerEndpointProvider,
} from '../services/DockerEndpointProvider';
import { getRuntimeContainerIdCandidates, matchesContainerId, workingDirMatchesStack } from './selfStackGuard';
import { getErrorMessage } from '../utils/errors';

/**
 * Guard for lifecycle operations that would stop or recreate the container
 * carrying this node's Docker API: Sencho itself, or the socket proxy Sencho
 * reaches Docker through. Recreating the proxy cuts the connection the
 * operation is using, and the rollback that follows dies the same way, so the
 * operation is refused before it starts and the reason names the safe path.
 *
 * It refuses when the provider or Sencho's own identity cannot be resolved
 * (for the stacks that could hold the provider), when a container list or
 * inspect fails, and when Compose's recreate decision cannot be predicted. It
 * lets an operation through only when Docker is unreachable (the operation then
 * fails by itself with its own error) or the stack provably holds neither.
 *
 * One evaluator, two call sites: the mutating Compose entry points
 * (`ComposeService`) and container stop/restart/removal (`DockerController`).
 * Scheduler, webhook, GitOps, Blueprint, mesh, and bulk update all reach one of
 * the two.
 */
export const DOCKER_ENDPOINT_PROTECTED_CODE = 'docker_endpoint_protected';

/** Label that marks a service as carrying this node's Docker connection when detection misses it. */
export const INFRASTRUCTURE_LABEL = 'io.sencho.infrastructure';

export type EndpointMutation =
  /**
   * `compose up -d`: a protected service is refused only when it would be
   * recreated. `pinnedServices` are the services a digest-pin overlay rewrites
   * the image of, which the config hash does not see.
   */
  | { kind: 'up'; pinnedServices?: readonly string[] }
  /** Pull then `up -d`: a fresh image would recreate it, so a protected service is refused. */
  | { kind: 'update' }
  /** Stop, down, delete. */
  | { kind: 'stop' }
  /** Restart: the provider is refused, Sencho is not (restarting Sencho is the intended way to bounce it). */
  | { kind: 'restart' }
  /** A service-scoped operation: refused only when it targets a protected service. */
  | { kind: 'service'; service: string; restart?: boolean };

export type EndpointRefusalReason = 'sencho' | 'provider' | 'invalid_label' | 'unresolved';

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
  ImageID?: string;
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string } | null> };
};

/** The local image behind a reference: its id, or unknown when it cannot be inspected. */
export type LocalImageLookup = { state: 'id'; id: string } | { state: 'unknown' };

/** What the Compose layer supplies, so this module never imports `ComposeService`. */
export interface EndpointGuardProbes {
  /** Rendered `docker compose config` YAML for the stack, null when it cannot be rendered. */
  renderConfig(): Promise<string | null>;
  /** The config hash Compose would assign `service` now, null when it cannot be computed. */
  configHash(service: string): Promise<string | null>;
  /** The local image id behind `imageRef`; Compose recreates a service whose image id changed. */
  localImage(imageRef: string): Promise<LocalImageLookup>;
}

export interface EndpointGuardInput {
  nodeId: number;
  stackName: string;
  mutation: EndpointMutation;
  probes: EndpointGuardProbes;
}

type ProtectedRole = 'sencho' | 'provider' | 'unknown_provider';
type Protected = { containers: ListedContainer[]; role: ProtectedRole };

/** What Sencho knows about the provider after resolution. */
type ProviderView =
  | { state: 'resolved'; provider: DockerEndpointContainer }
  | { state: 'unresolved'; reason: string }
  | { state: 'none' };

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

type RenderedService = { infrastructure: string | undefined; image: string | undefined };

/** The label value and image of every service in rendered Compose YAML. Throws on YAML that does not parse. */
function readRenderedServices(renderedYaml: string): Map<string, RenderedService> {
  const out = new Map<string, RenderedService>();
  const parsed = parseYaml(renderedYaml) as { services?: Record<string, { labels?: unknown; image?: unknown }> } | null;
  const services = parsed?.services;
  if (!services || typeof services !== 'object') return out;
  for (const [name, service] of Object.entries(services)) {
    const labels = service?.labels;
    let infrastructure: string | undefined;
    if (Array.isArray(labels)) {
      const entry = labels.find(item => typeof item === 'string' && item.startsWith(`${INFRASTRUCTURE_LABEL}=`));
      if (typeof entry === 'string') infrastructure = entry.slice(INFRASTRUCTURE_LABEL.length + 1);
    } else if (labels && typeof labels === 'object') {
      const raw = (labels as Record<string, unknown>)[INFRASTRUCTURE_LABEL];
      if (raw !== undefined && raw !== null) infrastructure = String(raw);
    }
    out.set(name, { infrastructure, image: typeof service?.image === 'string' ? service.image : undefined });
  }
  return out;
}

/** Services whose label value is exactly "true" are marked; any other value is invalid. */
export function readInfrastructureLabels(renderedYaml: string): { marked: string[]; invalid: Array<{ service: string; value: string }> } {
  const marked: string[] = [];
  const invalid: Array<{ service: string; value: string }> = [];
  for (const [name, service] of readRenderedServices(renderedYaml)) {
    if (service.infrastructure === undefined) continue;
    if (service.infrastructure === 'true') marked.push(name);
    else invalid.push({ service: name, value: service.infrastructure });
  }
  return { marked, invalid };
}

const REAPPLY_PATH = 'Fleet -> Node Updates';

function invalidLabelRefusal(service: string, value: string): DockerEndpointRefusal {
  return {
    reason: 'invalid_label',
    service,
    message: `Service "${service}" sets ${INFRASTRUCTURE_LABEL} to "${value}". The only accepted value is "true"; fix the label before this stack is changed.`,
  };
}

function refusalFor(
  role: ProtectedRole,
  service: string,
  provider: DockerEndpointContainer | null,
  selfProject: string | null,
  providerUnresolvedReason: string | null = null,
): DockerEndpointRefusal {
  if (role === 'sencho') {
    return {
      reason: 'sencho',
      service,
      message: `Service "${service}" is the running Sencho instance, and this operation would stop or recreate it. `
        + `Use Reapply in ${REAPPLY_PATH} to recreate Sencho from its current Compose configuration.`,
    };
  }
  if (role === 'unknown_provider') {
    return {
      reason: 'unresolved',
      service,
      message: `Sencho could not determine which container carries its Docker connection (${providerUnresolvedReason ?? 'Docker did not answer'}), `
        + `so it cannot tell whether this operation would stop or recreate service "${service}", which shares a network with Sencho. `
        + 'Check that the Docker endpoint allows container list and inspect requests, then retry.',
    };
  }
  const shared = provider?.project != null && provider.project === selfProject;
  const how = shared
    ? 'It is in the same Compose project as Sencho: recreate it from the host (docker compose up -d) while Sencho is idle.'
    : 'Recreate it from the host (docker compose up -d) while Sencho is idle.';
  return {
    reason: 'provider',
    service,
    message: `Service "${service}" carries the Docker connection Sencho is using, and this operation would stop or recreate it. `
      + `Sencho would lose its Docker API mid-operation and its rollback could not reach Docker. ${how}`,
  };
}

function unknownRecreateRefusal(service: string): DockerEndpointRefusal {
  return {
    reason: 'unresolved',
    service,
    message: `Sencho could not tell whether this operation would recreate service "${service}", which carries its Docker connection `
      + '(Compose did not report its configuration hash, or its image could not be inspected). It is refused rather than guessed; '
      + 'recreate the service from the host (docker compose up -d) while Sencho is idle.',
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

/**
 * The provider's container is matched by id and by Compose project and service,
 * because a recreate gives the provider a new id while the cached answer still
 * names the old one.
 */
function isProviderContainer(
  container: { Id?: string; Labels?: Record<string, string> },
  provider: DockerEndpointContainer,
): boolean {
  if (container.Id && container.Id === provider.containerId) return true;
  if (provider.project === null || provider.service === null) return false;
  return container.Labels?.['com.docker.compose.project'] === provider.project
    && container.Labels?.['com.docker.compose.service'] === provider.service;
}

function sharesSenchoNetwork(
  networks: Record<string, { NetworkID?: string } | null> | undefined,
  self: SelfIdentityService,
): boolean {
  return Object.entries(networks ?? {}).some(([name, network]) =>
    self.isOwnNetwork(name) || (!!network?.NetworkID && self.isOwnNetwork(network.NetworkID)));
}

type Recreate = 'yes' | 'no' | 'unknown';

/**
 * Whether `compose up -d` would recreate `service`: a different config hash, a
 * different local image id behind its tag (a pull that landed outside Sencho),
 * or a digest-pin overlay rewriting its image all do.
 */
async function wouldRecreate(
  input: EndpointGuardInput,
  stackContainers: ListedContainer[],
  service: string,
  renderedImage: string | undefined,
): Promise<Recreate> {
  const mutation = input.mutation;
  if (mutation.kind === 'up' && mutation.pinnedServices?.includes(service)) return 'yes';
  const hash = await input.probes.configHash(service);
  if (!hash) return 'unknown';
  const running = stackContainers.filter(container => serviceOf(container) === service);
  if (running.length === 0) return 'no';
  if (running.some(container => container.Labels?.['com.docker.compose.config-hash'] !== hash)) return 'yes';
  if (renderedImage) {
    const image = await input.probes.localImage(renderedImage);
    if (image.state === 'unknown') return 'unknown';
    const wanted = image.id.replace(/^sha256:/, '');
    if (running.some(container => (container.ImageID ?? '').replace(/^sha256:/, '') !== wanted)) return 'yes';
  }
  return 'no';
}

function viewOf(provider: DockerEndpointProvider): ProviderView {
  switch (provider.state) {
    case 'resolved': return { state: 'resolved', provider: provider.provider };
    case 'unresolved': return { state: 'unresolved', reason: provider.reason };
    case 'none': return { state: 'none' };
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled Docker endpoint provider state: ${JSON.stringify(unreachable)}`);
    }
  }
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
  const provider = viewOf(await resolveDockerEndpointProvider());

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
  const providerContainers = provider.state === 'resolved'
    ? stackContainers.filter(c => isProviderContainer(c, provider.provider))
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

  // The provider could not be told apart: every container that shares a network
  // with Sencho (every container when Sencho's own networks are unknown) might
  // be the one carrying the Docker connection.
  if (provider.state === 'unresolved') {
    const maybeProvider = stackContainers.filter(c =>
      !selfContainers.includes(c)
      && (selfState !== 'resolved' || sharesSenchoNetwork(c.NetworkSettings?.Networks, self)));
    if (maybeProvider.length > 0) found.push({ containers: maybeProvider, role: 'unknown_provider' });
  }

  // The label is read from the running containers (what is actually deployed)
  // and from the rendered file (what the next deploy would deploy), so removing
  // it from the file does not unprotect a container that still carries it.
  const rendered = await readRendered(input.probes);
  for (const container of stackContainers) {
    const value = container.Labels?.[INFRASTRUCTURE_LABEL];
    const service = serviceOf(container);
    if (value !== undefined && value !== 'true' && service) return invalidLabelRefusal(service, value);
  }
  for (const [service, view] of rendered) {
    if (view.infrastructure !== undefined && view.infrastructure !== 'true') return invalidLabelRefusal(service, view.infrastructure);
  }
  const labeledContainers = stackContainers.filter(c => {
    const service = serviceOf(c);
    return c.Labels?.[INFRASTRUCTURE_LABEL] === 'true' || (service !== null && rendered.get(service)?.infrastructure === 'true');
  });
  const alreadyProvider = new Set(found.filter(f => f.role === 'provider').flatMap(f => f.containers));
  const labeledOnly = labeledContainers.filter(c => !alreadyProvider.has(c));
  if (labeledOnly.length > 0) found.push({ containers: labeledOnly, role: 'provider' });

  const selfProject = selfContainers[0]?.Labels?.['com.docker.compose.project'] ?? null;
  const providerInfo = provider.state === 'resolved' ? provider.provider : null;
  const providerReason = provider.state === 'unresolved' ? provider.reason : null;
  const seen = new Set<string>();
  for (const entry of found) {
    const services = [...new Set(entry.containers.map(serviceOf).filter((s): s is string => s !== null))];
    for (const service of services) {
      if (mutation.kind === 'service' && mutation.service !== service) continue;
      const restartsSelf = mutation.kind === 'restart' || (mutation.kind === 'service' && mutation.restart === true);
      if (restartsSelf && entry.role === 'sencho') continue;
      if (mutation.kind === 'up') {
        const recreate = await wouldRecreate(input, stackContainers, service, rendered.get(service)?.image);
        if (recreate === 'no') continue;
        if (recreate === 'unknown') return unknownRecreateRefusal(service);
      }
      const key = `${entry.role}:${service}`;
      if (seen.has(key)) continue;
      seen.add(key);
      return refusalFor(entry.role, service, providerInfo, selfProject, providerReason);
    }
  }
  return null;
}

/** The rendered services, empty when the stack cannot be rendered (the Compose operation then fails by itself). */
async function readRendered(probes: EndpointGuardProbes): Promise<Map<string, RenderedService>> {
  try {
    const rendered = await probes.renderConfig();
    if (rendered) return readRenderedServices(rendered);
    console.warn('[DockerEndpointGuard] Compose config could not be rendered; %s is read from running containers only', INFRASTRUCTURE_LABEL);
  } catch (error) {
    console.warn('[DockerEndpointGuard] Could not read %s from the Compose config:', INFRASTRUCTURE_LABEL, getErrorMessage(error, 'render failed'));
  }
  return new Map();
}

type InspectedContainer = {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string } | null> };
};

export interface InspectsContainers {
  getContainer(id: string): { inspect(): Promise<unknown> };
}

/**
 * Container-level guard for stop, restart, and removal. It mirrors the stack
 * level: the provider (by id, by Compose service, or by label) is always
 * refused; a container that may be the provider when it cannot be told apart is
 * refused; the Sencho container is refused on stop and removal only (a restart
 * brings it back, which is the one intended way to bounce Sencho).
 */
export async function evaluateDockerEndpointContainer(
  containerId: string,
  action: 'stop' | 'restart',
  docker: InspectsContainers = DockerController.getInstance().getDocker(),
): Promise<DockerEndpointRefusal | null> {
  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  const provider = viewOf(await resolveDockerEndpointProvider());

  let info: InspectedContainer;
  try {
    info = await docker.getContainer(containerId).inspect() as InspectedContainer;
  } catch (error) {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    // No such container, or Docker unreachable: the operation fails by itself.
    if (status === 404 || isDockerUnavailable(error)) return null;
    return {
      reason: 'unresolved',
      service: null,
      message: `Sencho could not inspect container "${containerId}" (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether this operation would stop the container that carries its Docker connection.`,
    };
  }

  const fullId = info.Id ?? containerId;
  const labels = info.Config?.Labels ?? {};
  const service = labels['com.docker.compose.service'] || (info.Name ?? '').replace(/^\//, '') || containerId;
  const selfProject = self.getIdentity().composeProjectName;
  const subject = { Id: fullId, Labels: labels };

  if (provider.state === 'resolved' && isProviderContainer(subject, provider.provider)) {
    return refusalFor('provider', service, provider.provider, selfProject);
  }
  const labelValue = labels[INFRASTRUCTURE_LABEL];
  if (labelValue === 'true') return refusalFor('provider', service, null, selfProject);
  if (labelValue !== undefined) return invalidLabelRefusal(service, labelValue);

  let isSelf = self.isOwnContainer(fullId) || self.isOwnContainer(containerId);
  if (!isSelf && selfState === 'unresolved') {
    const candidates = await getRuntimeContainerIdCandidates();
    if (candidates.length === 0) {
      return {
        reason: 'unresolved',
        service: null,
        message: `Sencho could not identify its own container (${self.getUnresolvedReason() ?? 'Docker did not answer'}), so it cannot tell whether this is the container it runs in. `
          + 'Check that the Docker endpoint allows container inspect requests, then retry.',
      };
    }
    isSelf = candidates.some(id => matchesContainerId(fullId, id));
  }
  if (isSelf) {
    if (action !== 'stop') return null;
    return refusalFor('sencho', self.getComposeLocation().service ?? 'sencho', null, null);
  }

  if (provider.state === 'unresolved' && (selfState !== 'resolved' || sharesSenchoNetwork(info.NetworkSettings?.Networks, self))) {
    return refusalFor('unknown_provider', service, null, selfProject, provider.reason);
  }
  return null;
}
