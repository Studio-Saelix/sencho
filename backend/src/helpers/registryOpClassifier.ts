export type RegistryDeliveryStage =
  | 'stack-deploy'
  | 'stack-update'
  | 'stack-pull-update'
  | 'stack-pull-images'
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

  // The trailing slash is optional in every pattern below, and deliberately so:
  // Express routes the slashed form to the same handler, and the body classifier
  // in registryDeliveryBodyLimits already accepts it for these routes. When the
  // two disagreed, a slashed request still reached the handler but was forwarded
  // to a remote with no credentials attached, which surfaces as a late and very
  // confusing "unauthorized" instead of a refusal. Both gates must agree.
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/deploy\/?$/)) {
    return { eligible: true, stage: 'stack-deploy', stack };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/update\/?$/)) {
    return { eligible: true, stage: 'stack-update', stack };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/pull-update\/?$/)) {
    return { eligible: true, stage: 'stack-pull-update', stack };
  }
  // Save & Pull Images fetches the stack's registry-backed images without
  // reconciling the workload, so it needs the same credentials a deploy would.
  // The route carries no body, so the stack name reaches the discover payload
  // only through the URL match above.
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/pull-images\/?$/)) {
    return { eligible: true, stage: 'stack-pull-images', stack };
  }

  const serviceMatch = apiPath.match(/^\/api\/stacks\/([^/]+)\/services\/([^/]+)\/(update|pull-update)\/?$/);
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
  if (apiPath.match(/^\/api\/stacks\/from-git\/?$/)) {
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
  if (apiPath === '/api/auto-update/execute-checked') {
    return { eligible: true, stage: 'scheduler-auto-update', stack };
  }
  if (apiPath.match(/^\/api\/mesh\/[^/]+\/redeploy$/)) {
    return { eligible: true, stage: 'mesh-redeploy' };
  }
  if (apiPath.match(/^\/api\/stacks\/[^/]+\/rollback\/?$/)) {
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
