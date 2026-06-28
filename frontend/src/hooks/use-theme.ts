import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Moon, Zap, Sun, Monitor } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Shared theme store. Two live consumers (the topbar quick switch and the
// Settings → Appearance section) must reflect each other instantly, so the
// state lives in a module-level external store exposed via useSyncExternalStore
// rather than per-component state. The apply-to-<html> logic mirrors
// public/theme-init.js (the pre-paint script); keep the two in sync.

export type ThemeMode = 'dim' | 'oled' | 'light' | 'auto';
export type ResolvedTheme = 'dim' | 'oled' | 'light';
export type AccentId =
    | 'cyan' | 'blue' | 'violet' | 'magenta'
    | 'orange' | 'amber' | 'lime' | 'steel';

// Display (Instrument Serif) is the locked signature face. Only the interface
// (sans) and data (mono) faces are user-swappable, plus a root text-size scale.
export type UiFont = 'Geist' | 'IBM Plex Sans' | 'Hanken Grotesk';
export type MonoFont = 'Geist Mono' | 'IBM Plex Mono' | 'Fira Code';

// Calm / Readability refresh. `visualStyle` is a macro that writes the three
// sub-axes below; `readability` is an independent sticky master that forces the
// calm resolution at apply time without mutating the stored sub-axes. The member
// tuples are the single source of truth for both the union and its runtime guard
// (mirrors the THEME_MODES/ACCENTS convention below).
const VISUAL_STYLES = ['calm', 'signature'] as const;
const HEADING_STYLES = ['clean', 'signature'] as const;
const CHART_STYLES = ['muted', 'heat', 'signature'] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type HeadingStyle = (typeof HEADING_STYLES)[number];
export type ChartStyle = (typeof CHART_STYLES)[number];

export interface ThemeState {
    theme: ThemeMode;
    accent: AccentId;
    borderBoost: number;
    glow: number;
    contrast: number;
    uiFont: UiFont;
    monoFont: MonoFont;
    typeScale: number;
    visualStyle: VisualStyle;
    headingStyle: HeadingStyle;
    chartStyle: ChartStyle;
    reducedEffects: boolean;
    /** Independent of reducedEffects (surface flattening): minimizes UI motion
     *  (dialogs, menus, overlays, transitions). Not part of a visual-style preset. */
    reducedMotion: boolean;
    readability: boolean;
}

export const THEME_MODES: { id: ThemeMode; label: string; icon: LucideIcon }[] = [
    { id: 'dim', label: 'Dim', icon: Moon },
    { id: 'oled', label: 'OLED', icon: Zap },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'auto', label: 'Auto', icon: Monitor },
];

// Pre-mapped for SegmentedControl so the popover and the settings section stay identical.
export const THEME_MODE_OPTIONS = THEME_MODES.map((m) => ({ value: m.id, label: m.label, icon: m.icon }));

// h/c match the [data-accent] rules in index.css; lightness comes from the theme.
// A tighter, well-spaced 8-hue wheel (ordered for the 2x4 picker). Cyan default.
export const ACCENTS: { id: AccentId; label: string; h: number; c: number }[] = [
    { id: 'orange', label: 'Orange', h: 42, c: 0.165 },
    { id: 'amber', label: 'Amber', h: 88, c: 0.165 },
    { id: 'lime', label: 'Lime', h: 132, c: 0.195 },
    { id: 'cyan', label: 'Cyan', h: 196, c: 0.130 },
    { id: 'blue', label: 'Blue', h: 252, c: 0.165 },
    { id: 'violet', label: 'Violet', h: 298, c: 0.190 },
    { id: 'magenta', label: 'Magenta', h: 344, c: 0.180 },
    { id: 'steel', label: 'Steel', h: 250, c: 0.040 },
];

