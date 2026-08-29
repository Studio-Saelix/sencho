import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import path from 'path';
import { DatabaseService } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import {
  RegistryService,
  type DockerConfigHostResolution,
} from './RegistryService';
import { discoverRegistryReferences } from './registryReferenceDiscovery';
import { remoteAdvertisesCapability } from '../helpers/remoteCapabilities';
import { REMOTE_REGISTRY_CREDENTIALS_CAPABILITY } from './CapabilityRegistry';
import { isTrustedProxyPeer } from '../helpers/trustedProxyCidrs';
import type { RegistryDeliveryEnvelope, RegistryDeliveryAuthEntry } from '../helpers/registryDeliveryContext';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';
import { prepareSourceForDiscover, resolveBlueprintPostApplyDiscovery } from '../helpers/registryDeliveryPrepare';
import { PreparedSourceStore } from './preparedSourceStore';
import { hashProjectSource } from '../helpers/registryDeliveryHashes';
import { isValidStackName } from '../utils/validation';
import {
  resolveComposeEnvForDiscovery,
} from '../helpers/registryDeliveryComposeEnv';

const ATTESTATION_AUD = 'registry-delivery';
const ATTESTATION_TTL_SECONDS = 900;

export interface RegistryDeliveryDiscoverRequest {
  stack?: string;
  op: string;
  service?: string;
  sourceKind: string;
  sourceHash?: string;
  actionSetHash: string;
  prepId?: string;
  envVars?: Record<string, string>;
  template?: unknown;
  stackName?: string;
  git?: Record<string, unknown>;
  gitApply?: boolean;
  restoreVariant?: string;
  composeContent?: string;
}

export interface RegistryDeliveryDiscoverResponse {
  prepId?: string;
  referencedHosts: string[];
  coveredHosts: string[];
  sourceHash: string;
  actionSetHash: string;
  deliverySourceId: string;
  attestation: string;
}

export class RegistryDeliveryService {
  private static instance: RegistryDeliveryService | null = null;
  private readonly targetSessionId = crypto.randomBytes(16).toString('hex');
  private readonly consumedJtis = new Map<string, number>();
  private maxConsumedJtis = 10_000;

  static getInstance(): RegistryDeliveryService {
    if (!this.instance) this.instance = new RegistryDeliveryService();
    return this.instance;
  }

  static resetForTests(): void {
    this.instance = null;
  }

  /** @internal Narrow replay-store capacity for unit tests. */
  setReplayStoreCapacityForTests(capacity: number): void {
    this.maxConsumedJtis = capacity;
    this.consumedJtis.clear();
  }

  getTargetSessionId(): string {
    return this.targetSessionId;
  }

  getDeliverySourceId(): string {
    const settings = DatabaseService.getInstance().getGlobalSettings();
    const id = settings.delivery_source_id;
    if (!id) {
      throw new Error('delivery_source_id is not configured');
    }
    return id;
  }

  private getJwtSecret(): string {
    const secret = DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret;
    if (!secret) {
      throw new Error('auth_jwt_secret is not configured');
    }
    return secret;
  }

  hashHostList(hosts: string[]): string {
    return crypto.createHash('sha256').update(hosts.slice().sort().join('\n')).digest('hex');
  }

  signAttestation(payload: {
    nodeIdClaim: number;
    stack?: string;
    op: string;
    service?: string;
    sourceHash: string;
    referencedHostsHash: string;
    coveredHostsHash: string;
    actionSetHash: string;
    prepId?: string;
  }): string {
    const jti = crypto.randomBytes(16).toString('hex');
    return jwt.sign(
      {
        aud: ATTESTATION_AUD,
        nodeIdClaim: payload.nodeIdClaim,
        stack: payload.stack,
        op: payload.op,
        service: payload.service,
        sourceHash: payload.sourceHash,
        referencedHostsHash: payload.referencedHostsHash,
        coveredHostsHash: payload.coveredHostsHash,
        actionSetHash: payload.actionSetHash,
        prepId: payload.prepId,
        jti_t: jti,
        target_session_id: this.targetSessionId,
      },
      this.getJwtSecret(),
      { expiresIn: ATTESTATION_TTL_SECONDS },
    );
  }

