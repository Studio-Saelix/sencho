import path from 'path';
import type { JwtPayload } from 'jsonwebtoken';
import { FileSystemService } from '../services/FileSystemService';
import {
  RegistryService,
  normalizeImageHost,
} from '../services/RegistryService';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { StackOpLockService } from '../services/StackOpLockService';
import { discoverRegistryReferences } from '../services/registryReferenceDiscovery';
import type { RegistryDeliveryEnvelope } from './registryDeliveryContext';
import { hashActionSet, hashProjectSource } from './registryDeliveryHashes';
import type { RegistryDeliveryStage } from './registryOpClassifier';

export interface RegistryDeliverySeamInput {
  envelope: RegistryDeliveryEnvelope;
  nodeId: number;
  stack: string;
  stage: RegistryDeliveryStage;
  service?: string;
}

export interface RegistryDeliverySeamResult {
  auths: Record<string, { auth: string }>;
  prepId?: string;
}

function requiredActionsForStage(stage: RegistryDeliveryStage): string[] {
  switch (stage) {
    case 'git-apply-auto-deploy':
      return ['stack:edit', 'stack:deploy'];
    case 'template-deploy':
    case 'from-git-deploy-now':
      return ['stack:create', 'stack:deploy'];
    case 'fleet-label':
    case 'stack-deploy':
    case 'stack-update':
    case 'stack-pull-update':
    case 'service-update':
    case 'service-pull-update':
    case 'webhook-deploy':
    case 'scheduler-auto-update':
    case 'scheduler-auto-start':
    case 'mesh-redeploy':
    case 'blueprint-apply':
    case 'fleet-snapshot':
      return ['stack:deploy'];
    default:
      return ['stack:deploy'];
  }
}

function assertClaim(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function encodeAuth(username: string, password: string): { auth: string } {
  return {
    auth: Buffer.from(`${username}:${password}`).toString('base64'),
  };
}

/**
 * Execute the registry delivery seam: claim prepared sources when present,
 * re-hash source inputs, re-verify the attestation, burn jti_t, check notAfter,
 * and merge target-local with delivered credentials (target available always wins).
 */
export async function resolveRegistryAuthAtSeam(
  input: RegistryDeliverySeamInput,
): Promise<RegistryDeliverySeamResult> {
  const delivery = RegistryDeliveryService.getInstance();
  const payload = delivery.parseAttestation(input.envelope.attestation);

  assertClaim(
    typeof payload.nodeIdClaim === 'number' && payload.nodeIdClaim === input.nodeId,
    'Attestation node mismatch',
  );
  if (input.stack && payload.stack && payload.stack !== input.stack) {
    throw new Error('Attestation stack mismatch');
  }
  if (payload.op && payload.op !== input.stage) {
    throw new Error('Attestation operation mismatch');
  }
  if (input.service && payload.service && payload.service !== input.service) {
    throw new Error('Attestation service mismatch');
  }

  const heldLock = StackOpLockService.getInstance().get(input.nodeId, input.stack);
  if (heldLock?.context?.opId) {
    const jti = payload.jti_t;
    assertClaim(
      typeof jti === 'string'
        && heldLock.context.opId === jti
        && heldLock.context.kind === input.stage,
      'Stack lock context mismatch',
    );
  }

  const prepId = input.envelope.prepId ?? (typeof payload.prepId === 'string' ? payload.prepId : undefined);
  let sourceHash: string;
  let referencedHosts: string[];

  if (prepId) {
    assertClaim(
      payload.prepId === prepId,
      'Attestation prepId mismatch',
    );
    const store = PreparedSourceStore.getInstance();
    const entry = store.claim(prepId);
    const payloadPath = store.getPayloadPath(prepId);
    sourceHash = entry.sourceHash;
    assertClaim(
      payload.sourceHash === sourceHash,
      'Prepared source hash mismatch',
    );
    const discovery = discoverRegistryReferences(payloadPath);
    referencedHosts = discovery.referencedHosts;
  } else {
    const fs = FileSystemService.getInstance(input.nodeId);
    const projectDir = path.join(fs.getBaseDir(), input.stack);
    sourceHash = hashProjectSource(projectDir);
    assertClaim(
      payload.sourceHash === sourceHash,
      'Project source hash mismatch',
    );
    const discovery = discoverRegistryReferences(projectDir);
    referencedHosts = discovery.referencedHosts;
  }

  const referencedHostsHash = delivery.hashHostList(referencedHosts);
  assertClaim(
    payload.referencedHostsHash === referencedHostsHash,
    'Referenced hosts hash mismatch',
  );

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

  const coveredHostsHash = delivery.hashHostList(coveredHosts);
  assertClaim(
    payload.coveredHostsHash === coveredHostsHash,
    'Covered hosts hash mismatch',
  );

  const actionSetHash = hashActionSet(requiredActionsForStage(input.stage));
  assertClaim(
    payload.actionSetHash === actionSetHash,
    'Action set hash mismatch',
  );

  const jti = payload.jti_t;
  assertClaim(typeof jti === 'string' && jti.length > 0, 'Attestation missing jti');
  delivery.consumeAttestationJti(jti);

  if (Date.now() >= input.envelope.notAfter) {
    throw new Error('Registry delivery envelope expired');
  }

  const referencedSet = new Set(referencedHosts.map(normalizeImageHost));
  const coveredSet = new Set(coveredHosts.map(normalizeImageHost));
  const merged: Record<string, { auth: string }> = {};

  for (const host of referencedHosts) {
    const normalized = normalizeImageHost(host);
    const resolution = await registry.resolveDockerConfigForHostDetailed(host);
    if (resolution.state === 'available' && resolution.auth) {
      merged[normalized] = encodeAuth(resolution.auth.username, resolution.auth.password);
    }
  }

  for (const entry of input.envelope.auths) {
    const normalized = normalizeImageHost(entry.host);
    if (!referencedSet.has(normalized) && !coveredSet.has(normalized)) {
      throw new Error('Delivery includes undeclared registry host');
    }
    if (merged[normalized]) {
      continue;
    }
    const targetResolution = await registry.resolveDockerConfigForHostDetailed(entry.host);
    if (targetResolution.state === 'unavailable') {
      throw new Error(`Registry credentials unavailable for ${entry.host}`);
    }
    if (targetResolution.state === 'available' && targetResolution.auth) {
      merged[normalized] = encodeAuth(
        targetResolution.auth.username,
        targetResolution.auth.password,
      );
      continue;
    }
    merged[normalized] = encodeAuth(entry.username, entry.password);
  }

  return { auths: merged, prepId };
}

export type { JwtPayload };