// Personalization-knob bounds (also enforced by the sliders).
export const CONTRAST = { min: -0.6, max: 1.2, step: 0.05, default: 0 } as const;
export const BORDER_BOOST = { min: -0.06, max: 0.12, step: 0.01, default: 0 } as const;
export const GLOW = { min: 0, max: 0.4, step: 0.01, default: 0.16 } as const;
// Continuous text-size bounds for the Settings slider (the popover uses presets).
export const TYPE_SCALE = { min: 0.88, max: 1.2, step: 0.02, default: 1 } as const;

// Swappable faces (the family string is the CSS value; name is the display label).
export const UI_FONTS: { id: UiFont; name: string }[] = [
    { id: 'Geist', name: 'Geist' },
    { id: 'IBM Plex Sans', name: 'IBM Plex' },
    { id: 'Hanken Grotesk', name: 'Hanken' },
];
export const MONO_FONTS: { id: MonoFont; name: string }[] = [
    { id: 'Geist Mono', name: 'Geist Mono' },
    { id: 'IBM Plex Mono', name: 'Plex Mono' },
    { id: 'Fira Code', name: 'Fira Code' },
];
// Text-size presets: id label + the --type-scale multiplier + a preview px.
export const TYPE_SIZES: { id: string; scale: number; px: number }[] = [
    { id: 'S', scale: 0.92, px: 11 },
    { id: 'M', scale: 1.0, px: 13 },
    { id: 'L', scale: 1.08, px: 15 },
    { id: 'XL', scale: 1.16, px: 17 },
];

const STORAGE_KEY = 'sencho.appearance.theme';
const LEGACY_KEY = 'sencho-theme';

// The five appearance axes the Calm/Signature refresh adds, as two presets.
// `setVisualStyle` writes the macro + the three sub-axes (not readability);
// migration fills missing fields on an existing stored object from SIGNATURE so
// returning users look unchanged, while a fresh user gets CALM via DEFAULT_STATE.
export const CALM_PRESET = {
    visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
    reducedEffects: true, readability: false,
} as const;
export const SIGNATURE_PRESET = {
    visualStyle: 'signature', headingStyle: 'signature', chartStyle: 'signature',
    reducedEffects: false, readability: false,
} as const;

/** Which visual-style preset the stored sub-axes currently match, or null for a
 *  custom combination. Readability forces its own resolution, so it always reads
 *  as null. The Appearance cards and the topbar quick-switch both derive their
 *  highlight from this so they agree on which style is active. */
export function activeVisualStyle(s: {
    headingStyle: HeadingStyle;
    chartStyle: ChartStyle;
    reducedEffects: boolean;
    readability: boolean;
}): VisualStyle | null {
    if (s.readability) return null;
    for (const kind of VISUAL_STYLES) {
        const p = kind === 'calm' ? CALM_PRESET : SIGNATURE_PRESET;
        if (s.headingStyle === p.headingStyle && s.chartStyle === p.chartStyle && s.reducedEffects === p.reducedEffects) {
            return kind;
        }
    }
    return null;
}

const DEFAULT_STATE: ThemeState = {
    theme: 'dim', accent: 'cyan', borderBoost: 0, glow: 0.16, contrast: 0,
    uiFont: 'Geist', monoFont: 'Geist Mono', typeScale: 1,
    ...CALM_PRESET,
    // Independent of the visual-style presets; defaults off so the OS
    // prefers-reduced-motion still governs via MotionConfig's 'user' mode.
    reducedMotion: false,
};

const MODE_IDS = new Set<string>(THEME_MODES.map((m) => m.id));
const ACCENT_IDS = new Set<string>(ACCENTS.map((a) => a.id));
const UI_FONT_IDS = new Set<string>(UI_FONTS.map((f) => f.id));
const MONO_FONT_IDS = new Set<string>(MONO_FONTS.map((f) => f.id));

