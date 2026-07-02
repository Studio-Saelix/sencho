import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { CATEGORY_LABELS } from '@/lib/notificationCategories';
import type { NotificationCategory, NotificationItem } from '@/components/dashboard/types';

export type MuteRuleLevel = 'info' | 'warning' | 'error';
export type MuteRuleAppliesTo = 'bell' | 'external' | 'both';

export type MuteRuleDraft = {
    name: string;
    node_id?: number | null;
    stack_patterns?: string[];
    label_ids?: number[] | null;
    categories?: NotificationCategory[] | null;
    levels?: MuteRuleLevel[] | null;
    applies_to?: MuteRuleAppliesTo;
    enabled?: boolean;
    expires_at?: number | null;
};

export const MUTE_RULES_CHANGED_EVENT = 'sencho:mute-rules-changed';

export function emitMuteRulesChanged(): void {
    window.dispatchEvent(new CustomEvent(MUTE_RULES_CHANGED_EVENT));
}

const DEFAULT_BODY = {
    applies_to: 'both' as MuteRuleAppliesTo,
    enabled: true,
    expires_at: null as number | null,
    node_id: null as number | null,
    stack_patterns: [] as string[],
    label_ids: null as number[] | null,
    categories: null as NotificationCategory[] | null,
    levels: null as MuteRuleLevel[] | null,
};

export async function createMuteRule(draft: MuteRuleDraft): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await apiFetch('/notification-suppression-rules', {
            method: 'POST',
            body: JSON.stringify({ ...DEFAULT_BODY, ...draft }),
        });
        if (res.ok) {
            emitMuteRulesChanged();
            return { ok: true };
        }
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: (err as { error?: string })?.error || 'Failed to create mute rule.' };
    } catch {
        return { ok: false, error: 'Network error.' };
    }
}

export async function createMuteRuleWithToast(
    draft: MuteRuleDraft,
    successMessage = 'Mute rule created. Open Settings · Mute Rules to edit it.',
): Promise<boolean> {
    const result = await createMuteRule(draft);
    if (result.ok) {
        toast.success(successMessage);
        return true;
    }
    toast.error(result.error || 'Failed to create mute rule.');
    return false;
}

export function stackMuteAllDraft(stackName: string, nodeId?: number | null): MuteRuleDraft {
    return {
        name: `Mute ${stackName}`,
        node_id: nodeId ?? null,
        stack_patterns: [stackName],
    };
}

export function stackMuteDeploySuccessDraft(stackName: string, nodeId?: number | null): MuteRuleDraft {
    return {
        name: `Mute ${stackName} deploy success`,
        node_id: nodeId ?? null,
        stack_patterns: [stackName],
        categories: ['deploy_success'],
    };
}

export function stackMuteMonitorDraft(stackName: string, nodeId?: number | null): MuteRuleDraft {
    return {
        name: `Mute ${stackName} monitor alerts`,
        node_id: nodeId ?? null,
        stack_patterns: [stackName],
        categories: ['monitor_alert'],
    };
}

export function nodeMuteAllDraft(nodeId: number, nodeName: string): MuteRuleDraft {
    return {
        name: `Mute ${nodeName}`,
        node_id: nodeId,
    };
}

export function nodeMuteUpdatesDraft(nodeId: number, nodeName: string): MuteRuleDraft {
    return {
        name: `Mute ${nodeName} update notifications`,
        node_id: nodeId,
        categories: ['image_update_available', 'node_update_available', 'update_started'],
    };
}

export function nodeMuteMonitorDraft(nodeId: number, nodeName: string): MuteRuleDraft {
    return {
        name: `Mute ${nodeName} monitor alerts`,
        node_id: nodeId,
        categories: ['monitor_alert'],
    };
}

export function labelMuteAllDraft(labelId: number, labelName: string, nodeId?: number | null): MuteRuleDraft {
    return {
        name: `Mute label: ${labelName}`,
        node_id: nodeId ?? null,
        label_ids: [labelId],
        applies_to: 'both',
    };
}

export function labelMuteExternalDraft(labelId: number, labelName: string, nodeId?: number | null): MuteRuleDraft {
    return {
        name: `Mute external for label: ${labelName}`,
        node_id: nodeId ?? null,
        label_ids: [labelId],
        applies_to: 'external',
    };
}

export function labelMuteLowPriorityDraft(labelId: number, labelName: string, nodeId?: number | null): MuteRuleDraft {
    return {
        name: `Mute low-priority alerts for label: ${labelName}`,
        node_id: nodeId ?? null,
        label_ids: [labelId],
        levels: ['info', 'warning'],
    };
}

export type BellMuteMode = 'category' | 'similar' | 'stack';

export function muteDraftFromNotification(
    notif: NotificationItem,
    mode: BellMuteMode,
): MuteRuleDraft | null {
    const categoryLabel = notif.category ? CATEGORY_LABELS[notif.category as NotificationCategory] : 'alert';

    if (mode === 'category' && notif.category) {
        return {
            name: `Mute ${categoryLabel}`,
            node_id: notif.nodeId ?? null,
            categories: [notif.category as NotificationCategory],
        };
    }
    if (mode === 'stack' && notif.stack_name) {
        return {
            name: `Mute ${notif.stack_name}`,
            node_id: notif.nodeId ?? null,
            stack_patterns: [notif.stack_name],
        };
    }
    if (mode === 'similar') {
        return {
            name: 'Mute similar alerts',
            node_id: notif.nodeId ?? null,
            categories: notif.category ? [notif.category as NotificationCategory] : null,
            levels: [notif.level],
            stack_patterns: notif.stack_name ? [notif.stack_name] : [],
        };
    }
    return null;
}

export async function createMuteFromNotification(
    notif: NotificationItem,
    mode: BellMuteMode,
): Promise<boolean> {
    const draft = muteDraftFromNotification(notif, mode);
    if (!draft) {
        toast.error('This notification cannot be muted with that shortcut.');
        return false;
    }
    return createMuteRuleWithToast(draft);
}
