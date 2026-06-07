import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useToasts,
  removeToast,
  type Toast,
  type ToastType,
} from './toast-store';

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  success: 4000,
  error: 6000,
  warning: 5000,
  info: 4000,
  loading: Infinity,
};

const MAX_VISIBLE = 5;

type ToastConfig = {
  icon: LucideIcon;
  iconClass: string;
  railClass: string;
  progressClass: string;
  kicker: string;
  spin?: boolean;
};

const TOAST_CONFIG: Record<ToastType, ToastConfig> = {
  success: {
    icon: CheckCircle2,
    iconClass: 'text-success',
    railClass: 'bg-success',
    progressClass: 'bg-success/50',
    kicker: 'Success',
  },
  error: {
    icon: XCircle,
    iconClass: 'text-destructive',
    railClass: 'bg-destructive',
    progressClass: 'bg-destructive/50',
    kicker: 'Error',
  },
  warning: {
    icon: AlertTriangle,
    iconClass: 'text-warning',
    railClass: 'bg-warning',
    progressClass: 'bg-warning/50',
    kicker: 'Warning',
  },
  info: {
    icon: Info,
    iconClass: 'text-info',
    railClass: 'bg-info',
    progressClass: 'bg-info/50',
    kicker: 'Info',
  },
  loading: {
    icon: Loader2,
    iconClass: 'text-brand',
    railClass: 'bg-brand',
    progressClass: 'bg-brand/50',
    kicker: 'Working',
    spin: true,
  },
};

const ToastItem = memo(function ToastItem({
  type,
  message,
  action,
  duration: explicitDuration,
  id,
}: Toast) {
  const config = TOAST_CONFIG[type];
  const Icon = config.icon;
  const duration = explicitDuration ?? DEFAULT_DURATIONS[type];

  const [hovered, setHovered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(duration);
  const startRef = useRef(0);

  const dismiss = useCallback(() => {
    removeToast(id);
  }, [id]);

  const handleAction = useCallback(() => {
    action?.onClick();
    removeToast(id);
  }, [action, id]);

  useEffect(() => {
    if (type === 'loading' || !Number.isFinite(duration)) return;
    if (hovered) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      remainingRef.current -= Date.now() - startRef.current;
      return;
    }
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, remainingRef.current);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [hovered, dismiss, type, duration]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 100 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 100 }}
      transition={{ duration: 0.3 }}
      className="pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-md border border-glass-border bg-popover/95 ring-1 ring-glass-border drop-shadow-xl backdrop-blur-[10px] backdrop-saturate-[1.15]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role={type === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
    >
      <div
        className={cn('absolute inset-y-0 left-0 w-[3px] opacity-70', config.railClass)}
        aria-hidden
      />

      <div className="flex items-start gap-3 px-4 py-3 pl-5">
        <Icon
          className={cn(
            'mt-0.5 h-4 w-4 flex-shrink-0',
            config.iconClass,
            config.spin && 'animate-spin',
          )}
          strokeWidth={1.5}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'font-mono text-[10px] uppercase tracking-[0.14em]',
              config.iconClass,
            )}
          >
            {config.kicker}
          </div>
          <p className="mt-1 break-words text-sm leading-snug text-stat-value">
            {message}
          </p>
        </div>
        {action ? (
          <button
            type="button"
            onClick={handleAction}
            className="flex-shrink-0 self-start rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand transition-colors hover:bg-brand/10 focus-visible:bg-brand/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
          >
            {action.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notification"
          className="flex-shrink-0 self-start rounded-sm p-1 text-stat-icon transition-colors hover:bg-accent hover:text-stat-value focus-visible:bg-accent focus-visible:outline-none"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      </div>

      <div className="absolute bottom-0 left-0 h-[2px] w-full overflow-hidden" aria-hidden>
        {type === 'loading' ? (
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: '200%' }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            className={cn('h-full w-1/3', config.progressClass)}
          />
        ) : Number.isFinite(duration) ? (
          <motion.div
            initial={{ width: 0 }}
            animate={hovered ? false : { width: '100%' }}
            transition={{ duration: duration / 1000, ease: 'linear' }}
            className={cn('h-full', config.progressClass)}
          />
        ) : null}
      </div>
    </motion.div>
  );
});

export function ToastContainer() {
  const toasts = useToasts();
  const visible = toasts.slice(-MAX_VISIBLE);

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-full max-w-sm flex-col gap-2 p-4 max-md:bottom-[calc(var(--sn-mobile-tabbar-h)_+_env(safe-area-inset-bottom)_+_0.75rem)]">
      <AnimatePresence mode="popLayout">
        {visible.map((t) => (
          <ToastItem key={t.id} {...t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
