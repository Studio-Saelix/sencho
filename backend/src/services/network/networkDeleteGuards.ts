/**
 * Fail-closed guards for admin network delete on /api/system/networks/delete.
 */
import SelfIdentityService from '../SelfIdentityService';
import type { DependencySnapshot } from '../DockerController';
import type { StackNetworkFacts } from './types';
import type { NetworkingNetworkBase } from './networkingTypes';

export type NetworkDeleteBlockCode =
  | 'system-network'
  | 'sencho-owned'
  | 'attached'
  | 'stack-declared'
  | 'stack-declaration-unknown';

export interface NetworkDeleteGuardResult {
  blocked: boolean;
  code?: NetworkDeleteBlockCode;
  error?: string;
}

export function evaluateNetworkDeleteGuard(
  networkId: string,
  snapshot: DependencySnapshot,
  stackFacts: StackNetworkFacts[],
  baseRow?: NetworkingNetworkBase,
): NetworkDeleteGuardResult {
  const net = baseRow
    ?? snapshot.networks.find(n => n.id === networkId || n.name === networkId);

  if (!net) {
    return { blocked: false };
  }

  if (net.isSystem) {
    return { blocked: true, code: 'system-network', error: 'System networks cannot be deleted.' };
  }

  const self = SelfIdentityService.getInstance();
  if (self.isOwnNetwork(net.id) || self.isOwnNetwork(net.name)) {
    return { blocked: true, code: 'sencho-owned', error: 'Sencho-managed networks cannot be deleted.' };
  }

  const connected = snapshot.containers.some(c =>
    c.networks.some(a => a.id === net.id || a.name === net.name),
  );
  if (connected) {
    return { blocked: true, code: 'attached', error: 'Detach all containers before deleting this network.' };
  }

  const hasUnrenderable = stackFacts.some(f => !f.renderable);
  const declaredNames = new Set<string>();
  for (const facts of stackFacts) {
    if (!facts.renderable) continue;
    for (const n of facts.networks) declaredNames.add(n.name);
  }

  if (declaredNames.has(net.name)) {
    return { blocked: true, code: 'stack-declared', error: 'This network is declared by a Compose stack.' };
  }

  // Fail closed while any stack is unrenderable: an external network normally
  // carries no compose project label, so without this check a broken declaring
  // stack would let its declared network slip through as "undeclared".
  if (hasUnrenderable) {
    return {
      blocked: true,
      code: 'stack-declaration-unknown',
      error: 'Cannot verify stack declarations while one or more stacks failed to render.',
    };
  }

  return { blocked: false };
}
