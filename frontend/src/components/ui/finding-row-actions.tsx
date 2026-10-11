import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { DismissalMode, DismissPolicy } from '@/types/findingDismissal';

/** Shared chrome for the resolving verb on a finding row (outline, fixed height). */
export const FINDING_ROW_PRIMARY_CLASS =
  'h-7 whitespace-nowrap px-2 text-xs shadow-none max-md:min-h-11';

interface FindingRowActionsProps {
  /** The finding's resolving verb, if any. It stays first and loudest. */
  children?: ReactNode;
  /** Rare or secondary verbs (copy, Open Doctor, …). Renders as the trailing ··· menu. */
  overflow?: ReactNode;
  /** What the server allows. `none` renders no Dismiss at all. */
  dismissPolicy: DismissPolicy;
  /** False when the current account may not dismiss; the control is then omitted rather than left to 403. */
  canDismiss: boolean;
  pending?: boolean;
  /** What the dismissal is about, so each row's button has its own accessible name. */
  subject?: string;
  onDismiss: (mode: DismissalMode, days?: number) => void;
}

/**
 * The action cluster on a finding row: resolving verb, Dismiss split, then overflow.
 *
 * One click on Dismiss holds until the finding changes. The chevron offers the other
 * holds. A finding about evidence that could not be read has no "until it changes"
 * and no "permanently", so its one click dismisses for 7 days and the chevron offers 30.
 */
export function FindingRowActions({
  children,
  overflow,
  dismissPolicy,
  canDismiss,
  pending = false,
  subject,
  onDismiss,
}: FindingRowActionsProps) {
  const showDismiss = canDismiss && dismissPolicy !== 'none';
  const timedOnly = dismissPolicy === 'timed';
  const primaryDismiss = (): void => (timedOnly ? onDismiss('days', 7) : onDismiss('until_change'));
  const label = subject ? `Dismiss: ${subject}` : 'Dismiss';

  return (
    <div className="ml-auto flex items-center justify-end gap-1">
      {children}
      {showDismiss && (
        <div className="flex items-center">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-7 rounded-r-none px-2 text-xs text-stat-subtitle shadow-none hover:text-stat-value max-md:min-h-11',
            )}
            disabled={pending}
            aria-label={label}
            title={timedOnly ? 'This finding is about evidence that could not be read, so it is dismissed for 7 days.' : undefined}
            onClick={primaryDismiss}
          >
            Dismiss
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 rounded-l-none border-l-0 px-0 shadow-none max-md:min-h-11 max-md:min-w-11"
                disabled={pending}
                aria-label="More ways to dismiss"
              >
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
      )}
      {overflow}
    </div>
  );
}