function isMode(v: unknown): v is ThemeMode {
    return typeof v === 'string' && MODE_IDS.has(v);
}
function isAccent(v: unknown): v is AccentId {
    return typeof v === 'string' && ACCENT_IDS.has(v);
}
function isUiFont(v: unknown): v is UiFont {
    return typeof v === 'string' && UI_FONT_IDS.has(v);
}
function isMonoFont(v: unknown): v is MonoFont {
    return typeof v === 'string' && MONO_FONT_IDS.has(v);
}
const VISUAL_STYLE_IDS = new Set<string>(VISUAL_STYLES);
const HEADING_STYLE_IDS = new Set<string>(HEADING_STYLES);
const CHART_STYLE_IDS = new Set<string>(CHART_STYLES);
function isVisualStyle(v: unknown): v is VisualStyle {
    return typeof v === 'string' && VISUAL_STYLE_IDS.has(v);
}
function isHeadingStyle(v: unknown): v is HeadingStyle {
    return typeof v === 'string' && HEADING_STYLE_IDS.has(v);
}
function isChartStyle(v: unknown): v is ChartStyle {
    return typeof v === 'string' && CHART_STYLE_IDS.has(v);
}
function isBool(v: unknown): v is boolean {
    return typeof v === 'boolean';
}
// Numeric knobs: a persisted value must be finite and in range, otherwise fall
// back to the default (a NaN/Infinity/out-of-range value would silently no-op
// in CSS, which is harder to diagnose than a reset to default).
function readNumber(value: unknown, bounds: { min: number; max: number; default: number }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.default;
    return Math.min(bounds.max, Math.max(bounds.min, value));
}

function readStored(): ThemeState {
    if (typeof window === 'undefined') return { ...DEFAULT_STATE };
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw) as Partial<ThemeState> | null;
            if (p && typeof p === 'object') {
                return {
                    theme: isMode(p.theme) ? p.theme : DEFAULT_STATE.theme,
                    accent: isAccent(p.accent) ? p.accent : DEFAULT_STATE.accent,
                    borderBoost: readNumber(p.borderBoost, BORDER_BOOST),
                    glow: readNumber(p.glow, GLOW),
                    contrast: readNumber(p.contrast, CONTRAST),
                    uiFont: isUiFont(p.uiFont) ? p.uiFont : DEFAULT_STATE.uiFont,
                    monoFont: isMonoFont(p.monoFont) ? p.monoFont : DEFAULT_STATE.monoFont,
                    typeScale: readNumber(p.typeScale, TYPE_SCALE),
                    // An existing stored object is a returning user: any appearance
                    // field it predates fills from SIGNATURE so its look is unchanged.
                    visualStyle: isVisualStyle(p.visualStyle) ? p.visualStyle : SIGNATURE_PRESET.visualStyle,
                    headingStyle: isHeadingStyle(p.headingStyle) ? p.headingStyle : SIGNATURE_PRESET.headingStyle,
                    chartStyle: isChartStyle(p.chartStyle) ? p.chartStyle : SIGNATURE_PRESET.chartStyle,
                    reducedEffects: isBool(p.reducedEffects) ? p.reducedEffects : SIGNATURE_PRESET.reducedEffects,
                    reducedMotion: isBool(p.reducedMotion) ? p.reducedMotion : false,
                    readability: isBool(p.readability) ? p.readability : SIGNATURE_PRESET.readability,
                };
            }
        }
        // Legacy migration: the old key held only the mode string (dark → dim). A
        // legacy key is still a returning user, so the appearance axes fill from
        // Signature (unchanged look); only the total absence of any key is a fresh
        // user and falls through to the Calm DEFAULT_STATE below.
        const legacy = window.localStorage.getItem(LEGACY_KEY);
        if (legacy === 'light' || legacy === 'auto') return { ...DEFAULT_STATE, ...SIGNATURE_PRESET, theme: legacy };
        if (legacy === 'dark') return { ...DEFAULT_STATE, ...SIGNATURE_PRESET, theme: 'dim' };
    } catch {
        // ignore; localStorage may be unavailable (private mode, quota)
    }
    return { ...DEFAULT_STATE };
}

