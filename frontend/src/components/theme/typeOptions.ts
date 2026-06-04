import type { CSSProperties } from 'react';
import { UI_FONTS, MONO_FONTS, TYPE_SIZES, type UiFont, type MonoFont } from '@/hooks/use-theme';

export interface TypeChipOption<T extends string> {
    id: T;
    name: string;
    preview: string;
    previewStyle?: CSSProperties;
}

// Shared option sets so the popover and the settings section stay identical.
export const UI_FONT_OPTIONS: TypeChipOption<UiFont>[] = UI_FONTS.map((f) => ({
    id: f.id,
    name: f.name,
    preview: 'Ag',
    previewStyle: { fontFamily: `'${f.id}', sans-serif`, fontSize: '17px' },
}));

export const MONO_FONT_OPTIONS: TypeChipOption<MonoFont>[] = MONO_FONTS.map((f) => ({
    id: f.id,
    name: f.name,
    preview: '01',
    previewStyle: { fontFamily: `'${f.id}', monospace`, fontSize: '16px' },
}));

export const SIZE_OPTIONS: TypeChipOption<string>[] = TYPE_SIZES.map((s) => ({
    id: s.id,
    name: s.id,
    preview: 'A',
    previewStyle: { fontSize: `${s.px}px` },
}));

/** Map the stored numeric --type-scale to its preset id, or '' when it sits
 *  between presets (the Settings slider can land on off-preset values) so the
 *  popover chips show no false selection. */
export function sizeIdForScale(scale: number): string {
    return TYPE_SIZES.find((s) => Math.abs(s.scale - scale) < 0.001)?.id ?? '';
}
