import { isAnonymousVolumeName, shortVolumeLabel } from '@/lib/volumeName';

interface VolumeNameLabelProps {
  name: string;
  /** Append a small `anonymous` chip when the name is an anonymous volume. */
  showChip?: boolean;
}

/**
 * Renders a volume name truncated to a readable prefix when anonymous, with the
 * full name available on hover. Named volumes display in full. Used in the
 * volumes table cell and the volume browser sheet title.
 */
export function VolumeNameLabel({ name, showChip = false }: VolumeNameLabelProps) {
  const anonymous = isAnonymousVolumeName(name);
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full align-middle">
      <span className="truncate" title={name} data-testid="volume-name-text">
        {shortVolumeLabel(name)}
      </span>
      {showChip && anonymous && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-muted/40 text-muted-foreground text-[10px] font-medium shrink-0"
          data-testid="anon-volume-chip"
        >
          anonymous
        </span>
      )}
    </span>
  );
}
