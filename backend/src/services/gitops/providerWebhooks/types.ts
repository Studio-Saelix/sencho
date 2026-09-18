import type { RepoIdentity } from '../repoIdentity';

export type GitProviderKind = 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'bitbucket_cloud';

export type GitProviderEventScope = 'configured_ref' | 'configured_ref_and_prs';

export type GitProviderDeliveryState =
  | 'received'
  | 'authenticated'
  | 'rejected_auth'
  | 'malformed'
  | 'unsupported'
  | 'duplicate'
  | 'ignored_by_policy'
  | 'queued'
  | 'rate_limited'
  | 'processing_failed';

export type GitProviderEndpointRow = {
  id: string;
  stack_name: string;
  provider: GitProviderKind;
  encrypted_secret: string;
  encrypted_secret_previous: string | null;
  previous_secret_expires_at: number | null;
  enabled: number;
  event_scope: GitProviderEventScope;
  created_at: number;
  updated_at: number;
};

export type GitProviderDeliveryRow = {
  id: number;
  endpoint_id: string;
  delivery_id: string;
  state: GitProviderDeliveryState;
  event_type: string | null;
  event_action: string | null;
  ref: string | null;
  candidate_sha: string | null;
  outcome_class: string | null;
  received_at: number;
  updated_at: number;
};

export type NormalizedProviderEvent = {
  schemaVersion: 1;
  provider: GitProviderKind;
  endpointId: string;
  deliveryId: string;
  eventType: string;
  eventAction: string | null;
  repoIdentity: RepoIdentity;
  ref: string | null;
  candidateSha: string | null;
  pullRequestId: string | null;
  targetStack: string;
  receivedAt: number;
  authenticatedAt: number;
};

export type ProviderIngestOutcome =
  | { httpStatus: 202; state: GitProviderDeliveryState; message: string }
  | { httpStatus: 400 | 404 | 413 | 429 | 500; state: GitProviderDeliveryState; message?: string };

export const MAX_PROVIDER_DELIVERY_ID_LENGTH = 256;

export const PROVIDER_WEBHOOK_BODY_LIMIT = 1024 * 1024;
