// Shared building blocks for the bespoke mobile (<md) screens. These translate
// the approved prototype's inline-styled primitives onto our design tokens.
// No new colors or fonts. Rendered only on the mobile shell surfaces.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Sparkline } from '@/components/ui/sparkline';
import { ScrollableTabRow } from '@/components/ui/ScrollableTabRow';

export type Tone = 'success' | 'warning' | 'destructive' | 'brand';

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  brand: 'text-brand',
};
const TONE_BG: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  brand: 'bg-brand',
};
const TONE_MUTED: Record<Tone, string> = {
  success: 'bg-success/[0.14]',
  warning: 'bg-warning/[0.14]',
  destructive: 'bg-destructive/[0.14]',
  brand: 'bg-brand/[0.09]',
};
const TONE_VAR: Record<Tone, string> = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  destructive: 'var(--destructive)',
  brand: 'var(--brand)',
};

// Bar fill color by threshold: >=90 destructive, >=80 warning, else brand.
function barColor(pct: number): string {
  if (pct >= 90) return TONE_VAR.destructive;
  if (pct >= 80) return TONE_VAR.warning;
  return TONE_VAR.brand;
}

// Tracked-mono uppercase label.
export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-icon', className)}>
      {children}
    </span>
  );
}

// Section header on a thin top rule.
export function SectionHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-hairline pt-[9px] mb-[9px]">
      <Kicker>{children}</Kicker>
      {right ? <Kicker className="text-stat-subtitle">{right}</Kicker> : null}
    </div>
  );
}

export function StateDot({ tone = 'success', size = 7, glow = false, pulse = false }: { tone?: Tone; size?: number; glow?: boolean; pulse?: boolean }) {
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', TONE_BG[tone], pulse && 'animate-pulse')}
      style={{
        width: size,
        height: size,
        boxShadow: glow || pulse ? `0 0 6px 0 ${TONE_VAR[tone]}` : undefined,
      }}
    />
  );
}

// Horizontal gauge bar (5px, recessed well track, threshold fill).
export function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-[7px] h-[5px] overflow-hidden rounded-[3px] bg-well">
      <div className="h-full rounded-[3px]" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: barColor(pct) }} />
    </div>
  );
}

// Sparkline wrapper matching the reference (gradient fill + amber peak dot).
export function MSparkline({ values, height = 30, color = 'var(--brand)', peak = true }: { values: number[]; height?: number; color?: string; peak?: boolean }) {
  return (
    <div style={{ height }}>
      <Sparkline points={values} stroke={color} fill={color} peakColor="var(--warning)" showPeak={peak} className="h-full w-full" />
    </div>
  );
}

// State pill (online, degraded, etc.).
export function StatePill({ tone = 'success', live = false, children }: { tone?: Tone; live?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-[7px] border px-[9px] py-[3px] font-mono text-[11px] tracking-[0.04em]', TONE_TEXT[tone], TONE_MUTED[tone])}
      style={{ borderColor: `color-mix(in oklch, ${TONE_VAR[tone]} 30%, transparent)` }}
    >
      <StateDot tone={tone} size={6} pulse={live} glow={!live} />
      {children}
    </span>
  );
}

// Mono button: primary (cyan) / outline / ghost. >=44px tall.
export function MBtn({
  kind = 'outline',
  children,
  full = false,
  onClick,
  disabled = false,
  className,
}: { kind?: 'primary' | 'outline' | 'ghost'; children: ReactNode; full?: boolean; onClick?: () => void; disabled?: boolean; className?: string }) {
  const variant =
    kind === 'primary' ? 'bg-brand text-brand-foreground shadow-btn-glow'
      : kind === 'outline' ? 'bg-card text-stat-title border border-card-border border-t-card-border-top shadow-btn-glow'
        : 'bg-transparent text-stat-subtitle';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-transparent px-[14px] font-mono text-[11px] font-medium uppercase tracking-[0.12em] whitespace-nowrap transition-colors disabled:opacity-50',
        full && 'w-full',
        variant,
        className,
      )}
    >
      {children}
    </button>
  );
}

