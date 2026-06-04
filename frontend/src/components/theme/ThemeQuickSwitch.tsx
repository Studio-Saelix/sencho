import { Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { AccentPicker } from './AccentPicker';
import { TypeChips } from './TypeChips';
import { UI_FONT_OPTIONS, MONO_FONT_OPTIONS, SIZE_OPTIONS, sizeIdForScale } from './typeOptions';
import { useTheme, THEME_MODES, THEME_MODE_OPTIONS, ACCENTS, TYPE_SIZES } from '@/hooks/use-theme';

/**
 * Topbar quick theme switch (between search and notifications). Opens a small
 * popover to flip the mode and accent; the fine-tune sliders live in
 * Settings → Appearance. Reads/writes the shared theme store directly. Mirrors
 * the masthead + bordered-section chrome of the notification and profile panels.
 */
export function ThemeQuickSwitch() {
    const {
        theme, accent, uiFont, monoFont, typeScale,
        setTheme, setAccent, setUiFont, setMonoFont, setTypeScale,
    } = useTheme();
    const themeLabel = THEME_MODES.find((m) => m.id === theme)?.label ?? 'Dim';
    const accentLabel = ACCENTS.find((a) => a.id === accent)?.label ?? 'Cyan';
    const onSize = (id: string) => {
        const match = TYPE_SIZES.find((s) => s.id === id);
        if (match) setTypeScale(match.scale);
    };

    return (
        <Popover>
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
                        <span className="font-display text-xl italic leading-none text-stat-value">
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

                {/* Type */}
                <div className="space-y-3 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                        Type
                    </span>
                    <div className="space-y-1.5">
                        <span className="block font-mono text-[9px] uppercase tracking-[0.16em] text-stat-icon">
                            Interface
                        </span>
                        <TypeChips value={uiFont} options={UI_FONT_OPTIONS} onChange={setUiFont} ariaLabel="Interface font" />
                    </div>
                    <div className="space-y-1.5">
                        <span className="block font-mono text-[9px] uppercase tracking-[0.16em] text-stat-icon">
                            Data
                        </span>
                        <TypeChips value={monoFont} options={MONO_FONT_OPTIONS} onChange={setMonoFont} ariaLabel="Data font" />
                    </div>
                    <div className="space-y-1.5">
                        <span className="block font-mono text-[9px] uppercase tracking-[0.16em] text-stat-icon">
                            Size
                        </span>
                        <TypeChips
                            value={sizeIdForScale(typeScale)}
                            options={SIZE_OPTIONS}
                            onChange={onSize}
                            columns={4}
                            ariaLabel="Text size"
                        />
                    </div>
                </div>

                {/* Footer hint */}
                <div className="border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <p className="font-mono text-[10px] leading-4 uppercase tracking-[0.14em] text-stat-subtitle/70">
                        Saved to this browser · fine-tune borders &amp; glow in Settings
                    </p>
                </div>
            </PopoverContent>
        </Popover>
    );
}
