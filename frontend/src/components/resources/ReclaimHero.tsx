import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, X } from 'lucide-react';
import { formatBytes } from '@/lib/utils';

interface ReclaimHeroProps {
  bytes: number;
  imageCount: number;
  containerCount: number;
  volumeCount: number;
  onReview: () => void;
  onDismiss: () => void;
  disabled?: boolean;
}

export function ReclaimHero({
  bytes,
  imageCount,
  containerCount,
  volumeCount,
  onReview,
  onDismiss,
  disabled,
}: ReclaimHeroProps) {
  const composition = useMemo(() => {
    const parts: string[] = [];
    if (imageCount > 0) parts.push(`${imageCount} ${imageCount === 1 ? 'unused image' : 'unused images'}`);
    if (containerCount > 0) parts.push(`${containerCount} ${containerCount === 1 ? 'stopped container' : 'stopped containers'}`);
    if (volumeCount > 0) parts.push(`${volumeCount} ${volumeCount === 1 ? 'dangling volume' : 'dangling volumes'}`);
    return parts.join(' · ');
  }, [imageCount, containerCount, volumeCount]);

  if (bytes <= 0) {
    return null;
  }

  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg border border-warning/25 border-t-warning/35 bg-card shadow-card-bevel">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-warning/[0.08] via-warning/[0.02] to-transparent" />
      <div className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 z-10 rounded-md p-1 text-stat-subtitle/40 transition-colors hover:bg-warning/10 hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      <div className="relative grid grid-cols-[1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-warning">
            You can reclaim
          </span>
          <span className="font-display italic text-4xl leading-none tracking-tight text-stat-value">
            {formatBytes(bytes)}
          </span>
          {composition ? (
            <span className="font-mono text-[11px] text-stat-subtitle/90">
              {composition}
            </span>
          ) : null}
        </div>

        <div className="flex items-center">
          <Button
            variant="outline"
            className="gap-2 border-warning/40 text-warning hover:bg-warning/10 hover:text-warning hover:border-warning/60"
            onClick={onReview}
            disabled={disabled}
          >
            <Sparkles className="h-4 w-4" strokeWidth={1.5} />
            Review & prune
          </Button>
        </div>
      </div>
    </div>
  );
}
