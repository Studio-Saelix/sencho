import { ServiceUpdateRecoveryService } from './ServiceUpdateRecoveryService';
import { StackUpdateRecoveryService } from './StackUpdateRecoveryService';

/**
 * One snapshot of service-scoped and full-stack holds. When `unknown`,
 * reclaimable figures must claim 0; subtracting unique bytes of every
 * unused image leaves shared-layer residue.
 */
export function readHeldImageLookup(nodeId: number):
  | { unknown: true }
  | { unknown: false; isHeld: (imageId: string) => boolean } {
  const serviceHeld = ServiceUpdateRecoveryService.getInstance().getHeldImageIds(nodeId);
  const stackHeld = StackUpdateRecoveryService.getInstance().getHeldImageIds(nodeId);
  if (serviceHeld === null || stackHeld === null) {
    return { unknown: true };
  }
  return {
    unknown: false,
    isHeld: (imageId: string) => serviceHeld.has(imageId) || stackHeld.has(imageId),
  };
}

/**
 * Unified held-image predicate: service-scoped + full-stack rollback holds.
 * Lives in its own module (rather than on either service) so both can be
 * imported here statically without a cycle. ServiceUpdateRecoveryService
 * and StackUpdateRecoveryService intentionally do not import each other.
 * Fails closed (protects every image) when either lookup fails.
 */
export function buildUnifiedHeldImagePredicate(nodeId: number): (imageId: string) => boolean {
  const held = readHeldImageLookup(nodeId);
  if (held.unknown) {
    return () => true;
  }
  return held.isHeld;
}
