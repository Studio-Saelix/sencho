import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { canManageNode } from '@/lib/canManageNode';
import { useDeployFeedbackEnabled } from '@/hooks/use-deploy-feedback-enabled';
import { useDeployFeedbackStyle, type DeployFeedbackStyle } from '@/hooks/use-deploy-feedback-style';
import { useComposeDiffPreviewEnabled } from '@/hooks/use-compose-diff-preview-enabled';
import { DEFAULT_SETTINGS } from './types';
import type { PatchableSettings } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { useSettingsDirty } from './useSettingsDirty';
import { useNodeSettingsLoad } from './useNodeSettingsLoad';
import { SettingsLoadGate } from './SettingsLoadError';
import { TogglePill } from '@/components/ui/toggle-pill';
import { NumberChip } from './SystemControls';

const DEPLOY_STYLE_OPTIONS: { value: DeployFeedbackStyle; label: string }[] = [
    { value: 'modal', label: 'Modal' },
    { value: 'inline', label: 'Inline' },
];

interface StacksSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

type GuardrailFields = Pick<PatchableSettings, 'health_gate_enabled' | 'health_gate_window_seconds' | 'recovery_retention_days' | 'recovery_max_generations' | 'env_block_deploy_on_missing_required' | 'auto_create_missing_external_networks'>;

const DEFAULT_GUARDRAILS: GuardrailFields = {
    health_gate_enabled: DEFAULT_SETTINGS.health_gate_enabled,
    health_gate_window_seconds: DEFAULT_SETTINGS.health_gate_window_seconds,
    recovery_retention_days: DEFAULT_SETTINGS.recovery_retention_days,
    recovery_max_generations: DEFAULT_SETTINGS.recovery_max_generations,
    env_block_deploy_on_missing_required: DEFAULT_SETTINGS.env_block_deploy_on_missing_required,
    auto_create_missing_external_networks: DEFAULT_SETTINGS.auto_create_missing_external_networks,
};

function GuardrailSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