  parseAttestation(token: string): jwt.JwtPayload {
    const decoded = jwt.verify(token, this.getJwtSecret(), { audience: ATTESTATION_AUD });
    if (typeof decoded === 'string') {
      throw new Error('Invalid attestation payload');
    }
    if (decoded.target_session_id !== this.targetSessionId) {
      throw new Error('Attestation session mismatch');
    }
    return decoded;
  }

  private evictExpiredJtis(now = Date.now()): void {
    for (const [jti, expiresAt] of this.consumedJtis) {
      if (expiresAt <= now) {
        this.consumedJtis.delete(jti);
      }
    }
  }

  consumeAttestationJti(jti: string, expiresAtMs?: number): void {
    const now = Date.now();
    this.evictExpiredJtis(now);
    if (this.consumedJtis.has(jti)) {
      throw new Error('Attestation already consumed');
    }
    if (this.consumedJtis.size >= this.maxConsumedJtis) {
      throw new Error('Attestation replay store at capacity');
    }
    const expiresAt = expiresAtMs ?? now + ATTESTATION_TTL_SECONDS * 1000;
    this.consumedJtis.set(jti, expiresAt);
  }

  /** @deprecated Use parseAttestation at the middleware and consumeAttestationJti at the seam. */
  verifyAttestation(token: string): jwt.JwtPayload {
    const decoded = this.parseAttestation(token);
    const jti = decoded.jti_t;
    if (typeof jti !== 'string' || !jti) {
      throw new Error('Attestation missing jti');
    }
    this.consumeAttestationJti(jti);
    return decoded;
  }

  async discoverOnTarget(request: RegistryDeliveryDiscoverRequest): Promise<RegistryDeliveryDiscoverResponse> {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    if (
      request.sourceKind === 'restore-candidate'
      || request.sourceKind === 'live-project'
      || request.sourceKind === 'body-content'
      || request.gitApply === true
    ) {
      const stack = request.stack ?? request.stackName;
      if (typeof stack !== 'string' || !isValidStackName(stack)) {
        throw new Error('Invalid stack name');
      }
      request.stack = stack;
    }

    let referencedHosts: string[] = [];
    let sourceHash = request.sourceHash;
    let prepId = request.prepId;

    const prepared = await prepareSourceForDiscover(request);
    if (prepared) {
      prepId = prepared.prepId;
      sourceHash = prepared.sourceHash;
      const payloadPath = PreparedSourceStore.getInstance().peekPayloadPath(prepId);
      const discovery = discoverRegistryReferences(
        payloadPath,
        resolveComposeEnvForDiscovery(payloadPath, request.envVars),
      );
      referencedHosts = discovery.referencedHosts;
    } else if (request.sourceKind === 'body-content' && typeof request.composeContent === 'string') {
      const MAX_COMPOSE_CONTENT_BYTES = 2 * 1024 * 1024;
      if (Buffer.byteLength(request.composeContent, 'utf8') > MAX_COMPOSE_CONTENT_BYTES) {
        throw new Error('Compose content exceeds size limit');
      }
      const stack = request.stack ?? request.stackName;
      if (typeof stack !== 'string') {
        throw new Error('Invalid stack name');
      }
      const discovery = await resolveBlueprintPostApplyDiscovery(
        stack,
        request.composeContent,
        nodeId,
      );
      sourceHash = discovery.sourceHash;
      referencedHosts = discovery.referencedHosts;
    } else if (request.stack) {
      if (!isValidStackName(request.stack)) {
        throw new Error('Invalid stack name');
      }
      const { FileSystemService } = await import('./FileSystemService');
      const fs = FileSystemService.getInstance(nodeId);
      const baseResolved = path.resolve(fs.getBaseDir());
      const projectDir = path.resolve(baseResolved, request.stack);
      if (!projectDir.startsWith(baseResolved + path.sep)) {
        throw new Error('Invalid stack path');
      }
      if (!sourceHash || request.sourceKind === 'live-project') {
        sourceHash = hashProjectSource(projectDir);
      }
      const discovery = discoverRegistryReferences(
        projectDir,
        resolveComposeEnvForDiscovery(projectDir, request.envVars),
      );
      referencedHosts = discovery.referencedHosts;
    }

    if (!sourceHash) {
      sourceHash = crypto.createHash('sha256').update('').digest('hex');
    }

    const registry = RegistryService.getInstance();
    const coveredHosts: string[] = [];
    for (const host of referencedHosts) {
      const resolution = await registry.resolveDockerConfigForHostDetailed(host);
      if (resolution.state === 'unavailable') {
        throw new Error(`Registry credentials unavailable for ${host}`);
      }
      if (resolution.state === 'available') {
        coveredHosts.push(host);
      }
    }

    const referencedHostsHash = this.hashHostList(referencedHosts);
    const coveredHostsHash = this.hashHostList(coveredHosts);
    const deliverySourceId = this.getDeliverySourceId();

    const attestation = this.signAttestation({
      nodeIdClaim: nodeId,
      stack: request.stack,
      op: request.op,
      service: request.service,
      sourceHash,
      referencedHostsHash,
      coveredHostsHash,
      actionSetHash: request.actionSetHash,
      prepId,
    });

    return {
      prepId,
      referencedHosts,
      coveredHosts,
      sourceHash,
      actionSetHash: request.actionSetHash,
      deliverySourceId,
      attestation,
    };
  }

