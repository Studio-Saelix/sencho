import { ArrowUpRight } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { toast } from '@/components/ui/toast-store';
import { copyToClipboard } from '@/lib/clipboard';
import { SENCHO_LABEL_DETECTION_CAPABILITY } from '@/lib/capabilities';
import { cn } from '@/lib/utils';
import {
  MAX_SKIP_LABEL_ENTRIES,
  alsoPulledLine,
  alsoPulledServices,
  serviceUpdateNotes,
  skipLabelLine,
} from '@/lib/updateServiceNotes';
import type { UpdatePreview } from '@/types/imageUpdates';

const VERB_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand hover:underline max-md:min-h-11';

/**
 * The one handler behind every Copy skip label verb: it copies the Compose
 * label line and says where it goes. Writing the label stays the operator's
 * edit, so a skip is never applied behind their back.
 */
async function copySkipLabel(service: string, entries: readonly string[]): Promise<void> {
  try {
    await copyToClipboard(skipLabelLine(entries));
    toast.success(
      `Skip label copied. Add it under the ${service} service's labels (as key=value in a list), save, then Recheck. A stack update still pulls its registry image; a build-backed service is built instead.`,
    );
  } catch (error) {
    console.error('[UpdateServiceNotes] Copy failed:', error);
    toast.error('Copy failed. Your browser blocked clipboard access.');
  }
}

interface UpdateServiceNotesProps {
  preview: Pick<UpdatePreview, 'images' | 'summary' | 'build_services'> | null | undefined;
  stack: string;
  nodeId: number | undefined;
  /** `list` is a row per service (cards, table detail, phone); `inline` is one quiet line (the Anatomy banner). */
  variant: 'list' | 'inline';
  className?: string;
}

/**
 * Per-service notes for a pending update: the service's changelog link, the
 * Copy skip label verb (only when the candidate is known, the node evaluates
 * the detection labels, and the user may edit the stack; otherwise the verb is
 * absent, not disabled), and the services the update also pulls although their
 * labels skip or do not check them. Renders nothing when there is nothing to say.
 */
export function UpdateServiceNotes({ preview, stack, nodeId, variant, className }: UpdateServiceNotesProps) {
  const { can } = useAuth();
  const { nodeMeta } = useNodes();
  const nodeEvaluatesDetection = nodeId !== undefined
    && (nodeMeta.get(nodeId)?.capabilities.includes(SENCHO_LABEL_DETECTION_CAPABILITY) ?? false);
  const canSkip = nodeEvaluatesDetection && can('stack:edit', 'stack', stack, nodeId);
  const notes = serviceUpdateNotes(preview?.images ?? [])
    .map(note => ({
      ...note,
      skipEntries: canSkip ? note.skipEntries : [],
      skipLimitReached: canSkip && note.skipLimitReached,
    }))
    .filter(note => note.changelogUrl || note.skipEntries.length > 0 || note.skipLimitReached);
  const alsoPulled = alsoPulledLine(alsoPulledServices(preview));
  if (notes.length === 0 && !alsoPulled) return null;
  const named = (preview?.images.filter(image => image.has_update).length ?? 0) > 1 || variant === 'inline';

  return (
    <div
      className={cn(variant === 'list' ? 'flex flex-col gap-1' : 'flex flex-wrap items-center gap-x-3 gap-y-0.5', className)}
      data-testid="update-service-notes"
    >
      {notes.map(note => (
        <div key={note.service} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5" data-testid="update-service-note">
          {named && <span className="truncate font-mono text-[11px] text-stat-subtitle">{note.service}</span>}
          {note.changelogUrl && (
            <a
              href={note.changelogUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={note.changelogUrl}
              className={VERB_CLASS}
              data-testid="update-changelog-link"
            >
              Changelog
              <ArrowUpRight className="h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            </a>
          )}
          {note.skipEntries.length > 0 && (
            <button
              type="button"
              className={VERB_CLASS}
              onClick={() => { void copySkipLabel(note.service, note.skipEntries); }}
              title={skipLabelLine(note.skipEntries)}
              aria-label={`Copy skip label for ${note.service}`}
              data-testid="update-copy-skip-label"
            >
              Copy skip label
            </button>
          )}
          {note.skipLimitReached && (
            <span className="font-mono text-[11px] text-stat-subtitle" data-testid="update-skip-limit">
              Skip label is full ({MAX_SKIP_LABEL_ENTRIES} entries); remove one before adding another.
            </span>
          )}
        </div>
      ))}
      {alsoPulled && (
        <div className="font-mono text-[11px] text-stat-subtitle" data-testid="update-also-pulls">{alsoPulled}</div>
      )}
    </div>
  );
}
