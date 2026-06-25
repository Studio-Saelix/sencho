import { Copy } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { copyToClipboard } from '@/lib/clipboard';

// Anonymous volumes show a truncated name in the crumb and title; this band keeps
// the full 64-char hash visible and copyable for operators who need the real name.
export function AnonymousNameBand({ name }: { name: string }) {
  const handleCopy = async () => {
    try {
      await copyToClipboard(name);
      toast.success('Volume name copied.');
    } catch {
      toast.error('Copy failed.');
    }
  };
  return (
    <div className="flex items-center gap-2 px-6 pt-4 text-xs">
      <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-muted/40 text-muted-foreground text-[10px] font-medium shrink-0">
        anonymous
      </span>
      <span className="font-mono text-muted-foreground break-all min-w-0">{name}</span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy full volume name"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}
