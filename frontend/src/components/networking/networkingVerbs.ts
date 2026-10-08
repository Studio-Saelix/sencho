import { isNetworkingActionVisible } from '@/lib/networking';
import type { NetworkingFinding, NetworkingRecommendedAction } from '@/types/networking';

/** A finding's resolving verb: what the button says, and how many clicks it takes to finish. */
export interface NetworkingVerb {
  label: string;
  /** 1 runs or navigates at once; 2 asks in an overlay first. */
  clicks: 1 | 2;
  action: NetworkingRecommendedAction | { kind: 'acknowledge-in-doctor' };
}

export interface NetworkingVerbContext {
  isAdmin: boolean;
  /** Mirrors the stack-edit route guard, so a button never answers 403. */
  canEditStack: (stack: string) => boolean;
}

export interface NetworkingVerbs {
  primary: NetworkingVerb | null;
  /** Everything else the account may do with the finding, for the overflow menu. */
  more: NetworkingVerb[];
}

const COPY_KINDS: readonly NetworkingRecommendedAction['kind'][] = ['copy-compose-snippet', 'copy-docker-command'];
const TWO_CLICK_KINDS: readonly NetworkingRecommendedAction['kind'][] = ['set-exposure-intent', 'create-network'];

function toVerb(action: NetworkingRecommendedAction): NetworkingVerb {
  return { label: action.label, clicks: TWO_CLICK_KINDS.includes(action.kind) ? 2 : 1, action };
}

/** A card only Compose Doctor reported: nothing live backs it, so it is acknowledged there rather than dismissed here. */
export function isDoctorOnly(finding: Pick<NetworkingFinding, 'sources'>): boolean {
  return finding.sources.length > 0 && !finding.sources.includes('live');
}

/**
 * The verb that resolves a finding where it is listed, and the rest in the
 * overflow menu. Decided from the finding's structured actions, never its
 * wording. Copy actions are never the headline verb: an account that cannot
 * run the first one falls back to the finding's named navigation.
 */
export function resolveNetworkingVerbs(finding: NetworkingFinding, context: NetworkingVerbContext): NetworkingVerbs {
  const allowed = finding.recommendedActions.filter(action => isNetworkingActionVisible(action, context.isAdmin, context.canEditStack));
  const verbs = allowed.map(toVerb);
  const headline = (verb: NetworkingVerb): boolean => verb.action.kind !== 'open-stack-doctor'
    && !COPY_KINDS.includes(verb.action.kind as NetworkingRecommendedAction['kind']);

  if (isDoctorOnly(finding) && finding.stack !== undefined && context.canEditStack(finding.stack)) {
    const acknowledge: NetworkingVerb = { label: 'Acknowledge in Doctor', clicks: 2, action: { kind: 'acknowledge-in-doctor' } };
    return { primary: acknowledge, more: verbs };
  }
  const primary = verbs.find(headline) ?? null;
  return { primary, more: verbs.filter(verb => verb !== primary) };
}
