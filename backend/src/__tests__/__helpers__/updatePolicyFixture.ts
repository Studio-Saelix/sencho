import { evaluateUpdatePolicy, type UpdatePolicyResult, type UpdateTarget, type UpdateTrigger } from '../../services/updatePolicy';
import { resolveSenchoLabels } from '../../helpers/senchoLabels';

export interface FixtureService {
  update?: 'auto' | 'manual' | 'disabled' | string;
  notifyRoute?: string;
}

/**
 * A rendered Compose model with the given services. Labels go through the real
 * registry resolver, so a fixture never invents a resolution.
 */
export function renderedModel(services: Record<string, FixtureService>): unknown {
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, declared]) => {
        const labels: Record<string, string> = {};
        if (declared.update !== undefined) labels['io.sencho.update'] = declared.update;
        if (declared.notifyRoute !== undefined) labels['io.sencho.notify.route'] = declared.notifyRoute;
        return [name, { image: `example/${name}:latest`, labels }];
      }),
    ),
  };
}

/**
 * An allowing policy decision for a test. The result type is branded, so only
 * the evaluator can mint one, and that is exactly what these fixtures exercise:
 * a test never builds a decision by casting.
 */
export function allowingPolicy(
  stack: string,
  target: UpdateTarget = { scope: 'stack' },
  trigger: UpdateTrigger = 'manual',
  services: Record<string, FixtureService> = { web: {} },
): UpdatePolicyResult {
  return evaluateUpdatePolicy(resolveSenchoLabels(renderedModel(services)), { stack, target, trigger });
}

/** A refusing policy decision, for a stack with a disabled service. */
export function blockingPolicy(
  stack: string,
  target: UpdateTarget = { scope: 'stack' },
  trigger: UpdateTrigger = 'manual',
): UpdatePolicyResult {
  return evaluateUpdatePolicy(
    resolveSenchoLabels(renderedModel({ web: {}, db: { update: 'disabled' } })),
    { stack, target, trigger },
  );
}

/** A policy decision for a service the model does not contain (fails closed). */export function missingServicePolicy(
  stack: string,
  serviceName: string,
  trigger: UpdateTrigger = 'manual',
): UpdatePolicyResult {
  return evaluateUpdatePolicy(
    resolveSenchoLabels(renderedModel({ web: {} })),
    { stack, target: { scope: 'service', serviceName }, trigger },
  );
}
