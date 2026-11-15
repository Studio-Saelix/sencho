import type { StatusTone } from '@/lib/statusTone';
import type { Node } from '@/context/NodeContext';

/**
 * Where a node the bootstrap registered stands, wherever the node is listed
 * (the Fleet card, the node switcher, Settings → Nodes). A connected node is
 * not called ready until the hub has verified it; one that passed shows no
 * badge, because it is then an ordinary node. Nodes enrolled by hand or
 * connected over the API proxy carry no readiness and never show one.
 */

export interface ReadinessLabel {
  tone: StatusTone;
  word: string;
  title: string;
}

const STOPPED: Record<string, ReadinessLabel> = {
  blocked: { tone: 'warning', word: 'Bootstrap blocked', title: 'The bootstrap was blocked before it changed this host. Open it from Fleet to retry or release it.' },
  failed: { tone: 'destructive', word: 'Bootstrap failed', title: 'The bootstrap failed. Open it from Fleet to see why, then retry or release it.' },
  partial: { tone: 'warning', word: 'Stopped partway', title: 'The bootstrap stopped partway. Steps that ran stay on the host.' },
  cancelled: { tone: 'neutral', word: 'Bootstrap cancelled', title: 'The bootstrap was cancelled before the Pilot connected.' },
  outcome_unknown: { tone: 'warning', word: 'Outcome unknown', title: 'Whether the last bootstrap step finished is unknown. Open it from Fleet to retry or release it.' },
  recovery_required: { tone: 'destructive', word: 'Needs recovery', title: 'The bootstrap needs recovery on the host before it can continue.' },
};

const RUNNING = new Set(['rechecking', 'running', 'enrolling']);

export function nodeReadinessLabel(readiness: Node['readiness']): ReadinessLabel | null {
  if (!readiness || readiness.state === 'ready') return null;
  if (readiness.state === 'verifying') return { tone: 'brand', word: 'Verifying', title: 'The hub is checking this node for readiness.' };
  if (readiness.state === 'not_ready') {
    return { tone: 'warning', word: 'Unverified', title: 'The Pilot is enrolled but did not pass the readiness check. Open its bootstrap from Fleet to see what failed.' };
  }
  const op = readiness.operationState;
  if (op && RUNNING.has(op)) return { tone: 'brand', word: 'Provisioning', title: 'A bootstrap is preparing this node.' };
  if (op && STOPPED[op]) return STOPPED[op];
  return { tone: 'brand', word: 'Unverified', title: 'The Pilot is enrolled. The hub checks it for readiness once its tunnel is up.' };
}
