import { AsyncLocalStorage } from 'async_hooks';

import { attestationJtiFromToken } from './registryDeliveryEvidence';
import type { RegistryDeliveryStage } from './registryOpClassifier';

export interface RegistryDeliveryAuthEntry {
  host: string;
  username: string;
  password: string;
  expiresAt?: number;
}

export interface RegistryDeliveryEnvelope {
  attestation: string;
  prepId?: string;
  auths: RegistryDeliveryAuthEntry[];
  notAfter: number;
  deliverySourceId: string;
}

export interface RegistryDeliveryContext {
  envelope: RegistryDeliveryEnvelope;
  nodeId: number;
  stack: string;
  stage: RegistryDeliveryStage;
  service?: string;
  abortSignal?: AbortSignal;
  onFinalize?: () => void;
  seamSettled?: boolean;
  seamResult?: { auths: Record<string, { auth: string }>; prepId?: string };
}

const storage = new AsyncLocalStorage<RegistryDeliveryContext>();

export function runWithRegistryDeliveryContext<T>(
  context: RegistryDeliveryContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getRegistryDeliveryContext(): RegistryDeliveryContext | undefined {
  return storage.getStore();
}

export function getRegistryDeliveryLockContext(): { opId: string; kind: string } | undefined {
  const ctx = getRegistryDeliveryContext();
  if (!ctx) return undefined;
  const jti = attestationJtiFromToken(ctx.envelope.attestation);
  if (!jti) return undefined;
  return { opId: jti, kind: ctx.stage };
}

export function clearRegistryDeliveryContext(): void {
  storage.disable();
}
