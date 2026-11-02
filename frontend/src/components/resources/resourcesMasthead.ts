import type { MastheadMetadataItem, MastheadTone } from '@/components/ui/PageMasthead';
import { formatBytes } from '@/lib/utils';
import {
    isNamedReadFailure,
    remoteReadFailureMessage,
    type RemoteReadFailure,
} from '@/lib/remoteReadFailure';

export interface UsageData {
    reclaimableImages: number;
    reclaimableContainers: number;
    reclaimableVolumes: number;
    reclaimableImageCount: number;
    reclaimableContainerCount: number;
    reclaimableVolumeCount: number;
    managedImageBytes: number;
    unmanagedImageBytes: number;
    managedVolumeBytes: number;
    unmanagedVolumeBytes: number;
}

export type LoadState = 'loading' | 'ready' | 'error';

/** Disk usage as the page holds it: figures exist only when they were read.
 *  An error carries the cause when one is worth naming, so the card says a
 *  disconnected Pilot instead of only "could not read". */
export type UsageLoad =
    | { status: 'loading' }
    | { status: 'error'; failure?: RemoteReadFailure }
    | { status: 'ready'; data: UsageData };

export interface ResourcesMastheadModel {
    state: string;
    tone: MastheadTone;
    subtitle?: string;
    metadata: MastheadMetadataItem[];
    /** Everything a reclaim would free (images, stopped containers, volumes). */
    reclaimableBytes: number;
    /** How many things a reclaim would remove; what decides whether there is anything to do. */
    reclaimableItems: number;
}

const UNKNOWN_METADATA: MastheadMetadataItem[] = [
    { label: 'MANAGED', value: '--' },
    { label: 'EXTERNAL', value: '--' },
];

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one Answer for the Resources page: how much a reclaim would free, or that
 * the node is tidy. Unknown stays visible: a node whose usage could not be read
 * never reads as tidy.
 */
export function deriveResourcesMastheadState(load: UsageLoad, nodeName?: string | null): ResourcesMastheadModel {
    if (load.status === 'loading') {
        return { state: 'Measuring disk', tone: 'idle', metadata: UNKNOWN_METADATA, reclaimableBytes: 0, reclaimableItems: 0 };
    }
    if (load.status === 'error') {
        return {
            state: 'Disk usage unknown',
            tone: 'warn',
            subtitle: isNamedReadFailure(load.failure)
                ? remoteReadFailureMessage(load.failure, { nodeName })
                : 'Could not read disk usage from this node.',
            metadata: UNKNOWN_METADATA,
            reclaimableBytes: 0,
            reclaimableItems: 0,
        };
    }

    const usage = load.data;
    const reclaimableBytes = usage.reclaimableImages + usage.reclaimableContainers + usage.reclaimableVolumes;
    const metadata: MastheadMetadataItem[] = [
        { label: 'MANAGED', value: formatBytes(usage.managedImageBytes + usage.managedVolumeBytes) },
        { label: 'EXTERNAL', value: formatBytes(usage.unmanagedImageBytes + usage.unmanagedVolumeBytes) },
    ];
    // Items, not bytes, decide whether there is anything to do: a stopped
    // container that never wrote reclaims 0 bytes but a prune still removes it,
    // and a few bytes of storage-driver residue with nothing to remove is not work.
    const reclaimableItems = usage.reclaimableImageCount + usage.reclaimableContainerCount + usage.reclaimableVolumeCount;
    if (reclaimableItems <= 0) {
        return { state: 'Tidy', tone: 'live', subtitle: 'Nothing to reclaim on this node.', metadata, reclaimableBytes: 0, reclaimableItems: 0 };
    }

    const parts: string[] = [];
    if (usage.reclaimableImageCount > 0) parts.push(plural(usage.reclaimableImageCount, 'unused image', 'unused images'));
    if (usage.reclaimableContainerCount > 0) parts.push(plural(usage.reclaimableContainerCount, 'stopped container', 'stopped containers'));
    if (usage.reclaimableVolumeCount > 0) parts.push(plural(usage.reclaimableVolumeCount, 'dangling volume', 'dangling volumes'));
    return {
        state: reclaimableBytes > 0 ? `${formatBytes(reclaimableBytes)} reclaimable` : 'Cleanup available',
        tone: 'warn',
        subtitle: parts.join(' · '),
        metadata,
        reclaimableBytes,
        reclaimableItems,
    };
}