function systemPrefersDark(): boolean {
    return (
        typeof window !== 'undefined' &&
        !!window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
    );
}

function resolveWith(theme: ThemeMode, systemDark: boolean): ResolvedTheme {
    if (theme === 'auto') return systemDark ? 'dim' : 'light';
    return theme;
}

/** Resolve a mode to a concrete theme using the live OS preference. */
export function resolveTheme(theme: ThemeMode): ResolvedTheme {
    return resolveWith(theme, systemPrefersDark());
}

function applyToDom(s: ThemeState, systemDark: boolean) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const resolved = resolveWith(s.theme, systemDark);
    root.dataset.theme = resolved;
    root.dataset.accent = s.accent;
    // Calm/Readability: readability is a sticky master that forces the calm
    // resolution plus a contrast lift; otherwise the stored sub-axes apply.
    // Effective values are resolved here only, never written back to storage.
    const rd = s.readability;
    const headings = rd ? 'clean' : s.headingStyle;
    const chart = rd ? 'muted' : s.chartStyle;
    const reduced = rd || s.reducedEffects;
    root.dataset.headings = headings;
    root.dataset.chartStyle = chart;
    if (reduced) root.dataset.effects = 'reduced';
    else delete root.dataset.effects;
    // Motion is independent of effects/readability: only the explicit toggle.
    if (s.reducedMotion) root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
    root.style.setProperty('--border-boost', String(rd ? 0.03 : s.borderBoost));
    root.style.setProperty('--glow', String(reduced ? s.glow * 0.4 : s.glow));
    root.style.setProperty('--contrast', String(s.contrast + (rd ? 0.18 : 0)));
    root.style.setProperty('--ui-font', `'${s.uiFont}'`);
    root.style.setProperty('--mono-font', `'${s.monoFont}'`);
    root.style.setProperty('--type-scale', String(s.typeScale));
    root.classList.toggle('dark', resolved !== 'light');
}

// ── store ──────────────────────────────────────────────────────────────────
export interface ThemeSnapshot extends ThemeState {
    systemDark: boolean;
}

let persisted: ThemeState = readStored();
let systemDark = systemPrefersDark();
let snapshot: ThemeSnapshot = { ...persisted, systemDark };
const listeners = new Set<() => void>();

function rebuild() {
    snapshot = { ...persisted, systemDark };
}
function emit() {
    for (const l of listeners) l();
}

function sameState(a: ThemeState, b: ThemeState): boolean {
    return a.theme === b.theme && a.accent === b.accent
        && a.borderBoost === b.borderBoost && a.glow === b.glow && a.contrast === b.contrast
        && a.uiFont === b.uiFont && a.monoFont === b.monoFont && a.typeScale === b.typeScale
        && a.visualStyle === b.visualStyle && a.headingStyle === b.headingStyle
        && a.chartStyle === b.chartStyle && a.reducedEffects === b.reducedEffects
        && a.reducedMotion === b.reducedMotion
        && a.readability === b.readability;
}

function setState(patch: Partial<ThemeState>) {
    const next: ThemeState = { ...persisted, ...patch };
    if (sameState(next, persisted)) return;
    persisted = next;
    rebuild();
    applyToDom(persisted, systemDark);
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
        // ignore
    }
    emit();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot(): ThemeSnapshot {
    return snapshot;
}

/** Lean selector for just the reduced-motion flag, so a wrapper like MotionConfig
 *  re-renders only when motion changes, not on every theme tweak. */
export function useReducedMotion(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => persisted.reducedMotion,
        () => DEFAULT_STATE.reducedMotion,
    );
}

