import { vi } from 'vitest';
import type { PolicyRequest, UpdateTarget, UpdateTrigger } from '../../services/updatePolicy';

/**
 * A module mock for `services/updatePolicy` that allows every request.
 *
 * Several route and scheduler suites replace `ComposeService.getInstance` with a
 * plain object. The policy module holds the class from its own import, so it
 * would still perform a real render, fail closed, and turn every update in those
 * suites into a refusal. The policy's own behavior is covered by
 * `update-policy.test.ts`, `update-policy-routes.test.ts` and
 * `update-policy-proxy.test.ts`; these suites are about everything around it.
 *
 * The allowing decision is still minted by the real evaluator from a real
 * registry resolution, so the brand and the request match the caller's exactly.
 */
export async function allowingUpdatePolicyModule() {
  const actual = await vi.importActual<typeof import('../../services/updatePolicy')>(
    '../../services/updatePolicy',
  );
  const { resolveSenchoLabels } = await vi.importActual<typeof import('../../helpers/senchoLabels')>(
    '../../helpers/senchoLabels',
  );

  const mint = (request: PolicyRequest) => {
    const service = request.target.scope === 'service' ? request.target.serviceName : 'web';
    return actual.evaluateUpdatePolicy(
      resolveSenchoLabels({ services: { [service]: { image: 'nginx:1' } } }),
      request,
    );
  };

  return {
    ...actual,
    resolveUpdatePolicy: async (_nodeId: number, request: PolicyRequest) => mint(request),
    resolveUpdatePolicyPair: async (_nodeId: number, stack: string, target: UpdateTarget) => ({
      manual: mint({ stack, target, trigger: 'manual' as UpdateTrigger }),
      unattended: mint({ stack, target, trigger: 'scheduled' as UpdateTrigger }),
    }),
  };
}

/** The `vi.mock` factory form, for a suite that wants every update allowed. */
export function allowEveryUpdatePolicy(): Promise<unknown> {
  return allowingUpdatePolicyModule();
}
