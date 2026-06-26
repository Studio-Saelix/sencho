import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
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
import { TogglePill } from '@/components/ui/toggle-pill';
import { NumberChip } from './SystemControls';

const DEPLOY_STYLE_OPTIONS: { value: DeployFeedbackStyle; label: string }[] = [
    { value: 'modal', label: 'Modal' },
    { value: 'inline', label: 'Inline' },
];

interface StacksSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

type GuardrailFields = Pick<PatchableSettings, 'health_gate_enabled' | 'health_gate_window_seconds' | 'env_block_deploy_on_missing_required'>;

const DEFAULT_GUARDRAILS: GuardrailFields = {
    health_gate_enabled: DEFAULT_SETTINGS.health_gate_enabled,
    health_gate_window_seconds: DEFAULT_SETTINGS.health_gate_window_seconds,
    env_block_deploy_on_missing_required: DEFAULT_SETTINGS.env_block_deploy_on_missing_required,
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
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<GuardrailFields>({ ...DEFAULT_GUARDRAILS });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        onDirtyChange?.(hasChanges);
    }, [hasChanges, onDirtyChange]);

    useMastheadStats(
        isLoading
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
        const fetchSettings = async () => {
            setIsLoading(true);
            try {
                const nodeRes = await apiFetch('/settings');
                const nodeData: Record<string, string> = nodeRes.ok ? await nodeRes.json() : {};
                const safe: GuardrailFields = {
                    health_gate_enabled: (nodeData.health_gate_enabled as '0' | '1') ?? DEFAULT_SETTINGS.health_gate_enabled,
                    health_gate_window_seconds: nodeData.health_gate_window_seconds ?? DEFAULT_SETTINGS.health_gate_window_seconds,
                    env_block_deploy_on_missing_required: (nodeData.env_block_deploy_on_missing_required as '0' | '1') ?? DEFAULT_SETTINGS.env_block_deploy_on_missing_required,
                };
                reset(safe);
            } catch (e) {
                console.error('Failed to fetch deploy guardrail settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onGuardrailChange = <K extends keyof GuardrailFields>(key: K, value: GuardrailFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveGuardrails = async () => {
        const submitted = { ...settings };
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                body: JSON.stringify(submitted),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('Deploy guardrail settings saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
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

            {isLoading ? (
                <GuardrailSkeleton />
            ) : (
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
                            label="Block deploy on missing required env vars"
                            helper="When on, a deploy or update is refused before it starts if a required ${VAR:?message} variable is unset or empty, so the stack fails fast with a clear message instead of mid-deploy. Off by default."
                        >
                            <TogglePill
                                checked={settings.env_block_deploy_on_missing_required === '1'}
                                onChange={(next) => onGuardrailChange('env_block_deploy_on_missing_required', next ? '1' : '0')}
                            />
                        </SettingsField>
                    </SettingsSection>

                    <SettingsActions hint={readOnly ? 'Read-only · admin access required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
                        {!readOnly && (
                            <SettingsPrimaryButton onClick={saveGuardrails} disabled={isSaving || !hasChanges}>
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
            )}
        </div>
    );
}
