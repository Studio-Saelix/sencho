import { DatabaseService } from '../../DatabaseService';
import type {
  GitProviderDeliveryRow,
  GitProviderDeliveryState,
  GitProviderEndpointRow,
  GitProviderEventScope,
  GitProviderKind,
} from './types';

const DELIVERY_RETENTION = 200;

export class GitProviderWebhookStore {
  private static instance: GitProviderWebhookStore;

  public static getInstance(): GitProviderWebhookStore {
    if (!GitProviderWebhookStore.instance) {
      GitProviderWebhookStore.instance = new GitProviderWebhookStore();
    }
    return GitProviderWebhookStore.instance;
  }

  public listEndpoints(stackName: string): GitProviderEndpointRow[] {
    return DatabaseService.getInstance().listGitProviderEndpoints(stackName) as GitProviderEndpointRow[];
  }

  public getEndpoint(id: string): GitProviderEndpointRow | undefined {
    return DatabaseService.getInstance().getGitProviderEndpoint(id) as GitProviderEndpointRow | undefined;
  }

  public createEndpoint(args: {
    id: string;
    stackName: string;
    provider: GitProviderKind;
    encryptedSecret: string;
    eventScope: GitProviderEventScope;
  }): void {
    DatabaseService.getInstance().insertGitProviderEndpoint({
      id: args.id,
      stack_name: args.stackName,
      provider: args.provider,
      encrypted_secret: args.encryptedSecret,
      event_scope: args.eventScope,
    });
  }

  public updateEndpoint(
    id: string,
    updates: Partial<Pick<GitProviderEndpointRow, 'enabled' | 'event_scope' | 'encrypted_secret' | 'encrypted_secret_previous' | 'previous_secret_expires_at'>>,
  ): void {
    DatabaseService.getInstance().updateGitProviderEndpoint(id, updates);
  }

  public deleteEndpoint(id: string): void {
    DatabaseService.getInstance().deleteGitProviderEndpoint(id);
  }

  public upsertDelivery(args: {
    endpointId: string;
    deliveryId: string;
    state: GitProviderDeliveryState;
    eventType?: string | null;
    eventAction?: string | null;
    ref?: string | null;
    candidateSha?: string | null;
    outcomeClass?: string | null;
  }): GitProviderDeliveryRow {
    return DatabaseService.getInstance().upsertGitProviderDelivery(args) as GitProviderDeliveryRow;
  }

  public listDeliveries(endpointId: string, limit = 20): GitProviderDeliveryRow[] {
    return DatabaseService.getInstance().listGitProviderDeliveries(endpointId, limit) as GitProviderDeliveryRow[];
  }

  public getDelivery(endpointId: string, deliveryId: string): GitProviderDeliveryRow | undefined {
    return DatabaseService.getInstance().getGitProviderDelivery(endpointId, deliveryId) as GitProviderDeliveryRow | undefined;
  }

  public pruneDeliveries(endpointId: string): void {
    DatabaseService.getInstance().pruneGitProviderDeliveries(endpointId, DELIVERY_RETENTION);
  }
}
