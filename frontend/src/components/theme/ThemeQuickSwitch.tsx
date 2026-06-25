import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { TogglePill } from '@/components/ui/toggle-pill';
import { AccentPicker } from './AccentPicker';
import { TypeChips } from './TypeChips';
import { SIZE_OPTIONS, sizeIdForScale } from './typeOptions';
import { useTheme, activeVisualStyle, THEME_MODES, THEME_MODE_OPTIONS, ACCENTS, TYPE_SIZES, type VisualStyle } from '@/hooks/use-theme';

const VISUAL_STYLE_OPTIONS: { value: VisualStyle; label: string }[] = [
    { value: 'calm', label: 'Calm' },
    { value: 'signature', label: 'Signature' },
];

interface ThemeQuickSwitchProps {
    /** Jump straight to Settings → Appearance (closes the popover first). */
    onOpenAppearance?: () => void;
}

/**
 * Topbar quick theme switch (between search and notifications). Opens a small
 * popover to flip the mode, accent, visual style, readability, and text size; the
 * fine-tune sliders live in Settings → Appearance. Reads/writes the shared theme
 * store directly. Mirrors the masthead + bordered-section chrome of the
 * notification and profile panels.
 */
export function ThemeQuickSwitch({ onOpenAppearance }: ThemeQuickSwitchProps) {
    const [open, setOpen] = useState(false);
    const {
        theme, accent, typeScale, headingStyle, chartStyle, reducedEffects, readability,
        setTheme, setAccent, setTypeScale, setVisualStyle, setReadability,
    } = useTheme();
    const themeLabel = THEME_MODES.find((m) => m.id === theme)?.label ?? 'Dim';
    const accentLabel = ACCENTS.find((a) => a.id === accent)?.label ?? 'Cyan';
    // Highlight the matched preset, or none for a custom combination, so the
    // quick-switch agrees with the Appearance cards.
    const activeVisual = activeVisualStyle({ headingStyle, chartStyle, reducedEffects, readability });
    const onSize = (id: string) => {
        const match = TYPE_SIZES.find((s) => s.id === id);
        if (match) setTypeScale(match.scale);
    };
    const openAppearance = () => {
        setOpen(false);
        onOpenAppearance?.();
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg"
                    title="Theme"
                    aria-label="Theme"
                >
                    <Palette className="h-4 w-4" strokeWidth={1.5} />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 overflow-hidden rounded-md p-0" align="end" sideOffset={8}>
                {/* Masthead */}
                <div className="relative overflow-hidden">
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.05] via-transparent to-transparent" />
                    <div className="absolute inset-y-0 left-0 w-[2px] bg-brand/60" />
                    <div className="relative flex items-center justify-between px-[var(--density-row-x)] py-[var(--density-tile-y)]">
                        <span className="font-heading text-xl leading-none text-stat-value">
                            Theme
                        </span>
                        <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
                            {themeLabel}
                        </span>
                    </div>
                </div>

                {/* Mode */}
                <div className="flex flex-col gap-2 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                        Mode
                    </span>
                    <SegmentedControl
                        value={theme}
                        options={THEME_MODE_OPTIONS}
                        onChange={setTheme}
                        ariaLabel="Theme mode"
                        iconOnly
                        fullWidth
                    />
                </div>

                {/* Accent */}
                <div className="space-y-2 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <div className="flex items-baseline justify-between">
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                            Accent
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle/70">
                            {accentLabel}
                        </span>
                    </div>
                    <AccentPicker value={accent} onChange={setAccent} />
                </div>

                {/* Visual style + Readability */}
                <div className="space-y-2.5 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                        Visual style
                    </span>
                    <SegmentedControl
                        value={activeVisual}
                        options={VISUAL_STYLE_OPTIONS}
                        onChange={setVisualStyle}
                        disabled={readability}
                        ariaLabel="Visual style"
                        fullWidth
                    />
                    <div className="flex items-center justify-between">
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                            Readability
                        </span>
                        <TogglePill checked={readability} onChange={setReadability} aria-label="Readability mode" />
                    </div>
                </div>

                {/* Text size */}
                <div className="space-y-2 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                        Text size
                    </span>
                    <TypeChips
                        value={sizeIdForScale(typeScale)}
                        options={SIZE_OPTIONS}
                        onChange={onSize}
                        columns={4}
                        ariaLabel="Text size"
                    />
                </div>

                {/* Footer */}
                <div className="border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <p className="font-mono text-[10px] leading-4 uppercase tracking-[0.14em] text-stat-subtitle/70">
                        Saved to this browser · fine-tune borders &amp; glow in{' '}
                        <button
                            type="button"
                            onClick={openAppearance}
                            className="uppercase tracking-[0.14em] text-brand transition-colors hover:text-brand/80 focus-visible:underline focus-visible:outline-none"
                        >
                            Settings
                        </button>
                    </p>
                </div>
            </PopoverContent>
        </Popover>
    );
}
