import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { CryptoService } from '../../CryptoService';
import { DatabaseService } from '../../DatabaseService';
import { GitSourceService } from '../../GitSourceService';
import { WebhookService } from '../../WebhookService';
import { NodeRegistry } from '../../NodeRegistry';
import { safeRemoteFetch } from '../../../utils/outboundTarget';
import {
  parseLegacyRepoUrl,
  parseStorableRepoUrl,
  serializeRepoIdentity,
  serializeRepoIdentityFromStorable,
  type RepoIdentity,
} from '../repoIdentity';
import { scopedProviderDeliveryId, deliveryIdFromHeaders, boundDeliveryId } from './deliveryIds';
import { GitProviderWebhookStore } from './store';
import {
  isActionablePullRequestAction,
  isPingEvent,
  isPullRequestLikeEvent,
  isPushLikeEvent,
  parseProviderPayload,
  refsMatchConfigured,
} from './normalize';
import { verifyProviderSignature } from './verify';
import type {
  GitProviderDeliveryState,
  GitProviderEndpointRow,
  GitProviderEventScope,
  GitProviderKind,
  ProviderIngestOutcome,
} from './types';

const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
const INTERNAL_FORWARD_TIMEOUT_MS = 30_000;
const SETTLED_INGEST_STATES = new Set<GitProviderDeliveryState>([
  'queued',
  'duplicate',
  'ignored_by_policy',
  'unsupported',
]);

export class ProviderWebhookService {
  private static instance: ProviderWebhookService;
  private static decoySecret: string | null = null;

  public static getInstance(): ProviderWebhookService {
    if (!ProviderWebhookService.instance) {
      ProviderWebhookService.instance = new ProviderWebhookService();
    }
    return ProviderWebhookService.instance;
  }

  public static getDecoySecret(): string {
    if (!ProviderWebhookService.decoySecret) {
      ProviderWebhookService.decoySecret = crypto.randomBytes(32).toString('hex');
    }
    return ProviderWebhookService.decoySecret;
  }

  public generateSecret(): string {
    return WebhookService.getInstance().generateSecret();
  }

  public maskSecret(secret: string): string {
    return WebhookService.getInstance().maskSecret(secret);
  }

  private decryptSecret(encrypted: string): string {
    return CryptoService.getInstance().decrypt(encrypted);
  }

  private encryptSecret(plain: string): string {
    return CryptoService.getInstance().encrypt(plain);
  }

  private resolveSecrets(endpoint: GitProviderEndpointRow | undefined): string[] {
    if (!endpoint) return [ProviderWebhookService.getDecoySecret()];
    const secrets: string[] = [];
    try {
      secrets.push(this.decryptSecret(endpoint.encrypted_secret));
    } catch {
      secrets.push(ProviderWebhookService.getDecoySecret());
    }
    if (
      endpoint.encrypted_secret_previous
      && endpoint.previous_secret_expires_at
      && endpoint.previous_secret_expires_at > Date.now()
    ) {
      try {
        secrets.push(this.decryptSecret(endpoint.encrypted_secret_previous));
      } catch {
        // ignore expired corrupt previous secret
      }
    }
    return secrets.length > 0 ? secrets : [ProviderWebhookService.getDecoySecret()];
  }

  private verifyWithSecrets(
    provider: GitProviderKind,
    rawBody: Buffer,
    secrets: string[],
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    return secrets.some((secret) => verifyProviderSignature(provider, rawBody, secret, headers));
  }

  private configuredRepoIdentity(stackName: string): RepoIdentity | null {
    const src = DatabaseService.getInstance().getGitSource(stackName);
    if (!src) return null;
    const parsed = parseStorableRepoUrl(src.repo_url);
    if (parsed.ok) return serializeRepoIdentityFromStorable(parsed);
    const legacy = parseLegacyRepoUrl(src.repo_url);
    if (!legacy.ok) return null;
    return serializeRepoIdentity(legacy.url);
  }

  private eventTypeHeader(provider: GitProviderKind, headers: Record<string, string | string[] | undefined>): string | undefined {
    const pick = (name: string): string | undefined => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    switch (provider) {
      case 'github':
        return pick('x-github-event');
      case 'gitlab':
        return pick('x-gitlab-event');
      case 'gitea':
        return pick('x-gitea-event');
      case 'forgejo':
        return pick('x-forgejo-event') ?? pick('x-gitea-event');
      case 'bitbucket_cloud':
        return pick('x-event-key');
      default:
        return undefined;
    }
  }