if (typeof window !== 'undefined') {
    // Cross-tab sync: another tab wrote a new look.
    window.addEventListener('storage', (e) => {
        if (e.key !== STORAGE_KEY) return;
        const incoming = readStored();
        if (sameState(incoming, persisted)) return;
        persisted = incoming;
        rebuild();
        applyToDom(persisted, systemDark);
        emit();
    });
    // Auto mode re-resolves live when the OS flips.
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        mq.addEventListener('change', (e) => {
            if (e.matches === systemDark) return;
            systemDark = e.matches;
            rebuild();
            if (persisted.theme === 'auto') applyToDom(persisted, systemDark);
            emit();
        });
    }
}

/** Re-assert the stored look on <html> at startup (idempotent; the pre-paint
 *  script already applied it, this keeps the store and DOM in agreement). */
export function initializeTheme() {
    applyToDom(persisted, systemDark);
}

export function useTheme() {
    const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const setTheme = useCallback((theme: ThemeMode) => setState({ theme }), []);
    const setAccent = useCallback((accent: AccentId) => setState({ accent }), []);
    const setBorderBoost = useCallback((borderBoost: number) => setState({ borderBoost }), []);
    const setGlow = useCallback((glow: number) => setState({ glow }), []);
    const setContrast = useCallback((contrast: number) => setState({ contrast }), []);
    const setUiFont = useCallback((uiFont: UiFont) => setState({ uiFont }), []);
    const setMonoFont = useCallback((monoFont: MonoFont) => setState({ monoFont }), []);
    const setTypeScale = useCallback((typeScale: number) => setState({ typeScale }), []);
    // Macro: writes visualStyle + the three sub-axes from the preset. It does
    // NOT touch readability, which stays a sticky master the user releases by hand.
    const setVisualStyle = useCallback((visualStyle: VisualStyle) => {
        const preset = visualStyle === 'calm' ? CALM_PRESET : SIGNATURE_PRESET;
        setState({
            visualStyle,
            headingStyle: preset.headingStyle,
            chartStyle: preset.chartStyle,
            reducedEffects: preset.reducedEffects,
        });
    }, []);
    const setHeadingStyle = useCallback((headingStyle: HeadingStyle) => setState({ headingStyle }), []);
    const setChartStyle = useCallback((chartStyle: ChartStyle) => setState({ chartStyle }), []);
    const setReducedEffects = useCallback((reducedEffects: boolean) => setState({ reducedEffects }), []);
    const setReducedMotion = useCallback((reducedMotion: boolean) => setState({ reducedMotion }), []);
    const setReadability = useCallback((readability: boolean) => setState({ readability }), []);
    const resolvedTheme = resolveWith(s.theme, s.systemDark);
    return {
        theme: s.theme,
        accent: s.accent,
        borderBoost: s.borderBoost,
        glow: s.glow,
        contrast: s.contrast,
        uiFont: s.uiFont,
        monoFont: s.monoFont,
        typeScale: s.typeScale,
        visualStyle: s.visualStyle,
        headingStyle: s.headingStyle,
        chartStyle: s.chartStyle,
        reducedEffects: s.reducedEffects,
        reducedMotion: s.reducedMotion,
        readability: s.readability,
        resolvedTheme,
        isDarkMode: resolvedTheme !== 'light',
        setTheme,
        setAccent,
        setBorderBoost,
        setGlow,
        setContrast,
        setUiFont,
        setMonoFont,
        setTypeScale,
        setVisualStyle,
        setHeadingStyle,
        setChartStyle,
        setReducedEffects,
        setReducedMotion,
        setReadability,
    } as const;
}

/** Effective chart palette + reduced flag for the security charts. A thin
 *  useMemo wrapper over the same store snapshot (not a second external store) so
 *  it returns a stable object reference unless a chart-relevant axis changes. */
export function useChartStyle(): { chartStyle: ChartStyle; reduced: boolean } {
    const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return useMemo(
        () => ({
            chartStyle: s.readability ? 'muted' : s.chartStyle,
            reduced: s.readability || s.reducedEffects,
        }),
        [s.readability, s.chartStyle, s.reducedEffects],
    );
}
