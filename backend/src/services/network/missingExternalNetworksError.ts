import type { MissingExternalNetwork } from '../network/missingExternalNetworks';

export type MissingExternalNetworksKind =
  | 'prompt'
  | 'unsupported'
  | 'unavailable'
  | 'create_failed';

/**
 * Typed pre-Compose gate error. Must be thrown before atomic backup so it is
 * never wrapped in ComposeRollbackError.
 */
export class MissingExternalNetworksError extends Error {
  readonly code: 'missing_external_networks' | 'external_network_create_failed';
  readonly kind: MissingExternalNetworksKind;
  readonly networks: MissingExternalNetwork[];
  readonly createdNames: string[];
  readonly remainingNames: string[];

  constructor(opts: {
    kind: MissingExternalNetworksKind;
    message: string;
    networks?: MissingExternalNetwork[];
    createdNames?: string[];
    remainingNames?: string[];
  }) {
    super(opts.message);
    this.name = 'MissingExternalNetworksError';
    this.kind = opts.kind;
    this.code = opts.kind === 'create_failed'
      ? 'external_network_create_failed'
      : 'missing_external_networks';
    this.networks = opts.networks ?? [];
    this.createdNames = opts.createdNames ?? [];
    this.remainingNames = opts.remainingNames ?? [];
  }
}

export function isMissingExternalNetworksError(error: unknown): error is MissingExternalNetworksError {
  return error instanceof MissingExternalNetworksError;
}

export interface DeployInvocationContext {
  actor?: string | null;
  source:
    | 'manual'
    | 'rollback'
    | 'template'
    | 'from_git'
    | 'git_apply'
    | 'fleet_snapshot'
    | 'labels'
    | 'scheduler'
    | 'webhook'
    | 'blueprint'
    | 'mesh_redeploy';
}
