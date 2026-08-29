/** Reserved JSON field name for hub-to-target delivery envelopes. */
export const REGISTRY_DELIVERY_BODY_FIELD = '__sencho_registry_delivery';

/** Maximum UTF-8 size of the delivery field alone. */
export const REGISTRY_DELIVERY_FIELD_LIMIT_BYTES = 64 * 1024;

const KIB = 1024;

export type RegistryDeliveryRouteClass =
  | 'stack-deploy-update'
  | 'bulk-label-git'
  | 'template-deploy'
  | 'scheduler-selector';

const ROUTE_CLASS_LIMITS: Record<RegistryDeliveryRouteClass, number> = {
  'stack-deploy-update': 512 * KIB,
  'bulk-label-git': 256 * KIB,
  'template-deploy': 128 * KIB,
  'scheduler-selector': 64 * KIB,
};

function matchesAny(path: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(path));
}

/**
 * Classify an API path into a delivery body budget group. Returns null when the
 * path is not eligible for delivery body augmentation.
 */
export function classifyRegistryDeliveryRouteClass(method: string, apiPath: string): RegistryDeliveryRouteClass | null {
  const upper = method.toUpperCase();
  if (upper !== 'POST' && upper !== 'PUT' && upper !== 'PATCH') return null;

  if (matchesAny(apiPath, [
    /^\/api\/stacks\/[^/]+\/(deploy|update|pull-update|rollback)(\/|$)/,
    /^\/api\/stacks\/[^/]+\/services\/[^/]+\/(update|pull-update)(\/|$)/,
    /^\/api\/blueprints\/apply-local$/,
  ])) {
    return 'stack-deploy-update';
  }

  if (matchesAny(apiPath, [
    /^\/api\/stacks\/bulk-update/,
    /^\/api\/labels\/[^/]+\/action/,
    /^\/api\/stacks\/from-git/,
    /^\/api\/stacks\/[^/]+\/git-source\/apply/,
    /^\/api\/fleet\/[^/]+\/snapshot/,
  ])) {
    return 'bulk-label-git';
  }

  if (apiPath === '/api/templates/deploy') {
    return 'template-deploy';
  }

  if (matchesAny(apiPath, [
    /^\/api\/scheduled-tasks\/[^/]+\/execute/,
    /^\/api\/image-updates\/selector/,
  ])) {
    return 'scheduler-selector';
  }

  return null;
}

/** Total HTTP JSON body limit for a classified route (original body + delivery field). */
export function getRegistryDeliveryTotalBodyLimit(routeClass: RegistryDeliveryRouteClass): number {
  return ROUTE_CLASS_LIMITS[routeClass];
}

/** Whether this path may receive a delivery envelope in its JSON body. */
export function isRegistryDeliveryAugmentedRoute(method: string, apiPath: string): boolean {
  return classifyRegistryDeliveryRouteClass(method, apiPath) !== null;
}
