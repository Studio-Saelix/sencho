import { AsyncLocalStorage } from 'async_hooks';

import { attestationJtiFromToken } from './registryDeliveryEvidence';
import type { SealedAuthsV1 } from './registryEnvelopeSeal';
import type { RegistryDeliveryStage } from './registryOpClassifier';

export interface RegistryDeliveryAuthEntry {
  host: string;
  username: string;
  password: string;
  expiresAt?: number;
}

type RegistryDeliveryEnvelopeBase = {
  attestation: string;
  prepId?: string;
  notAfter: number;
  deliverySourceId: string;
};

/** Delivered envelope: exactly one of plaintext auths or sealedAuths. */
export type RegistryDeliveryEnvelope =
  | (RegistryDeliveryEnvelopeBase & { auths: RegistryDeliveryAuthEntry[]; sealedAuths?: never })
  | (RegistryDeliveryEnvelopeBase & { sealedAuths: SealedAuthsV1; auths?: never });

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
