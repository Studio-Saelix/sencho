import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useDeployFeedbackEnabled } from '@/hooks/use-deploy-feedback-enabled';
import { useDeployFeedbackStyle, type DeployFeedbackStyle } from '@/hooks/use-deploy-feedback-style';
import { useComposeDiffPreviewEnabled } from '@/hooks/use-compose-diff-preview-enabled';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';

const DEPLOY_STYLE_OPTIONS: { value: DeployFeedbackStyle; label: string }[] = [
    { value: 'modal', label: 'Modal' },
    { value: 'inline', label: 'Inline' },
];

export function StacksSection() {
    const [isEnabled, setEnabled] = useDeployFeedbackEnabled();
    const [feedbackStyle, setFeedbackStyle] = useDeployFeedbackStyle();
    const [diffPreviewEnabled, setDiffPreviewEnabled] = useComposeDiffPreviewEnabled();

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
        </div>
    );
}
