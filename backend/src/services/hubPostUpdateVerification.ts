import { NodeRegistry } from './NodeRegistry';
import { UPDATE_VERIFICATION_INCOMPLETE_WARNING } from './ImageUpdateService';

export interface UpdateVerification {
  status: 'verified' | 'verification_incomplete' | 'verification_failed' | 'skipped';
  source: 'hub_authority' | 'target_local' | 'skipped';
  completedAt: number | null;
  detail: string | null;
}

export interface HubVerificationTransport {
  recheckRemoteStack(nodeId: number, stack: string, signal: AbortSignal): Promise<{ warning?: string | null }>;
}

export interface HubVerificationInput {
  nodeId: number;
  stack: string;
  targetResponse: { status: number; body: unknown };
  caller: 'coordinator' | 'proxy' | 'scheduler' | 'webhook' | 'blueprint' | 'mesh' | 'fleet';
  transport: HubVerificationTransport;
}

export function skippedVerification(source: 'target_local' | 'skipped' = 'skipped'): UpdateVerification {
  return { status: 'skipped', source, completedAt: null, detail: null };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Mutation success is independent of the subsequent, bounded verification outcome. */
export async function awaitHubPostUpdateVerification(input: HubVerificationInput): Promise<UpdateVerification> {
  const body = record(input.targetResponse.body);
  if (input.targetResponse.status < 200 || input.targetResponse.status >= 300
    || body.applied === false || body.success === false || body.status === 'error' || body.status === 'skipped'
    || (input.caller === 'coordinator' && (body.applied !== true || body.result !== 'applied'))) {
    return skippedVerification();
  }
  const registry = NodeRegistry.getInstance();
  if (registry.getNode(input.nodeId)?.type !== 'remote') return skippedVerification('target_local');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<UpdateVerification>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'verification_incomplete', source: 'hub_authority', completedAt: Date.now(), detail: UPDATE_VERIFICATION_INCOMPLETE_WARNING });
    }, 30_000);
  });
  const verify = async (): Promise<UpdateVerification> => {
    try {
      const probe = await registry.probeRemoteMeta(input.nodeId, controller.signal);
      if (probe.kind !== 'ok' || !probe.meta.capabilities.includes('remote-image-inspect-v1')
        || (input.caller === 'coordinator' && !probe.meta.capabilities.includes('remote-auto-update-checked-v1'))) {
        return skippedVerification('target_local');
      }
      if (controller.signal.aborted) return { status: 'verification_incomplete', source: 'hub_authority', completedAt: Date.now(), detail: UPDATE_VERIFICATION_INCOMPLETE_WARNING };
      const result = await input.transport.recheckRemoteStack(input.nodeId, input.stack, controller.signal);
      return { status: result.warning ? 'verification_incomplete' : 'verified', source: 'hub_authority', completedAt: Date.now(), detail: result.warning ?? null };
    } catch (error) {
      console.warn('[HubVerification] Post-update verification failed:', error);
      return { status: 'verification_failed', source: 'hub_authority', completedAt: Date.now(), detail: UPDATE_VERIFICATION_INCOMPLETE_WARNING };
    }
  };
  try {
    return await Promise.race([verify(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function decorateUpdateResponse(body: unknown, verification: UpdateVerification): Record<string, unknown> {
  const result = { ...record(body), verification };
  const decorated: Record<string, unknown> = result;
  if (verification.source !== 'hub_authority') return decorated;
  if (decorated.healthGateId === undefined && typeof decorated.healthId === 'string') decorated.healthGateId = decorated.healthId;
  if (verification.status === 'verified') delete decorated.recheckWarning;
  else decorated.recheckWarning = verification.detail ?? UPDATE_VERIFICATION_INCOMPLETE_WARNING;
  return decorated;
}
