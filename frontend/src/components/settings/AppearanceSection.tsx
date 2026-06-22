import { Check, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Combobox } from '@/components/ui/combobox';
import { Slider } from '@/components/ui/slider';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { TogglePill } from '@/components/ui/toggle-pill';
import { useDensity } from '@/hooks/use-density';
import type { Density } from '@/hooks/use-density';
import { useTopNavLabels } from '@/hooks/use-top-nav-labels';
import { useTopNavAlign, type TopNavAlign } from '@/hooks/use-top-nav-align';
import {
    useTheme, activeVisualStyle, THEME_MODE_OPTIONS, ACCENTS, CONTRAST, BORDER_BOOST, GLOW, TYPE_SCALE,
    type VisualStyle, type HeadingStyle, type ChartStyle,
} from '@/hooks/use-theme';
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

const TOP_NAV_ALIGN_OPTIONS: { value: TopNavAlign; label: string }[] = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
];

const CHART_STYLE_OPTIONS: { value: ChartStyle; label: string }[] = [
    { value: 'muted', label: 'Muted' },
    { value: 'heat', label: 'Heat' },
    { value: 'signature', label: 'Signature' },
];

const HEADING_STYLE_OPTIONS: { value: HeadingStyle; label: string }[] = [
    { value: 'clean', label: 'Clean' },
    { value: 'signature', label: 'Signature' },
];

const fmtSigned = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

// Preview swatches for the Visual style cards. Calm uses the muted ramp; Signature
// deliberately puts the brand bar next to destructive to show the clash it fixes.
interface VisualCardData {
    kind: VisualStyle;
    name: string;
    blurb: string;
    bars: string[];
}

const VISUAL_CARDS: VisualCardData[] = [
    {
        kind: 'calm',
        name: 'Calm',
        blurb: 'Upright headings, muted flat charts. The readable default.',
        bars: ['oklch(0.605 0.105 28)', 'oklch(0.715 0.085 70)', 'oklch(0.675 0.045 88)', 'oklch(0.565 0.018 250)'],
    },
    {
        kind: 'signature',
        name: 'Signature',
        blurb: "Italic serif headings, saturated charts. Today's look.",
        bars: ['var(--destructive)', 'var(--warning)', 'var(--brand)', 'color-mix(in oklch, var(--warning) 50%, var(--stat-icon))'],
    },
];
const VISUAL_BAR_HEIGHTS = [16, 11, 13, 8];

function VisualCard({
    card, selected, onSelect,
}: {
    card: VisualCardData;
    selected: boolean;
    onSelect: () => void;
}) {
    const { kind, name, blurb, bars } = card;
    const calm = kind === 'calm';
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            className={cn(
                'flex flex-col overflow-hidden rounded-lg border bg-well text-left transition-colors',
                selected
                    ? 'border-brand/55 ring-1 ring-brand/40'
                    : 'border-card-border border-t-card-border-top hover:border-t-card-border-hover',
            )}
        >
            <div className="flex h-[74px] flex-col justify-center gap-1.5 border-b border-hairline px-3.5">
                <span
                    className={cn(
                        'text-[22px] leading-none text-stat-value',
                        calm ? 'font-sans font-semibold not-italic' : 'font-display font-normal italic',
                    )}
                >
                    Critical
                </span>
                <span className="flex items-end gap-1" style={{ height: 16 }}>
                    {bars.map((b, i) => (
                        <span
                            key={i}
                            className="block w-[9px] rounded-sm"
                            style={{ background: b, height: VISUAL_BAR_HEIGHTS[i] }}
                        />
                    ))}
                </span>
            </div>
            <div className="px-3.5 pb-3 pt-2.5">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-stat-value">
                    {name}
                    {selected ? <Check className="h-3.5 w-3.5 text-brand" strokeWidth={2.5} /> : null}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-stat-subtitle">{blurb}</p>
            </div>
        </button>
    );
}

