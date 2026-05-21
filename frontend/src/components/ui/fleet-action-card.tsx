import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Tracked-mono kicker. The toolbar/footer band and the blast-radius readout
// share `0.18em`; SheetSection headers inside the body use `0.22em` (set in
// system-sheet.tsx).
const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';

export type FleetActionClass = 'destructive' | 'transformative' | 'maintenance';
export type BlastRadiusTone = 'warning' | 'success' | 'muted';
export type PrimaryActionVariant = 'primary' | 'destructive';

export interface FleetActionCardProps {
  /** Crumb segments. Last segment renders in --stat-title; the rest in --stat-subtitle with separators. */
  crumb: string[];
  /** Italic serif noun for the action (e.g. "Stop by label."). Section rung. */
  name: string;
  /** One-line mono summary of the action's shape (e.g. "label-match · per-node fan-out"). */
  meta: string;
  /** Closed set; drives the chip color, the blast dot color, and the primary-button variant invariant. */
  actionClass: FleetActionClass;
  /**
   * Live blast-radius readout shown in the toolbar slot. Literal-prefix rules:
   *  - "awaiting target" → dot muted, text muted.
   *  - "0 ..." → dot muted, primary + secondary forced-disabled.
   *  - "local · ..." → dot in --brand (cyan) instead of the class color.
   *  - Otherwise → dot in the class color; tone overrides text color only.
   */
  blastRadius: { value: string; tone?: BlastRadiusTone };
  /** Optional outline secondary action (Dry run / Reset). Disabled automatically on "awaiting"/"0 ..." readouts. */
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  /** Required primary action. The variant must follow the action-class invariants documented below. */
  primaryAction: { label: string; onClick: () => void; variant: PrimaryActionVariant; disabled?: boolean };
  /** Tracked-mono footer line. Omits the band entirely when undefined. */
  footerContext?: string;
  /** `<SheetSection>` blocks. */
  children: React.ReactNode;
}

const CLASS_LABEL: Record<FleetActionClass, string> = {
  destructive: 'Destructive',
  transformative: 'Transformative',
  maintenance: 'Maintenance',
};

const CHIP_CLASS: Record<FleetActionClass, string> = {
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
  transformative: 'border-action-transformative/40 bg-action-transformative/10 text-action-transformative',
  maintenance: 'border-warning/40 bg-warning/10 text-warning',
};

const DOT_CLASS: Record<FleetActionClass, string> = {
  destructive: 'bg-destructive',
  transformative: 'bg-action-transformative',
  maintenance: 'bg-warning',
};

const TONE_TEXT_CLASS: Record<BlastRadiusTone, string> = {
  warning: 'text-warning',
  success: 'text-success',
  muted: 'text-stat-icon',
};

export function FleetActionCard(props: FleetActionCardProps) {
  const {
    crumb, name, meta, actionClass, blastRadius,
    secondaryAction, primaryAction, footerContext, children,
  } = props;

  // Literal-prefix detection per audit §18.5. These strings are the source of
  // truth callers pass in; do NOT layer additional state props onto the
  // primitive for what the prefix already expresses.
  const isAwaitingTarget = blastRadius.value === 'awaiting target';
  const isZeroMatch = blastRadius.value.startsWith('0 ');
  const isLocalScope = blastRadius.value.startsWith('local · ');
  const forceDisable = isAwaitingTarget || isZeroMatch;

  const dotClass = (isAwaitingTarget || isZeroMatch)
    ? 'bg-stat-subtitle/50'
    : isLocalScope
      ? 'bg-brand'
      : DOT_CLASS[actionClass];

  const blastTextClass = (isAwaitingTarget || isZeroMatch)
    ? 'text-stat-icon'
    : blastRadius.tone
      ? TONE_TEXT_CLASS[blastRadius.tone]
      : 'text-stat-value';

  // Dev-mode invariant: a maintenance card with a destructive primary should
  // also signal irreversibility in its footer, otherwise the visual class
  // (amber) and the action variant (rose) disagree about safety.
  if (import.meta.env?.MODE !== 'production') {
    if (actionClass === 'maintenance' && primaryAction.variant === 'destructive') {
      if (!footerContext || !footerContext.includes('Reversible · no')) {
        console.warn(
          '[FleetActionCard] maintenance + destructive primary should carry a "Reversible · no" footer.',
          { name, footerContext },
        );
      }
    }
  }

  const lastCrumb = crumb[crumb.length - 1] ?? '';
  const headCrumbs = crumb.slice(0, -1);

  return (
    <Card className="relative overflow-hidden p-0">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] bg-brand"
      />

      <header className="px-6 pt-4 pb-3">
        <div className={cn(KICKER, 'flex flex-wrap items-baseline gap-1 leading-none')}>
          {headCrumbs.map((segment, idx) => (
            <React.Fragment key={`${segment}-${idx}`}>
              <span className="text-stat-subtitle">{segment}</span>
              <span className="text-stat-icon" aria-hidden="true">{'›'}</span>
            </React.Fragment>
          ))}
          <span className="text-stat-title">{lastCrumb}</span>
        </div>
        <h3 className="mt-2 font-display italic text-[22px] leading-[28px] text-stat-value">
          {name}
        </h3>
        <div className={cn('mt-1.5 font-mono text-[11px] leading-none text-stat-subtitle tracking-[0.04em]')}>
          {meta}
        </div>
      </header>

      <div className="flex items-center gap-2 px-6 py-2 border-y border-card-border/40 bg-card/60">
        <span
          className={cn(
            KICKER,
            'inline-flex items-center px-1.5 py-0.5 rounded-sm border shrink-0',
            CHIP_CLASS[actionClass],
          )}
        >
          {CLASS_LABEL[actionClass]}
        </span>
        <div className={cn(KICKER, 'flex items-center gap-1.5 leading-none min-w-0', blastTextClass)}>
          <span
            aria-hidden="true"
            className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', dotClass)}
          />
          <span className="truncate">{blastRadius.value}</span>
        </div>
        <div className="flex-1" />
        {secondaryAction && (
          <Button
            variant="outline"
            size="sm"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled || forceDisable}
            className={cn(KICKER, 'h-7 px-3')}
          >
            {secondaryAction.label}
          </Button>
        )}
        <PrimaryButton
          action={primaryAction}
          disabled={primaryAction.disabled || forceDisable}
        />
      </div>

      <div className="px-6">
        {children}
      </div>

      {footerContext && (
        <div className="px-6 py-2 border-t border-card-border/40 bg-card/60">
          <div className={cn(KICKER, 'text-stat-subtitle leading-none truncate')}>
            {footerContext}
          </div>
        </div>
      )}
    </Card>
  );
}

interface PrimaryButtonProps {
  action: { label: string; onClick: () => void; variant: PrimaryActionVariant };
  disabled: boolean;
}

// Primary button kept inline to encode the §18.3 invariant: cyan-filled for
// transformative/maintenance (when reversible), ghost-rose for destructive.
// Never solid rose on the card; solid rose is reserved for AlertDialog (§10).
function PrimaryButton({ action, disabled }: PrimaryButtonProps) {
  const cyanFilled = 'bg-brand text-brand-foreground hover:bg-brand/90 border border-transparent';
  const ghostRose = 'border border-destructive/40 text-destructive bg-transparent hover:bg-destructive/15 hover:text-destructive hover:border-destructive/60';
  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={disabled}
      className={cn(
        KICKER,
        'h-7 rounded-md px-3 whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        action.variant === 'primary' ? cyanFilled : ghostRose,
      )}
    >
      {action.label}
    </button>
  );
}
