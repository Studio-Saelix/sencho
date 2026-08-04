import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { cn } from '@/lib/utils';

export type BusyButtonProps = ButtonProps & {
  /** Immediate interaction lock. Disables the control while true. */
  pending: boolean;
  /**
   * Progressive label once delayed visual busy is shown. When omitted, idle
   * children stay visible and only the spinner (if shown) appears.
   */
  busyLabel?: React.ReactNode;
};

/**
 * Composition over {@link Button} for async click surfaces.
 * Never use `asChild` on this component: busy chrome is multi-child content.
 */
export const BusyButton = React.forwardRef<HTMLButtonElement, BusyButtonProps>(
  ({ pending, busyLabel, children, disabled, className, type = 'button', ...props }, ref) => {
    const { showBusy } = useVisualBusy(pending);
    const useTwinLabels =
      typeof children === 'string' &&
      typeof busyLabel === 'string';

    return (
      <Button
        ref={ref}
        type={type}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={className}
        {...props}
      >
        {pending ? (
          <span
            className="inline-flex size-4 shrink-0 items-center justify-center"
            aria-hidden
          >
            {showBusy ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
            ) : null}
          </span>
        ) : null}
        {useTwinLabels ? (
          <span className="relative inline-grid justify-items-center">
            <span
              className={cn(
                'col-start-1 row-start-1',
                showBusy && busyLabel != null && 'invisible',
              )}
              aria-hidden={showBusy && busyLabel != null ? true : undefined}
            >
              {children}
            </span>
            <span
              className={cn(
                'col-start-1 row-start-1',
                !(showBusy && busyLabel != null) && 'invisible',
              )}
              aria-hidden={!(showBusy && busyLabel != null) ? true : undefined}
            >
              {busyLabel}
            </span>
          </span>
        ) : (
          <>{showBusy && busyLabel != null ? busyLabel : children}</>
        )}
      </Button>
    );
  },
);
BusyButton.displayName = 'BusyButton';
