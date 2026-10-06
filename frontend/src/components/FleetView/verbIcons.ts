import { Ban, Download, FlaskConical, GitBranch, Network, Plug, RotateCcw, type LucideIcon } from 'lucide-react';
import type { NodeVerbId } from './nodeStatus';

/** One icon per node verb, shared by the card button and the sheet toolbar. */
export const VERB_ICON: Record<NodeVerbId, LucideIcon> = {
    'test-connection': Plug,
    update: Download,
    'update-dev': FlaskConical,
    'retry-update': RotateCcw,
    'open-gitops': GitBranch,
    'view-networking': Network,
    uncordon: Ban,
};