  async buildHubEnvelope(
    nodeId: number,
    discover: RegistryDeliveryDiscoverResponse,
  ): Promise<RegistryDeliveryEnvelope | null> {
    const deltaHosts = discover.referencedHosts.filter(host => {
      return !discover.coveredHosts.includes(host);
    });

    const registry = RegistryService.getInstance();
    const auths: RegistryDeliveryAuthEntry[] = [];

    for (const host of deltaHosts) {
      const hubResolution: DockerConfigHostResolution = await registry.resolveDockerConfigForHostDetailed(host);
      if (hubResolution.state === 'unavailable') {
        throw new Error(`Hub registry credentials unavailable for ${host}`);
      }
      if (hubResolution.state === 'missing') {
        continue;
      }
      if (!hubResolution.auth) continue;
      auths.push({
        host,
        username: hubResolution.auth.username,
        password: hubResolution.auth.password,
        expiresAt: hubResolution.expiresAt,
      });
    }

    const now = Date.now();
    const envelopeExp = now + ATTESTATION_TTL_SECONDS * 1000;
    const providerExpiries = auths.map(a => a.expiresAt).filter((v): v is number => typeof v === 'number');
    const notAfter = Math.min(envelopeExp, ...providerExpiries.length > 0 ? providerExpiries : [envelopeExp]);

    return {
      attestation: discover.attestation,
      prepId: discover.prepId,
      auths,
      notAfter,
      deliverySourceId: discover.deliverySourceId,
    };
  }

  isProxyTransportConfidential(nodeId: number): boolean {
    const node = NodeRegistry.getInstance().getNode(nodeId);
    if (!node?.api_url) return false;
    return node.api_url.trim().toLowerCase().startsWith('https://');
  }

  isPilotTransportConfidential(socketEncrypted: boolean, forwardedProto: string | undefined, peerAddress: string | undefined): boolean {
    if (socketEncrypted) return true;
    if (forwardedProto?.toLowerCase() === 'https' && isTrustedProxyPeer(peerAddress)) {
      return true;
    }
    return false;
  }

  async shouldAttemptDelivery(nodeId: number, confidential: boolean): Promise<boolean> {
    if (!confidential) return false;
    return remoteAdvertisesCapability(nodeId, REMOTE_REGISTRY_CREDENTIALS_CAPABILITY);
  }

  isDeliveryEligibleRoute(method: string, apiPath: string): boolean {
    return classifyRegistryDeliveryOp(method, apiPath).eligible;
  }
}