// Back chevron chip for drill-in detail screens.
export function BackChip({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1 rounded-[7px] pl-0.5 pr-2 font-mono text-xs text-brand"
    >
      <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
        <path d="M6.5 1L1 6.5 6.5 12" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

// Status masthead for the bespoke mobile content leads (Home and Fleet today;
// Schedules as it is re-skinned): 3px cyan left rail, kicker, serif-italic
// state word, meta, optional right slot.
export function Masthead({
  kicker,
  state,
  stateTone = 'success',
  meta,
  right,
  live = true,
  stateClassName,
}: {
  kicker: ReactNode;
  state: ReactNode;
  stateTone?: Tone;
  meta?: ReactNode;
  right?: ReactNode;
  live?: boolean;
  stateClassName?: string;
}) {
  return (
    <div className="relative border-b border-hairline px-4 pb-[15px] pt-2">
      <span aria-hidden className="absolute left-0 top-2 bottom-[15px] w-[3px] bg-brand" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1"><Kicker>{kicker}</Kicker></div>
          <div className="flex items-center gap-[11px]">
            <StateDot tone={stateTone} size={11} pulse={live} />
            <span className={cn('font-display italic text-[38px] leading-[40px] text-stat-value', stateClassName)}>{state}</span>
          </div>
        </div>
        {right ? <div className="shrink-0 text-right">{right}</div> : null}
      </div>
      {meta ? <div className="mt-[7px] font-mono text-[12px] text-stat-subtitle">{meta}</div> : null}
    </div>
  );
}

// Page header for a pushed full-screen secondary view (Resources, App Store,
// Updates, Audit): 3px cyan left rail, a back chip, the rehomed global chrome
// (notifications + more-menu) top-right since these screens drop the TopBar, a
// muted mono crumb kicker, and a serif-italic title with an optional right slot
// (e.g. a Recheck button).
export function PageHead({ back, crumb, title, right, headerActions, onBack }: {
  back: string;
  crumb?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
  /** Notifications + more-menu cluster, rehomed from the dropped TopBar. */
  headerActions?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <div className="relative shrink-0 border-b border-hairline px-4 pb-[13px] pt-1">
      <span aria-hidden className="absolute left-0 top-[42px] bottom-[13px] w-[3px] bg-brand" />
      <div className="flex items-center justify-between gap-2">
        <BackChip label={back} onClick={onBack} />
        {headerActions}
      </div>
      <div className="ml-0.5 mt-1 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {crumb ? <div className="mb-0.5"><Kicker>{crumb}</Kicker></div> : null}
          <div className="truncate font-display italic text-[32px] leading-[34px] tracking-[-0.01em] text-stat-value">
            {title}
          </div>
        </div>
        {right}
      </div>
    </div>
  );
}

export interface MobileSubTab<T extends string = string> {
  value: T;
  label: string;
  /** Optional trailing count badge (dimmed). */
  count?: number;
}

// Horizontal mono tab scroller with a cyan underline on the active tab. When
// the row overflows it gets the shared fade + arrow affordance (ScrollableTabRow).
// Shared by the Security page and the Audit Log page. Tap targets are >=44px.
export function MobileSubTabs<T extends string>({ tabs, active, onSelect, ariaLabel }: {
  tabs: MobileSubTab<T>[];
  active: T;
  onSelect: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <ScrollableTabRow surface="background" wrapperClassName="shrink-0" className="border-b border-hairline">
      <div role="tablist" aria-label={ariaLabel} className="flex">
        {tabs.map((tab) => {
          const on = tab.value === active;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onSelect(tab.value)}
              className={cn(
                'min-h-11 shrink-0 whitespace-nowrap px-3 py-[13px] font-mono text-[12px] tracking-[0.04em] transition-colors',
                on ? 'text-brand shadow-[inset_0_-2px_0_0_var(--brand)]' : 'text-stat-subtitle',
              )}
            >
              {tab.label}
              {tab.count != null && <span className="ml-1.5 opacity-60">{tab.count}</span>}
            </button>
          );
        })}
      </div>
    </ScrollableTabRow>
  );
}

export interface MobileChip<T extends string = string> {
  value: T;
  label: string;
  /** Optional trailing count badge (dimmed). */
  count?: number;
}

// Horizontal filter-chip scroller; active chip is cyan-filled. Used by the
// Security Images severity filter. Tap targets are >=44px.
export function MobileChipRow<T extends string>({ chips, active, onSelect, className }: {
  chips: MobileChip<T>[];
  active: T;
  onSelect: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}>
      {chips.map((chip) => {
        const on = chip.value === active;
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => onSelect(chip.value)}
            className={cn(
              'min-h-11 shrink-0 whitespace-nowrap rounded-[7px] border px-[11px] font-mono text-[11px] tracking-[0.04em] transition-colors',
              on ? 'border-brand bg-brand text-brand-foreground' : 'border-card-border bg-card text-stat-subtitle',
            )}
          >
            {chip.label}
            {chip.count != null && <span className="ml-1.5 opacity-60">{chip.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
