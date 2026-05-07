import * as React from 'react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const KICKER_CLASS = 'font-mono text-[10px] uppercase tracking-[0.22em]';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'wide';

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl w-[95vw]',
  wide: 'max-w-5xl w-[95vw]',
};

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  size?: ModalSize;
  className?: string;
}

export function Modal({ open, onOpenChange, children, size = 'md', className }: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 gap-0 overflow-hidden grid-cols-1',
          SIZE_CLASS[size],
          className,
        )}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

interface ModalHeaderBaseProps {
  kicker: string;
  title: React.ReactNode;
  description?: string;
}

type HeaderVariant = 'default' | 'destructive';

const HEADER_VARIANT: Record<HeaderVariant, { rail: string; kicker: string }> = {
  default: { rail: 'bg-brand', kicker: 'text-stat-subtitle' },
  destructive: { rail: 'bg-destructive', kicker: 'text-destructive' },
};

interface HeaderShellProps extends ModalHeaderBaseProps {
  variant: HeaderVariant;
  TitleComponent: React.ElementType;
  DescriptionComponent: React.ElementType;
}

function HeaderShell({
  kicker,
  title,
  description,
  variant,
  TitleComponent,
  DescriptionComponent,
}: HeaderShellProps) {
  const v = HEADER_VARIANT[variant];
  return (
    <div className="relative border-b border-card-border/60 px-6 pt-6 pb-4 pr-12">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', v.rail)} />
      <div className={cn(KICKER_CLASS, v.kicker)}>
        {kicker}
      </div>
      <TitleComponent className="mt-1 font-display text-[1.75rem] italic leading-tight text-stat-value">
        {title}
      </TitleComponent>
      <DescriptionComponent className="sr-only">
        {description ?? (typeof title === 'string' ? title : kicker)}
      </DescriptionComponent>
    </div>
  );
}

export function ModalHeader(props: ModalHeaderBaseProps) {
  return (
    <HeaderShell
      {...props}
      variant="default"
      TitleComponent={DialogTitle}
      DescriptionComponent={DialogDescription}
    />
  );
}

export function ModalDestructiveHeader(props: ModalHeaderBaseProps) {
  return (
    <HeaderShell
      {...props}
      variant="destructive"
      TitleComponent={DialogTitle}
      DescriptionComponent={DialogDescription}
    />
  );
}

function ConfirmHeader(props: ModalHeaderBaseProps) {
  return (
    <HeaderShell
      {...props}
      variant="default"
      TitleComponent={AlertDialogTitle}
      DescriptionComponent={AlertDialogDescription}
    />
  );
}

function ConfirmDestructiveHeader(props: ModalHeaderBaseProps) {
  return (
    <HeaderShell
      {...props}
      variant="destructive"
      TitleComponent={AlertDialogTitle}
      DescriptionComponent={AlertDialogDescription}
    />
  );
}

export function ModalBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 py-5 space-y-4 max-h-[calc(85vh-12rem)] overflow-y-auto', className)} {...props} />;
}

interface ModalFooterProps {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  hint?: React.ReactNode;
  hintAccent?: React.ReactNode;
}

export function ModalFooter({ primary, secondary, hint, hintAccent }: ModalFooterProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-card-border/60 px-6 py-4">
      <div className={cn(KICKER_CLASS, 'text-stat-subtitle')}>
        {hint}
        {hintAccent !== undefined && (
          <span className="ml-1.5 rounded-sm border border-card-border bg-card px-1.5 py-0.5 text-stat-value">
            {hintAccent}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {secondary}
        {primary}
      </div>
    </div>
  );
}

type ConfirmSize = 'sm' | 'md';

interface ConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: 'default' | 'destructive';
  size?: ConfirmSize;
  kicker: string;
  title: React.ReactNode;
  description?: string;
  hint?: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel?: React.ReactNode;
  confirming?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  children?: React.ReactNode;
}

export function ConfirmModal({
  open,
  onOpenChange,
  variant = 'default',
  size = 'sm',
  kicker,
  title,
  description,
  hint,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirming = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmModalProps) {
  const Header = variant === 'destructive' ? ConfirmDestructiveHeader : ConfirmHeader;
  const cancelClass = buttonVariants({ variant: 'outline', size: 'sm' });
  const actionClass = buttonVariants({
    variant: variant === 'destructive' ? 'destructive' : 'default',
    size: 'sm',
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn('p-0 gap-0 overflow-hidden border-card-border/60', SIZE_CLASS[size])}>
        <Header kicker={kicker} title={title} description={description} />
        {children !== undefined && <ModalBody>{children}</ModalBody>}
        <ModalFooter
          hint={hint}
          secondary={
            <AlertDialogCancel
              className={cancelClass}
              disabled={confirming}
              onClick={onCancel}
            >
              {cancelLabel}
            </AlertDialogCancel>
          }
          primary={
            <AlertDialogAction
              className={actionClass}
              disabled={confirming}
              onClick={(e) => {
                const result = onConfirm();
                // Async confirms keep the dialog open so the caller can render
                // `confirming` state and close via onOpenChange when work completes.
                // Sync confirms let Radix auto-close.
                if (result instanceof Promise) {
                  e.preventDefault();
                  void result;
                }
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          }
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}
