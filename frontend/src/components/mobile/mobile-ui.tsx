// Shared building blocks for the bespoke mobile (<md) screens. These translate
// the approved prototype's inline-styled primitives (docs/design/mobile-reference)
// onto our design tokens. No new colors or fonts. Rendered only on the mobile
// shell surfaces.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Sparkline } from '@/components/ui/sparkline';

type Tone = 'success' | 'warning' | 'destructive' | 'brand';

const TONE_BG: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  brand: 'bg-brand',
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

// Status masthead for the bespoke mobile content leads (Home today; Fleet and
// Schedules as they are re-skinned): 3px cyan left rail, kicker, serif-italic
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