  public async ingestLocal(args: {
    endpointId: string;
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<ProviderIngestOutcome> {
    const store = GitProviderWebhookStore.getInstance();
    const endpoint = store.getEndpoint(args.endpointId);
    const secrets = this.resolveSecrets(endpoint);

    const sigOk = this.verifyWithSecrets(
      endpoint?.provider ?? 'github',
      args.rawBody,
      secrets,
      args.headers,
    );

    if (!endpoint || endpoint.enabled !== 1 || !sigOk) {
      return { httpStatus: 404, state: 'rejected_auth' };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(args.rawBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      store.upsertDelivery({
        endpointId: endpoint.id,
        deliveryId: boundDeliveryId(deliveryIdFromHeaders(args.headers) ?? randomUUID()),
        state: 'malformed',
      });
      return { httpStatus: 400, state: 'malformed', message: 'Malformed JSON payload.' };
    }

    const deliveryId = boundDeliveryId(deliveryIdFromHeaders(args.headers) ?? randomUUID());
    const parsed = parseProviderPayload(
      endpoint.provider,
      body,
      this.eventTypeHeader(endpoint.provider, args.headers),
    );
    if (!parsed) {
      store.upsertDelivery({ endpointId: endpoint.id, deliveryId, state: 'malformed' });
      return { httpStatus: 400, state: 'malformed', message: 'Unsupported provider payload.' };
    }

    const prior = store.getDelivery(endpoint.id, deliveryId);
    if (prior && SETTLED_INGEST_STATES.has(prior.state)) {
      return { httpStatus: 202, state: 'duplicate', message: 'Duplicate delivery.' };
    }

    store.upsertDelivery({
      endpointId: endpoint.id,
      deliveryId,
      state: 'authenticated',
      eventType: parsed.eventType,
      eventAction: parsed.eventAction,
      ref: parsed.ref,
      candidateSha: parsed.candidateSha,
    });

    if (isPingEvent(parsed.eventType)) {
      store.upsertDelivery({ endpointId: endpoint.id, deliveryId, state: 'ignored_by_policy', outcomeClass: 'ping' });
      store.pruneDeliveries(endpoint.id);
      return { httpStatus: 202, state: 'ignored_by_policy', message: 'Ping acknowledged.' };
    }

    const src = DatabaseService.getInstance().getGitSource(endpoint.stack_name);
    if (!src) {
      store.upsertDelivery({ endpointId: endpoint.id, deliveryId, state: 'ignored_by_policy', outcomeClass: 'no_source' });
      return { httpStatus: 202, state: 'ignored_by_policy', message: 'No Git source configured.' };
    }

    const configuredIdentity = this.configuredRepoIdentity(endpoint.stack_name);
    if (!parsed.repoIdentity || !configuredIdentity
      || parsed.repoIdentity.host !== configuredIdentity.host
      || parsed.repoIdentity.pathname !== configuredIdentity.pathname) {
      store.upsertDelivery({ endpointId: endpoint.id, deliveryId, state: 'ignored_by_policy', outcomeClass: 'source_mismatch' });
      store.pruneDeliveries(endpoint.id);
      return { httpStatus: 202, state: 'ignored_by_policy', message: 'Repository identity does not match the configured source.' };
    }

    const scope = endpoint.event_scope as GitProviderEventScope;
    let shouldQueue = false;
    if (isPushLikeEvent(endpoint.provider, parsed.eventType)) {
      shouldQueue = refsMatchConfigured(src.branch, parsed.ref);
    } else if (isPullRequestLikeEvent(endpoint.provider, parsed.eventType)) {
      shouldQueue = scope === 'configured_ref_and_prs' && isActionablePullRequestAction(parsed.eventAction);
    } else {
      store.upsertDelivery({ endpointId: endpoint.id, deliveryId, state: 'unsupported', outcomeClass: parsed.eventType });
      store.pruneDeliveries(endpoint.id);
      return { httpStatus: 202, state: 'unsupported', message: 'Unsupported event type.' };
    }

    if (!shouldQueue) {
      store.upsertDelivery({ endpointId: endpoint.id, deliveryId, state: 'ignored_by_policy', outcomeClass: 'ref_policy' });
      store.pruneDeliveries(endpoint.id);
      return { httpStatus: 202, state: 'ignored_by_policy', message: 'Event ignored by policy.' };
    }

    const scopedId = scopedProviderDeliveryId(endpoint.id, deliveryId);
    const result = await GitSourceService.getInstance().handleWebhookPull(
      endpoint.stack_name,
      true,
      scopedId,
      { trigger: 'provider_event', actor: 'system:provider_event' },
    );

    const outcomeState: GitProviderDeliveryState = result.status === 'skipped' && result.message.includes('Blueprint')
      ? 'ignored_by_policy'
      : result.status === 'skipped'
        ? 'duplicate'
        : result.status === 'error'
          ? 'processing_failed'
          : 'queued';

    store.upsertDelivery({
      endpointId: endpoint.id,
      deliveryId,
      state: outcomeState,
      outcomeClass: result.status,
    });
    store.pruneDeliveries(endpoint.id);

    if (outcomeState === 'duplicate') {
      return { httpStatus: 202, state: 'duplicate', message: result.message };
    }
    if (outcomeState === 'processing_failed') {
      return { httpStatus: 202, state: 'processing_failed', message: result.message };
    }
    if (outcomeState === 'ignored_by_policy') {
      return { httpStatus: 202, state: 'ignored_by_policy', message: result.message };
    }
    return { httpStatus: 202, state: 'queued', message: result.message ?? 'Queued for reconciliation.' };
  }

  public async forwardToRemoteNode(args: {
    nodeId: number;
    endpointId: string;
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<ProviderIngestOutcome> {
    const target = NodeRegistry.getInstance().getProxyTarget(args.nodeId);
    if (!target) {
      return { httpStatus: 500, state: 'processing_failed', message: 'Remote node is unreachable.' };
    }
    const forwardHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.apiToken) forwardHeaders.Authorization = `Bearer ${target.apiToken}`;
    for (const [key, value] of Object.entries(args.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'content-length' || lower === 'authorization') continue;
      forwardHeaders[key] = Array.isArray(value) ? value[0] : value;
    }
    try {
      const baseUrl = target.apiUrl.replace(/\/$/, '');
      const response = await safeRemoteFetch(
        `${baseUrl}/api/gitops/internal/hooks/${args.endpointId}`,
        {
          method: 'POST',
          headers: forwardHeaders,
          body: args.rawBody,
          signal: AbortSignal.timeout(INTERNAL_FORWARD_TIMEOUT_MS),
        },
        target.trustedLoopback,
      );
      const payload = await response.json().catch(() => ({})) as { state?: GitProviderDeliveryState; message?: string };
      if (!response.ok) {
        return {
          httpStatus: response.status >= 500 ? 500 : 404,
          state: payload.state ?? 'processing_failed',
          message: payload.message,
        };
      }
      return {
        httpStatus: 202,
        state: payload.state ?? 'queued',
        message: payload.message ?? 'Accepted.',
      };
    } catch (error) {
      console.error('[GitProviderHooks] Forward to remote node failed:', error);
      return { httpStatus: 500, state: 'processing_failed', message: 'Remote node is unreachable.' };
    }
  }

  public createEndpoint(args: {
    stackName: string;
    provider: GitProviderKind;
    eventScope?: GitProviderEventScope;
  }): { id: string; secret: string } {
    const id = randomUUID();
    const secret = this.generateSecret();
    GitProviderWebhookStore.getInstance().createEndpoint({
      id,
      stackName: args.stackName,
      provider: args.provider,
      encryptedSecret: this.encryptSecret(secret),
      eventScope: args.eventScope ?? 'configured_ref',
    });
    return { id, secret };
  }

  public rotateEndpoint(id: string): { secret: string } {
    const endpoint = GitProviderWebhookStore.getInstance().getEndpoint(id);
    if (!endpoint) throw new Error('Endpoint not found');
    const secret = this.generateSecret();
    GitProviderWebhookStore.getInstance().updateEndpoint(id, {
      encrypted_secret: this.encryptSecret(secret),
      encrypted_secret_previous: endpoint.encrypted_secret,
      previous_secret_expires_at: Date.now() + ROTATION_OVERLAP_MS,
    });
    return { secret };
  }
}
