import { useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import {
    createMuteRuleWithToast,
    stackMuteAllDraft,
    stackMuteDeploySuccessDraft,
    stackMuteMonitorDraft,
    labelMuteAllDraft,
    labelMuteExternalDraft,
    labelMuteLowPriorityDraft,
    nodeMuteAllDraft,
    nodeMuteUpdatesDraft,
    nodeMuteMonitorDraft,
    type MuteRuleDraft,
} from '@/lib/muteRules';

export type OpenMuteRulesPrefill = (draft: MuteRuleDraft) => void;

export function useCanMuteNotifications(): boolean {
    const { isAdmin } = useAuth();
    const { hasCapability } = useNodes();
    return isAdmin && hasCapability('notification-suppression');
}

export function useStackMuteActions(stackName: string, openMuteRulesWithPrefill: OpenMuteRulesPrefill) {
    const { activeNode } = useNodes();
    const canMute = useCanMuteNotifications();
    const nodeId = activeNode?.id ?? null;

    const muteAll = useCallback(() => {
        void createMuteRuleWithToast(stackMuteAllDraft(stackName, nodeId));
    }, [stackName, nodeId]);

    const muteDeploySuccess = useCallback(() => {
        void createMuteRuleWithToast(stackMuteDeploySuccessDraft(stackName, nodeId));
    }, [stackName, nodeId]);

    const muteMonitor = useCallback(() => {
        void createMuteRuleWithToast(stackMuteMonitorDraft(stackName, nodeId));
    }, [stackName, nodeId]);

    const manage = useCallback(() => {
        openMuteRulesWithPrefill(stackMuteAllDraft(stackName, nodeId));
    }, [stackName, nodeId, openMuteRulesWithPrefill]);

    return useMemo(
        () => ({ canMute, muteAll, muteDeploySuccess, muteMonitor, manage }),
        [canMute, muteAll, muteDeploySuccess, muteMonitor, manage],
    );
}

export function useLabelMuteActions(
    labelId: number,
    labelName: string,
    openMuteRulesWithPrefill: OpenMuteRulesPrefill,
) {
    const { activeNode } = useNodes();
    const canMute = useCanMuteNotifications();
    const nodeId = activeNode?.id ?? null;

    const muteAll = useCallback(() => {
        void createMuteRuleWithToast(labelMuteAllDraft(labelId, labelName, nodeId));
    }, [labelId, labelName, nodeId]);

    const muteExternal = useCallback(() => {
        void createMuteRuleWithToast(labelMuteExternalDraft(labelId, labelName, nodeId));
    }, [labelId, labelName, nodeId]);

    const muteLowPriority = useCallback(() => {
        void createMuteRuleWithToast(labelMuteLowPriorityDraft(labelId, labelName, nodeId));
    }, [labelId, labelName, nodeId]);

    const manage = useCallback(() => {
        openMuteRulesWithPrefill(labelMuteAllDraft(labelId, labelName, nodeId));
    }, [labelId, labelName, nodeId, openMuteRulesWithPrefill]);

    return useMemo(
        () => ({ canMute, muteAll, muteExternal, muteLowPriority, manage }),
        [canMute, muteAll, muteExternal, muteLowPriority, manage],
    );
}

export function useNodeMuteActions(nodeId: number, nodeName: string, openMuteRulesWithPrefill: OpenMuteRulesPrefill) {
    const canMute = useCanMuteNotifications();

    const muteAll = useCallback(() => {
        void createMuteRuleWithToast(nodeMuteAllDraft(nodeId, nodeName));
    }, [nodeId, nodeName]);

    const muteUpdates = useCallback(() => {
        void createMuteRuleWithToast(nodeMuteUpdatesDraft(nodeId, nodeName));
    }, [nodeId, nodeName]);

    const muteMonitor = useCallback(() => {
        void createMuteRuleWithToast(nodeMuteMonitorDraft(nodeId, nodeName));
    }, [nodeId, nodeName]);

    const manage = useCallback(() => {
        openMuteRulesWithPrefill(nodeMuteAllDraft(nodeId, nodeName));
    }, [nodeId, nodeName, openMuteRulesWithPrefill]);

    return useMemo(
        () => ({ canMute, muteAll, muteUpdates, muteMonitor, manage }),
        [canMute, muteAll, muteUpdates, muteMonitor, manage],
    );
}
