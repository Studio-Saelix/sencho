import { Combobox } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { TogglePill } from '@/components/ui/toggle-pill';
import { useDensity } from '@/hooks/use-density';
import type { Density } from '@/hooks/use-density';
import { useDeployFeedbackEnabled } from '@/hooks/use-deploy-feedback-enabled';
import { useDeployFeedbackStyle, type DeployFeedbackStyle } from '@/hooks/use-deploy-feedback-style';
import { useComposeDiffPreviewEnabled } from '@/hooks/use-compose-diff-preview-enabled';
import { useTopNavLabels } from '@/hooks/use-top-nav-labels';
import { useTheme, THEME_MODE_OPTIONS, ACCENTS, CONTRAST, BORDER_BOOST, GLOW, TYPE_SCALE } from '@/hooks/use-theme';
import { AccentPicker } from '@/components/theme/AccentPicker';
import { ThemePreview } from '@/components/theme/ThemePreview';
import { TypeChips } from '@/components/theme/TypeChips';
import { UI_FONT_OPTIONS, MONO_FONT_OPTIONS } from '@/components/theme/typeOptions';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsSecondaryButton } from './SettingsActions';

const DENSITY_OPTIONS: { value: Density; label: string }[] = [
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'compact', label: 'Compact' },
];

const DENSITY_DESCRIPTIONS: Record<Density, string> = {
    comfortable: 'Default spacing. Roomy rows for review and orientation.',
    compact: 'Tighter rows and tiles. Fits more on screen for dense dashboards.',
};

const DEPLOY_STYLE_OPTIONS: { value: DeployFeedbackStyle; label: string }[] = [
    { value: 'modal', label: 'Modal' },
    { value: 'inline', label: 'Inline' },
];

const fmtSigned = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

export function AppearanceSection() {
    const [density, setDensity] = useDensity();
    const [isEnabled, setEnabled] = useDeployFeedbackEnabled();
    const [feedbackStyle, setFeedbackStyle] = useDeployFeedbackStyle();
    const [diffPreviewEnabled, setDiffPreviewEnabled] = useComposeDiffPreviewEnabled();
    const [topNavLabels, setTopNavLabels] = useTopNavLabels();
    const {
        theme, accent, borderBoost, glow, contrast, uiFont, monoFont, typeScale,
        setTheme, setAccent, setBorderBoost, setGlow, setContrast, setUiFont, setMonoFont, setTypeScale,
    } = useTheme();
    const accentLabel = ACCENTS.find((a) => a.id === accent)?.label ?? 'Cyan';

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Theme" kicker="this browser">
                <div className="pt-3">
                    <ThemePreview />
                </div>

                <SettingsField
                    label="Mode"
                    helper="Dim lifts surfaces off black; OLED is true black; Light inverts; Auto follows your OS."
                >
                    <SegmentedControl
                        value={theme}
                        options={THEME_MODE_OPTIONS}
                        onChange={setTheme}
                        ariaLabel="Theme mode"
                    />
                </SettingsField>

                <SettingsField
                    label="Accent"
                    helper={`The one data color, used for charts, rails, and focus. Currently ${accentLabel}.`}
                    align="start"
                >
                    <AccentPicker value={accent} onChange={setAccent} />
                </SettingsField>

                <SettingsField
                    label="Contrast"
                    helper="Master contrast: spreads the page, ink, and borders together. Pair high contrast with OLED for the crispest panel."
                >
                    <div className="flex items-center gap-3">
                        <Slider
                            value={[contrast]}
                            min={CONTRAST.min}
                            max={CONTRAST.max}
                            step={CONTRAST.step}
                            onValueChange={([v]) => setContrast(v)}
                            aria-label="Contrast"
                        />
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-stat-subtitle">
                            {fmtSigned(contrast)}
                        </span>
                    </div>
                </SettingsField>

                <SettingsField
                    label="Border brightness"
                    helper="Lift or soften every hairline so separation reads exactly how you like it."
                >
                    <div className="flex items-center gap-3">
                        <Slider
                            value={[borderBoost]}
                            min={BORDER_BOOST.min}
                            max={BORDER_BOOST.max}
                            step={BORDER_BOOST.step}
                            onValueChange={([v]) => setBorderBoost(v)}
                            aria-label="Border brightness"
                        />
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-stat-subtitle">
                            {fmtSigned(borderBoost)}
                        </span>
                    </div>
                </SettingsField>

                <SettingsField
                    label="Ambient glow"
                    helper="Intensity of the accent-tinted glow behind the page."
                >
                    <div className="flex items-center gap-3">
                        <Slider
                            value={[glow]}
                            min={GLOW.min}
                            max={GLOW.max}
                            step={GLOW.step}
                            onValueChange={([v]) => setGlow(v)}
                            aria-label="Ambient glow"
                        />
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-stat-subtitle">
                            {glow.toFixed(2)}
                        </span>
                    </div>
                </SettingsField>

                <SettingsActions>
                    <SettingsSecondaryButton
                        onClick={() => {
                            setContrast(CONTRAST.default);
                            setBorderBoost(BORDER_BOOST.default);
                            setGlow(GLOW.default);
                        }}
                    >
                        Reset fine-tune
                    </SettingsSecondaryButton>
                </SettingsActions>
            </SettingsSection>

            <SettingsSection title="Typography" kicker="this browser">
                <SettingsField
                    label="Interface font"
                    helper="The sans face for body, labels, nav, and buttons. Display headings stay Instrument Serif."
                    align="start"
                >
                    <TypeChips value={uiFont} options={UI_FONT_OPTIONS} onChange={setUiFont} ariaLabel="Interface font" />
                </SettingsField>

                <SettingsField
                    label="Data font"
                    helper="The mono face for terminal, stats, codes, and timestamps."
                    align="start"
                >
                    <TypeChips value={monoFont} options={MONO_FONT_OPTIONS} onChange={setMonoFont} ariaLabel="Data font" />
                </SettingsField>

                <SettingsField
                    label="Text size"
                    helper="Scales the whole interface from a single root multiplier. Default 1.00×."
                >
                    <div className="flex items-center gap-3">
                        <Slider
                            value={[typeScale]}
                            min={TYPE_SCALE.min}
                            max={TYPE_SCALE.max}
                            step={TYPE_SCALE.step}
                            onValueChange={([v]) => setTypeScale(v)}
                            aria-label="Text size"
                        />
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-stat-subtitle">
                            {typeScale.toFixed(2)}×
                        </span>
                    </div>
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Display" kicker="this browser">
                <SettingsField
                    label="Density"
                    helper={DENSITY_DESCRIPTIONS[density]}
                >
                    <Combobox
                        options={DENSITY_OPTIONS}
                        value={density}
                        onValueChange={(v) => {
                            if (v === 'comfortable' || v === 'compact') setDensity(v);
                        }}
                        placeholder="Select density"
                    />
                </SettingsField>

                <SettingsField
                    label="Top navigation labels"
                    helper="Show text labels beside top navigation icons. Turn off for a more compact navigation bar."
                >
                    <TogglePill checked={topNavLabels} onChange={setTopNavLabels} />
                </SettingsField>

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
