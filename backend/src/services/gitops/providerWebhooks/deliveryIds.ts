import crypto from 'crypto';
import { MAX_PROVIDER_DELIVERY_ID_LENGTH } from './types';

const DELIVERY_ID_HEADERS = [
  'x-github-delivery',
  'webhook-id',
  'idempotency-key',
  'x-request-uuid',
  'x-webhook-delivery-id',
] as const;

export function deliveryIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  for (const name of DELIVERY_ID_HEADERS) {
    const value = headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (first) return boundDeliveryId(first);
  }
  return undefined;
}

export function boundDeliveryId(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) return normalized;
  if (normalized.length <= MAX_PROVIDER_DELIVERY_ID_LENGTH) return normalized;
  return `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

export function scopedProviderDeliveryId(endpointId: string, deliveryId: string): string {
  return `provider:${endpointId}:${boundDeliveryId(deliveryId)}`;
}
