import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useVisualBusy } from '@/hooks/useVisualBusy';

type IconBusyButtonBase = Omit<ButtonProps, 'asChild' | 'children'> & {
  /** Resting icon. It spins in place once the delayed busy state shows. */
  icon: LucideIcon;
  /** Immediate interaction lock. Disables the control while true. */
  pending: boolean;
  /** Shown instead of `icon` once busy chrome shows, for icons that should not spin (a shield, a trash can). */
  busyIcon?: LucideIcon;
};

/** An icon-only control must carry an accessible name; a labelled one is named by its text. */
export type IconBusyButtonProps = IconBusyButtonBase &
  (
    | { label: string; 'aria-label'?: never }
    | { label?: undefined; 'aria-label': string }
  );

/**
 * Composition over {@link Button} for refresh, recheck and scan controls that
 * keep their icon. The click locks at once and sets `aria-busy`; the icon turns
 * (or swaps to `busyIcon`) only after the visual-busy delay, so a fast answer
 * never flashes busy chrome.
 */
export const IconBusyButton = React.forwardRef<HTMLButtonElement, IconBusyButtonProps>(
  ({ icon: Icon, busyIcon: BusyIcon, pending, label, disabled, className, type = 'button', ...props }, ref) => {
    const { showBusy } = useVisualBusy(pending);
    const ShownIcon = showBusy && BusyIcon ? BusyIcon : Icon;
    return (
      <Button
        ref={ref}
        type={type}
        className={className}
        {...props}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
      >
        <ShownIcon
          className={showBusy ? 'animate-spin' : undefined}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {label}
      </Button>
    );
  },
);
IconBusyButton.displayName = 'IconBusyButton';
