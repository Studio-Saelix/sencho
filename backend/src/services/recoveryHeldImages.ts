import { ServiceUpdateRecoveryService } from './ServiceUpdateRecoveryService';
import { StackUpdateRecoveryService } from './StackUpdateRecoveryService';

/**
 * Unified held-image predicate: service-scoped + full-stack rollback holds.
 * Lives in its own module (rather than on either service) so both can be
 * imported here statically without a cycle -- ServiceUpdateRecoveryService
 * and StackUpdateRecoveryService intentionally do not import each other.
 * Fails closed (protects every image) when either lookup fails.
 */
export function buildUnifiedHeldImagePredicate(nodeId: number): (imageId: string) => boolean {
  const serviceHeld = ServiceUpdateRecoveryService.getInstance().getHeldImageIds(nodeId);
  const stackHeld = StackUpdateRecoveryService.getInstance().getHeldImageIds(nodeId);
  if (serviceHeld === null || stackHeld === null) {
    return () => true;
  }
  return (imageId: string) => serviceHeld.has(imageId) || stackHeld.has(imageId);
}
