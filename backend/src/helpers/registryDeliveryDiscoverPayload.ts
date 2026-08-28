import { hashActionSet } from './registryDeliveryHashes';
import { classifyRegistryDeliveryOp, type RegistryDeliveryStage } from './registryOpClassifier';

function resolveStackName(body: Record<string, unknown>, classificationStack?: string): string | undefined {
  if (classificationStack) return classificationStack;
  const stackName = body.stackName ?? body.stack_name;
  return typeof stackName === 'string' && stackName.length > 0 ? stackName : undefined;
}

function sourceKindForStage(stage: RegistryDeliveryStage): string {
  switch (stage) {
    case 'template-deploy':
      return 'request-generated';
    case 'from-git-deploy-now':
    case 'git-apply-auto-deploy':
      return 'git-candidate';
    case 'stack-deploy':
      return 'live-project';
    default:
      return 'live-project';
  }
}

function requiredActionsForStage(stage: RegistryDeliveryStage): string[] {
  switch (stage) {
    case 'git-apply-auto-deploy':
      return ['stack:edit', 'stack:deploy'];
    case 'template-deploy':
    case 'from-git-deploy-now':
      return ['stack:deploy', 'stack:create'];
    default:
      return ['stack:deploy'];
  }
}

export function buildRegistryDiscoverPayload(options: {
  method: string;
  apiPath: string;
  body: Record<string, unknown>;
}): Record<string, unknown> | null {
  const classification = classifyRegistryDeliveryOp(options.method, options.apiPath);
  if (!classification.eligible || !classification.stage) return null;

  const stack = resolveStackName(options.body, classification.stack);
  const stage = classification.stage;
  const isRollback = Boolean(options.apiPath.match(/^\/api\/stacks\/[^/]+\/rollback$/));
  const sourceKind = isRollback ? 'restore-candidate' : sourceKindForStage(stage);

  const payload: Record<string, unknown> = {
    stack,
    op: isRollback ? 'stack-deploy' : stage,
    service: classification.service,
    sourceKind,
    actionSetHash: hashActionSet(
      isRollback ? ['stack:deploy'] : requiredActionsForStage(stage),
    ),
  };

  if (stage === 'template-deploy') {
    payload.stackName = options.body.stackName;
    payload.template = options.body.template;
    payload.envVars = options.body.envVars;
  }

  if (stage === 'from-git-deploy-now') {
    payload.stack = options.body.stack_name;
    payload.git = {
      stackName: options.body.stack_name,
      repo_url: options.body.repo_url,
      branch: options.body.branch,
      compose_path: options.body.compose_path,
      compose_paths: options.body.compose_paths,
      context_dir: options.body.context_dir,
      sync_env: options.body.sync_env,
      env_path: options.body.env_path,
      auth_type: options.body.auth_type,
      token: options.body.token,
      auto_apply_on_webhook: options.body.auto_apply_on_webhook,
      auto_deploy_on_apply: options.body.auto_deploy_on_apply,
    };
  }

  if (stage === 'git-apply-auto-deploy') {
    payload.gitApply = true;
  }

  if (isRollback) {
    payload.restoreVariant = 'backup';
  }

  if (stage === 'blueprint-apply') {
    payload.sourceKind = 'body-content';
    payload.composeContent = options.body.composeContent;
    payload.stackName = options.body.stackName;
  }

  return payload;
}

export function resolveDeliveryStack(
  method: string,
  apiPath: string,
  body: Record<string, unknown> | undefined,
): string | undefined {
  const classification = classifyRegistryDeliveryOp(method, apiPath);
  if (!classification.eligible) return undefined;
  return resolveStackName(body ?? {}, classification.stack);
}
