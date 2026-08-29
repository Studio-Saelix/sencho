export type RegistryDeliveryStage =
  | 'stack-deploy'
  | 'stack-update'
  | 'stack-pull-update'
  | 'service-update'
  | 'service-pull-update'
  | 'webhook-deploy'
  | 'scheduler-auto-update'
  | 'scheduler-auto-start'
  | 'mesh-redeploy'
  | 'blueprint-apply'
  | 'fleet-label'
  | 'fleet-snapshot'
  | 'template-deploy'
  | 'from-git-deploy-now'
  | 'git-apply-auto-deploy';

export interface RegistryDeliveryClassification {
  eligible: boolean;
  stage?: RegistryDeliveryStage;
  stack?: string;
  service?: string;
}

function stackNameFromPath(apiPath: string): string | undefined {
  const match = apiPath.match(/^\/api\/stacks\/([^/]+)/);
  return match?.[1];
}

/**
 * Classify whether an API request is eligible for registry credential delivery.
 * Permission checks remain in stackRouteAuth; this only identifies delivery stages.
 */
export function classifyRegistryDeliveryOp(method: string, apiPath: string): RegistryDeliveryClassification {
  const upper = method.toUpperCase();
  if (upper !== 'POST' && upper !== 'PUT' && upper !== 'PATCH') {
    return { eligible: false };
  }

  const stack = stackNameFromPath(apiPath);

  if (apiPath.match(/^\/api\/stacks\/[^/]+\/deploy$/)) {
    return { eligible: true, stage: 'stack-deploy', stack };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/update$/)) {
    return { eligible: true, stage: 'stack-update', stack };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/pull-update$/)) {
    return { eligible: true, stage: 'stack-pull-update', stack };
  }

  const serviceMatch = apiPath.match(/^\/api\/stacks\/([^/]+)\/services\/([^/]+)\/(update|pull-update)$/);
  if (serviceMatch) {
    return {
      eligible: true,
      stage: serviceMatch[3] === 'pull-update' ? 'service-pull-update' : 'service-update',
      stack: serviceMatch[1],
      service: serviceMatch[2],
    };
  }

  if (apiPath === '/api/templates/deploy') {
    return { eligible: true, stage: 'template-deploy' };
  }
  if (apiPath === '/api/stacks/from-git') {
    return { eligible: true, stage: 'from-git-deploy-now' };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/git-source\/apply$/)) {
    return { eligible: true, stage: 'git-apply-auto-deploy', stack };
  }
  if (apiPath.match(/^\/api\/fleet\/[^/]+\/snapshot$/)) {
    return { eligible: true, stage: 'fleet-snapshot' };
  }
  if (apiPath.match(/^\/api\/labels\/[^/]+\/action$/)) {
    return { eligible: true, stage: 'fleet-label' };
  }
  if (apiPath.match(/^\/api\/scheduled-tasks\/[^/]+\/execute$/)) {
    return { eligible: true, stage: 'scheduler-auto-update' };
  }
  if (apiPath.match(/^\/api\/image-updates\/selector/)) {
    return { eligible: true, stage: 'scheduler-auto-update' };
  }
  if (apiPath.match(/^\/api\/mesh\/[^/]+\/redeploy$/)) {
    return { eligible: true, stage: 'mesh-redeploy' };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/rollback$/)) {
    return { eligible: true, stage: 'stack-deploy', stack };
  }

  if (apiPath === '/api/blueprints/apply-local') {
    return { eligible: true, stage: 'blueprint-apply' };
  }
  if (apiPath.match(/^\/api\/blueprints\/[^/]+\/apply/)) {
    return { eligible: true, stage: 'blueprint-apply' };
  }

  return { eligible: false };
}
