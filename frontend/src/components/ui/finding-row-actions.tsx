import type { ReactNode } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { DismissalMode, DismissPolicy } from '@/types/findingDismissal';

interface FindingRowActionsProps {
  /** The finding's resolving verb, if any. It stays first and loudest. */
  children?: ReactNode;
  /** What the server allows. `none` renders no Dismiss at all. */
  dismissPolicy: DismissPolicy;
  /** False when the current account may not dismiss; the control is then omitted rather than left to 403. */
  canDismiss: boolean;
  pending?: boolean;
  /** What the dismissal is about, so each row's button has its own accessible name. */
  subject?: string;
  onDismiss: (mode: DismissalMode, days?: number) => void;
}

const TRIGGER = 'h-7 text-xs text-stat-subtitle hover:text-stat-value';

/**
 * The action cluster on a finding row: its resolving verb, then Dismiss.
 *
 * One click dismisses until the finding changes. The chevron offers the two
 * other holds. A finding about evidence that could not be read has no "until it
 * changes" (it would never lift while the evidence stays unreadable) and no
 * "permanently", so its one click dismisses for 7 days and the chevron offers 30.
 * Below the `md` breakpoint Dismiss folds into a single overflow menu so the row
 * keeps its width.
 */
export function FindingRowActions({ children, dismissPolicy, canDismiss, pending = false, subject, onDismiss }: FindingRowActionsProps) {
  const showDismiss = canDismiss && dismissPolicy !== 'none';
  const timedOnly = dismissPolicy === 'timed';
  const primary = (): void => (timedOnly ? onDismiss('days', 7) : onDismiss('until_change'));
  const label = subject ? `Dismiss: ${subject}` : 'Dismiss';

  return (
    <div className="flex items-center justify-end gap-1">
      {children}
      {showDismiss && (
        <>
          <div className="flex items-center max-md:hidden">
            <Button
              variant="ghost"
              size="sm"
              className={cn(TRIGGER, 'rounded-r-none px-2')}
              disabled={pending}
              aria-label={label}
              title={timedOnly ? 'This finding is about evidence that could not be read, so it is dismissed for 7 days.' : undefined}
              onClick={primary}
            >
              Dismiss
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className={cn(TRIGGER, 'w-6 rounded-l-none px-0')} disabled={pending} aria-label="More ways to dismiss">
                  <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {timedOnly
                  ? <DropdownMenuItem onSelect={() => onDismiss('days', 30)}>Dismiss for 30 days</DropdownMenuItem>
                  : <DropdownMenuItem onSelect={() => onDismiss('days', 7)}>Dismiss for 7 days</DropdownMenuItem>}
                {dismissPolicy === 'any' && <DropdownMenuItem onSelect={() => onDismiss('forever')}>Dismiss permanently</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9 max-md:min-h-11 max-md:min-w-11" disabled={pending} aria-label="Dismiss options">
                  <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {timedOnly ? (
                  <>
                    <DropdownMenuItem onSelect={() => onDismiss('days', 7)}>Dismiss for 7 days</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onDismiss('days', 30)}>Dismiss for 30 days</DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => onDismiss('until_change')}>Dismiss until it changes</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onDismiss('days', 7)}>Dismiss for 7 days</DropdownMenuItem>
                  </>
                )}
                {dismissPolicy === 'any' && <DropdownMenuItem onSelect={() => onDismiss('forever')}>Dismiss permanently</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </div>
  );
}
