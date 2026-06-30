import * as React from 'react';
import { cn } from '@/lib/utils';

interface AuthCanvasProps extends React.HTMLAttributes<HTMLDivElement> {
  footer?: React.ReactNode;
}

export function AuthCanvas({ children, className, footer, ...props }: AuthCanvasProps) {
  return (
    <div
      className={cn(
        // overflow-y-auto: html/body are overflow:hidden, so this shell must scroll
        // when the card still exceeds the viewport. my-auto on the card centers it
        // when content is short (replaces justify-center, which clips tall cards).
        'relative flex min-h-svh flex-col items-center overflow-y-auto px-4 py-10 sm:px-6',
        className,
      )}
      {...props}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(circle_at_50%_-10%,oklch(0.78_0.11_195_/_0.10),transparent_55%)]"
      />

      <div
        role="group"
        className="relative my-auto flex min-h-0 w-full max-w-[440px] max-h-[calc(100dvh-5rem)] flex-col animate-scale-in overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel"
        style={{ animationDuration: 'var(--duration-base)', animationTimingFunction: 'var(--ease-out-expo)' }}
      >
        <div aria-hidden className="absolute inset-y-0 left-0 w-[3px] overflow-hidden bg-brand/70">
          <div className="animate-shimmer absolute inset-x-0 h-1/3 bg-gradient-to-b from-transparent via-white/60 to-transparent" />
        </div>

        <div className="flex shrink-0 items-center justify-between border-b border-card-border/60 px-7 pt-6 pb-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
            SENCHO
          </span>
          <span className="relative flex h-1.5 w-1.5">
            <span aria-hidden className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_0_oklch(0.78_0.11_195_/_0.6)]" />
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-7 pt-6">{children}</div>

        {footer && (
          <div className="shrink-0 border-t border-card-border/60 px-7 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
