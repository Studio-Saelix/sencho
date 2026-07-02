import type { NotificationCategory } from '../services/NotificationService';

export type NotificationLevel = 'info' | 'warning' | 'error';
export type NotificationAppliesTo = 'bell' | 'external' | 'both';

export interface NotificationFilterRule {
    node_id: number | null;
    stack_patterns: string[];
    label_ids: number[] | null;
    categories: string[] | null;
    levels?: NotificationLevel[] | null;
}

export interface NotificationMatchContext {
    localNodeId: number;
    stackName?: string;
    category: NotificationCategory;
    level: NotificationLevel;
    stackLabelIds: number[];
}

/** True when all non-empty matchers on the rule match the alert context (AND). */
export function matchesNotificationFilters(
    ctx: NotificationMatchContext,
    rule: NotificationFilterRule,
): boolean {
    if (rule.node_id != null && rule.node_id !== ctx.localNodeId) return false;
    if (
        rule.stack_patterns.length > 0
        && (ctx.stackName === undefined || !rule.stack_patterns.includes(ctx.stackName))
    ) {
        return false;
    }
    if (
        rule.label_ids != null
        && rule.label_ids.length > 0
        && !rule.label_ids.some((id) => ctx.stackLabelIds.includes(id))
    ) {
        return false;
    }
    if (
        rule.categories != null
        && rule.categories.length > 0
        && !rule.categories.includes(ctx.category)
    ) {
        return false;
    }
    if (
        rule.levels != null
        && rule.levels.length > 0
        && !rule.levels.includes(ctx.level)
    ) {
        return false;
    }
    return true;
}

export function ruleNeedsStackLabels(rules: NotificationFilterRule[]): boolean {
    return rules.some((r) => r.label_ids != null && r.label_ids.length > 0);
}

export function appliesToBell(appliesTo: NotificationAppliesTo): boolean {
    return appliesTo === 'bell' || appliesTo === 'both';
}

export function appliesToExternal(appliesTo: NotificationAppliesTo): boolean {
    return appliesTo === 'external' || appliesTo === 'both';
}
