/**
 * Teardown for the GitOps converge journey spec.
 *
 * The journey creates persistent state the suite must not leave behind: a Git
 * source, a stack, a generic webhook, and a temporarily shortened health-gate
 * window. Stack deletion removes provider endpoints but not generic webhooks,
 * so the webhook needs its own request.
 *
 * Every step runs even when an earlier one fails, and every response is
 * checked; the collected failures are thrown together at the end. That way a
 * single bad request cannot strand the rest of the fixture, and a cleanup that
 * did not fully clean cannot pass silently.
 */

export interface CleanupResponse {
  status: number;
}

export type CleanupApi = (path: string, init: { method: string; body?: unknown }) => Promise<CleanupResponse>;

export interface JourneyCleanupTargets {
  stackName: string;
  /** True once the stack and its Git source exist. */
  attached: boolean;
  /** The generic webhook this run created, or null if it never got that far. */
  webhookId: number | null;
  /** The health-gate window read before the run changed it. */
  previousGateWindow: string;
}

interface CleanupStep {
  label: string;
  path: string;
  init: { method: string; body?: unknown };
}

function cleanupSteps(targets: JourneyCleanupTargets): CleanupStep[] {
  const steps: CleanupStep[] = [];
  if (targets.webhookId !== null) {
    steps.push({
      label: `webhook ${targets.webhookId}`,
      path: `/api/webhooks/${targets.webhookId}`,
      init: { method: 'DELETE' },
    });
  }
  if (targets.attached) {
    steps.push(
      { label: 'Git source', path: `/api/stacks/${targets.stackName}/git-source`, init: { method: 'DELETE' } },
      { label: 'stack', path: `/api/stacks/${targets.stackName}`, init: { method: 'DELETE' } },
    );
  }
  steps.push({
    label: 'health-gate window',
    path: '/api/settings',
    init: { method: 'PATCH', body: { health_gate_window_seconds: Number(targets.previousGateWindow) } },
  });
  return steps;
}

/**
 * Delete everything the journey created and restore the gate window. Every
 * step runs regardless of earlier failures; a failed step is reported after
 * the remaining restoration has been attempted.
 */
export async function cleanupJourneyResources(callApi: CleanupApi, targets: JourneyCleanupTargets): Promise<void> {
  const failures: string[] = [];
  for (const step of cleanupSteps(targets)) {
    try {
      const { status } = await callApi(step.path, step.init);
      if (status < 200 || status >= 300) failures.push(`${step.label}: HTTP ${status}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${step.label}: ${detail}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`journey cleanup failed for ${failures.join('; ')}`);
  }
}