export function AppearanceSection() {
    const [density, setDensity] = useDensity();
    const [topNavLabels, setTopNavLabels] = useTopNavLabels();
    const [topNavAlign, setTopNavAlign] = useTopNavAlign();
    const {
        theme, accent, borderBoost, glow, contrast, uiFont, monoFont, typeScale,
        headingStyle, chartStyle, reducedEffects, readability,
        setTheme, setAccent, setBorderBoost, setGlow, setContrast, setUiFont, setMonoFont, setTypeScale,
        setVisualStyle, setHeadingStyle, setChartStyle, setReducedEffects, setReadability,
    } = useTheme();
    const accentLabel = ACCENTS.find((a) => a.id === accent)?.label ?? 'Cyan';
    // Readability is a sticky master: it forces the calm resolution at apply time
    // without mutating the stored sub-axes, so the controls reflect the forced
    // value and lock while it is on. Effects are reduced under readability too.
    const effectiveReduced = readability || reducedEffects;
    const effectiveContrast = contrast + (readability ? 0.18 : 0);
    // A card is selected only while the stored sub-axes still match its preset, so
    // a custom combination de-selects both (and readability resolves to null).
    // Shared with the topbar quick-switch via activeVisualStyle so both surfaces
    // agree on which style is active.
    const activeVisual = activeVisualStyle({ headingStyle, chartStyle, reducedEffects, readability });

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Visual style" kicker="the master switch">
                <div className="grid grid-cols-2 gap-2.5 pt-3">
                    {VISUAL_CARDS.map((c) => (
                        <VisualCard
                            key={c.kind}
                            card={c}
                            selected={activeVisual === c.kind}
                            onSelect={() => setVisualStyle(c.kind)}
                        />
                    ))}
                </div>
                {readability ? (
                    <div className="mt-3 flex items-start gap-2.5 rounded-md border border-brand/30 bg-brand/10 px-3 py-2.5">
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.5} />
                        <p className="text-sm leading-relaxed text-stat-title">
                            <span className="font-medium text-brand">Readability mode is on.</span> It forces the calmest
                            settings and a small contrast lift. Turn it off below to choose a style by hand.
                        </p>
                    </div>
                ) : null}
            </SettingsSection>

            <SettingsSection title="Security visualization" kicker="the chart fix">
                <SettingsField
                    label="Chart palette"
                    helper="Muted desaturates the severity colors; Heat is one warm ramp with no red/blue clash; Signature is the saturated set."
                    align="start"
                >
                    <SegmentedControl
                        value={readability ? 'muted' : chartStyle}
                        options={CHART_STYLE_OPTIONS}
                        onChange={setChartStyle}
                        disabled={readability}
                        ariaLabel="Chart palette"
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Readability" kicker="this browser">
                <SettingsField
                    label="Readability mode"
                    helper="One switch: upright headings, muted flat charts, reduced effects, and a contrast lift."
                >
                    <TogglePill checked={readability} onChange={setReadability} aria-label="Readability mode" />
                </SettingsField>

                <SettingsField
                    label="Header style"
                    helper="Clean uses the upright interface face; Signature keeps the italic display serif."
                    align="start"
                >
                    <SegmentedControl
                        value={readability ? 'clean' : headingStyle}
                        options={HEADING_STYLE_OPTIONS}
                        onChange={setHeadingStyle}
                        disabled={readability}
                        ariaLabel="Header style"
                    />
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
                            {fmtSigned(effectiveContrast)}
                        </span>
                    </div>
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Motion & effects" kicker="this browser">
                <SettingsField
                    label="Reduced effects"
                    helper="Flattens card bevels, the accent glow, and chart gradients for a calmer surface."
                >
                    <TogglePill
                        checked={effectiveReduced}
                        onChange={setReducedEffects}
                        disabled={readability}
                        aria-label="Reduced effects"
                    />
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
                            disabled={effectiveReduced}
                            aria-label="Ambient glow"
                        />
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-stat-subtitle">
                            {glow.toFixed(2)}
                        </span>
                    </div>
                </SettingsField>

                <SettingsActions>
                    <SettingsSecondaryButton
                        onClick={() => setVisualStyle('calm')}
                        disabled={readability}
                    >
                        Reset to default
                    </SettingsSecondaryButton>
                </SettingsActions>
            </SettingsSection>

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
                    helper="The sans face for body, labels, navigation, and buttons. Heading style follows your Visual style choice."
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

                {!topNavLabels && (
                    <SettingsField
                        label="Top navigation alignment"
                        helper="Place the icon-only navigation against the left edge or centered in the bar."
                    >
                        <SegmentedControl
                            value={topNavAlign}
                            options={TOP_NAV_ALIGN_OPTIONS}
                            onChange={setTopNavAlign}
                            ariaLabel="Top navigation alignment"
                        />
                    </SettingsField>
                )}
            </SettingsSection>

            <p className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle/70">
                ⓘ saved to this browser only · every device remembers its own choice
            </p>
        </div>
    );
}