export function StacksSection({ onDirtyChange }: StacksSectionProps) {
    // Browser-local workflow controls (unchanged, no backend fetch)
    const [isEnabled, setEnabled] = useDeployFeedbackEnabled();
    const [feedbackStyle, setFeedbackStyle] = useDeployFeedbackStyle();
    const [diffPreviewEnabled, setDiffPreviewEnabled] = useComposeDiffPreviewEnabled();

    // Node-scoped deploy guardrails
    const { activeNode } = useNodes();
    const { can } = useAuth();
    const readOnly = !canManageNode(can, activeNode?.id);
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<GuardrailFields>({ ...DEFAULT_GUARDRAILS });
    const { phase, isCurrentNodeLoaded, load, isSaveOwner, captureSaveGuard } = useNodeSettingsLoad(activeNode?.id);
    const [isSaving, setIsSaving] = useState(false);

    const reportDirty = isCurrentNodeLoaded && hasChanges;

    useEffect(() => {
        onDirtyChange?.(reportDirty);
    }, [reportDirty, onDirtyChange]);

    useMastheadStats(
        !isCurrentNodeLoaded
            ? null
            : [
                {
                    label: 'EDITED',
                    value: hasChanges ? `${dirtyCount} pending` : 'saved',
                    tone: hasChanges ? 'warn' : 'value',
                },
            ],
    );

    useEffect(() => {
        let cancelled = false;
        setIsSaving(false);
        void (async () => {
            const nodeData = await load();
            if (cancelled || !nodeData) return;
            const safe: GuardrailFields = {
                health_gate_enabled: (nodeData.health_gate_enabled as '0' | '1') ?? DEFAULT_SETTINGS.health_gate_enabled,
                health_gate_window_seconds: nodeData.health_gate_window_seconds ?? DEFAULT_SETTINGS.health_gate_window_seconds,
                recovery_retention_days: nodeData.recovery_retention_days ?? DEFAULT_SETTINGS.recovery_retention_days,
                recovery_max_generations: nodeData.recovery_max_generations ?? DEFAULT_SETTINGS.recovery_max_generations,
                env_block_deploy_on_missing_required: (nodeData.env_block_deploy_on_missing_required as '0' | '1') ?? DEFAULT_SETTINGS.env_block_deploy_on_missing_required,
                auto_create_missing_external_networks: (nodeData.auto_create_missing_external_networks as '0' | '1') ?? DEFAULT_SETTINGS.auto_create_missing_external_networks,
            };
            reset(safe);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeNode?.id, load, reset]);

    const onGuardrailChange = <K extends keyof GuardrailFields>(key: K, value: GuardrailFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveGuardrails = async () => {
        const saveGuard = captureSaveGuard();
        const submitted = { ...settings };
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                nodeId: saveGuard.nodeId,
                body: JSON.stringify(submitted),
            });
            if (!isSaveOwner(saveGuard)) return;
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('Deploy guardrail settings saved.');
        } catch (e: unknown) {
            if (!isSaveOwner(saveGuard)) return;
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            if (isSaveOwner(saveGuard)) setIsSaving(false);
        }
    };

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Workflow" kicker="this browser">
                <SettingsField
                    label="Deploy progress"
                    helper="Stream live output for deploy, restart, update, install, and Git operations, with a warning when an operation goes quiet. On by default; turn it off to run operations without it."
                >
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="deploy-feedback"
                            checked={isEnabled}
                            onCheckedChange={(v) => setEnabled(v === true)}
                        />
                        <label
                            htmlFor="deploy-feedback"
                            className="text-sm text-stat-value cursor-pointer select-none"
                        >
                            {isEnabled ? 'Enabled' : 'Disabled'}
                        </label>
                    </div>
                </SettingsField>

                {isEnabled && (
                    <SettingsField
                        label="Progress style"
                        helper="Modal opens a centered overlay. Inline shows a quiet status on the stack detail with the full log a click away under View output."
                    >
                        <SegmentedControl
                            value={feedbackStyle}
                            options={DEPLOY_STYLE_OPTIONS}
                            onChange={setFeedbackStyle}
                            ariaLabel="Deploy progress style"
                        />
                    </SettingsField>
                )}

                <SettingsField
                    label="Diff preview before save"
                    helper="Show a side-by-side diff of compose and env edits before they reach disk."
                >
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="compose-diff-preview"
                            checked={diffPreviewEnabled}
                            onCheckedChange={(v) => setDiffPreviewEnabled(v === true)}
                        />
                        <label
                            htmlFor="compose-diff-preview"
                            className="text-sm text-stat-value cursor-pointer select-none"
                        >
                            {diffPreviewEnabled ? 'Enabled' : 'Disabled'}
                        </label>
                    </div>
                </SettingsField>
            </SettingsSection>

            <p className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle/70">
                ⓘ saved to this browser only · every device remembers its own choice
            </p>

            <SettingsLoadGate phase={phase} isCurrentNodeLoaded={isCurrentNodeLoaded} skeleton={<GuardrailSkeleton />}>
                <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
                    <SettingsSection title="Deploy Guardrails" kicker="this node">
                        <p className="pb-2 text-sm leading-relaxed text-stat-subtitle">
                            Node-level safety checks and post-deploy observation used during stack deploys and updates.
                        </p>
                        <SettingsField
                            label="Observe health after updates"
                            helper="After a stack deploy or update succeeds, watch its containers for the observation window and record a passed or failed verdict on the stack timeline. Observational only: nothing is restarted or rolled back automatically. On by default."
                        >
                            <TogglePill
                                checked={settings.health_gate_enabled === '1'}
                                onChange={(next) => onGuardrailChange('health_gate_enabled', next ? '1' : '0')}
                            />
                        </SettingsField>
                        <SettingsField
                            label="Observation window"
                            helper="How long to watch containers before declaring the update healthy. Raise it for stacks that take a while to settle. Default 90 seconds."
                        >
                            <NumberChip
                                value={settings.health_gate_window_seconds || '90'}
                                onChange={(v) => onGuardrailChange('health_gate_window_seconds', v)}
                                suffix="s"
                                min={15}
                                max={600}
                            />
                        </SettingsField>
                        <SettingsField
                            label="Superseded rollback retention"
                            helper="Days an older rollback generation is retained after a newer update supersedes it, before its held image is cleaned up automatically. The current generation stays protected until it is superseded or manually released from Resources → Rollback. Default 7 days."
                        >
                            <NumberChip
                                value={settings.recovery_retention_days || '7'}
                                onChange={(v) => onGuardrailChange('recovery_retention_days', v)}
                                suffix="d"
                                min={1}
                                max={90}
                            />
                        </SettingsField>
                        <SettingsField
                            label="Maximum retained rollback generations per stack"
                            helper="Caps how many rollback generations a stack keeps at once, current generation included (so 1 keeps only the current, 2 keeps the current plus one superseded). The oldest superseded generations beyond the cap are cleaned up early, ahead of the retention window above. 0 = unlimited (retention window only)."
                        >
                            <NumberChip
                                value={settings.recovery_max_generations || '0'}
                                onChange={(v) => onGuardrailChange('recovery_max_generations', v)}
                                suffix="generations"
                                min={0}
                                max={50}
                            />
                        </SettingsField>
                        <SettingsField
                            label="Block deploy on missing required env vars"
                            helper="When on, a deploy or update is refused before it starts if a required ${VAR:?message} variable is unset or empty, so the stack fails fast with a clear message instead of mid-deploy. Off by default."
                        >
                            <TogglePill
                                checked={settings.env_block_deploy_on_missing_required === '1'}
                                onChange={(next) => onGuardrailChange('env_block_deploy_on_missing_required', next ? '1' : '0')}
                            />
                        </SettingsField>
                        <SettingsField
                            label="Automatically create missing external networks during deploy"
                            helper="When on, safe missing external bridge networks are created automatically before deploy continues. Off by default: manual deploy prompts first. Advanced drivers and custom options are never auto-created."
                        >
                            <TogglePill
                                checked={settings.auto_create_missing_external_networks === '1'}
                                onChange={(next) => onGuardrailChange('auto_create_missing_external_networks', next ? '1' : '0')}
                            />
                        </SettingsField>
                    </SettingsSection>

                    <SettingsActions hint={readOnly ? 'Read-only · permission required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
                        {!readOnly && (
                            <SettingsPrimaryButton onClick={saveGuardrails} disabled={isSaving || !hasChanges || !isCurrentNodeLoaded}>
                                {isSaving ? (
                                    <>
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                        Saving
                                    </>
                                ) : (
                                    'Save settings'
                                )}
                            </SettingsPrimaryButton>
                        )}
                    </SettingsActions>
                </fieldset>
            </SettingsLoadGate>
        </div>
    );
}
