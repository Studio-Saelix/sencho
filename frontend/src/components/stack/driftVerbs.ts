import type { StackDriftFinding } from '@/types/drift';

export type DriftVerb =
  /** Deploy the stack so the running services match compose. Consequential, so it confirms first. */
  | { kind: 'redeploy'; label: string; clicks: 2; confirm: string }
  | { kind: 'start-service'; label: string; clicks: 1 }
  | { kind: 'open-editor'; label: string; clicks: 1 }
  | { kind: 'open-git-source'; label: string; clicks: 1 };

/** What the account and the host panel allow; each field mirrors the route guard or handler a verb needs. */
export interface DriftVerbContext {
  /** `stack:deploy` on the stack: the deploy and service start routes. */
  canDeploy: boolean;
  /** The host mounted a deploy handler; the start-service verb does not need one. */
  hasRedeploy: boolean;
  hasEditor: boolean;
  hasGitSource: boolean;
}

export interface DriftResolution {
  /** One sentence naming the fix, shown under the finding. */
  remediation: string;
  primary: DriftVerb | null;
  secondary: DriftVerb[];
}

const OPEN_EDITOR: DriftVerb = { kind: 'open-editor', label: 'Open stack editor', clicks: 1 };

function redeploy(label: string, confirm: string): DriftVerb {
  return { kind: 'redeploy', label, clicks: 2, confirm };
}

const MATCH_COMPOSE = 'Runs a deploy so the services that differ are recreated to match the compose file.';

interface Plan {
  remediation: string;
  verbs: DriftVerb[];
}

function planFor(finding: Pick<StackDriftFinding, 'kind' | 'service' | 'imageAge'>): Plan {
  switch (finding.kind) {
    case 'image-mismatch':
      if (finding.imageAge === 'running-newer') {
        return {
          remediation: 'The running image is newer than the one compose names. Update compose to keep it, or redeploy to go back to the compose image.',
          verbs: [
            OPEN_EDITOR,
            redeploy(
              'Redeploy to compose image',
              `The running ${finding.service} image is newer than the one compose names. Redeploying moves it back to the older compose image.`,
            ),
          ],
        };
      }
      return {
        remediation: 'Redeploy so the service runs the image compose names, or update compose to match what is running.',
        verbs: [redeploy('Redeploy to match compose', MATCH_COMPOSE), OPEN_EDITOR],
      };
    case 'ports-mismatch':
      return {
        remediation: 'Redeploy so the service publishes the ports compose declares, or update compose to match.',
        verbs: [redeploy('Redeploy to match compose', MATCH_COMPOSE), OPEN_EDITOR],
      };
    case 'network-undeclared':
      return {
        remediation: 'Redeploy to attach the service only to the networks compose declares, or declare the extra networks in compose.',
        verbs: [redeploy('Redeploy to match compose', MATCH_COMPOSE), OPEN_EDITOR],
      };
    case 'network-missing':
      return {
        remediation: 'A declared network is unused by running services or absent at runtime. Remove it from compose if it is not needed, or attach a service to it.',
        verbs: [OPEN_EDITOR],
      };
    case 'service-missing':
      return {
        remediation: 'Start the service, or redeploy if its container was removed.',
        verbs: [
          { kind: 'start-service', label: 'Start service', clicks: 1 },
          redeploy('Redeploy to match compose', MATCH_COMPOSE),
        ],
      };
    case 'service-undeclared':
      return {
        remediation: 'A container runs that compose does not declare. Declare the service in compose, or remove the container.',
        verbs: [OPEN_EDITOR],
      };
    case 'managed-path-conflict':
      return {
        remediation: 'A Git-managed file was changed outside Git. Resolve it from the Git source.',
        verbs: [{ kind: 'open-git-source', label: 'Open Git source', clicks: 1 }],
      };
  }
}

function available(verb: DriftVerb, ctx: DriftVerbContext): boolean {
  switch (verb.kind) {
    case 'redeploy':
      return ctx.canDeploy && ctx.hasRedeploy;
    case 'start-service':
      return ctx.canDeploy;
    case 'open-editor':
      return ctx.hasEditor;
    case 'open-git-source':
      return ctx.hasGitSource;
  }
}

/**
 * The fix a drift finding names and the verbs that run it, decided from its kind
 * and structured facts only. Pure and never reads message text. A verb the
 * account or the host cannot run is dropped rather than left to fail, so the
 * next verb in the finding's own order leads (a deployer-less viewer sees Open
 * stack editor, never a Redeploy that would answer 403).
 */
export function resolveDriftFinding(
  finding: Pick<StackDriftFinding, 'kind' | 'service' | 'imageAge'>,
  ctx: DriftVerbContext,
): DriftResolution {
  const { remediation, verbs } = planFor(finding);
  const usable = verbs.filter(verb => available(verb, ctx));
  return { remediation, primary: usable[0] ?? null, secondary: usable.slice(1) };
}
