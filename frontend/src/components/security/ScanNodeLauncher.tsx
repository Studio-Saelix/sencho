import { useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNodeScan } from '@/hooks/useNodeScan';

interface ScanNodeLauncherProps {
  /** Admin on a node with a ready scanner; the launcher hides otherwise. */
  canScan: boolean;
  /** Fired after a scan finishes so the caller can refresh the overview. */
  onComplete?: () => void;
  /** Stretch the trigger to fill its row (the mobile Overview lead action). */
  fullWidth?: boolean;
}

const TYPES = [
  { key: 'vulns', label: 'Image vulnerabilities' },
  { key: 'secrets', label: 'Image secrets' },
  { key: 'misconfig', label: 'Compose misconfigurations' },
] as const;

type TypeKey = (typeof TYPES)[number]['key'];

/**
 * "Scan this node" launcher: pick any of the three scan types, then run the
 * node-wide scan with live progress in the deploy-feedback modal. The node is
 * captured once so the request and the progress stream stay bound to it even if
 * the active node changes mid-scan.
 */
export function ScanNodeLauncher({ canScan, onComplete, fullWidth = false }: ScanNodeLauncherProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Record<TypeKey, boolean>>({ vulns: true, secrets: true, misconfig: true });
  const { running, scan } = useNodeScan(onComplete);

  if (!canScan) return null;

  const anySelected = Object.values(selected).some(Boolean);

  const start = async () => {
    if (!anySelected || running) return;
    setOpen(false);
    await scan(selected);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={running} className={fullWidth ? 'w-full' : undefined}>
          {running
            ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />
            : <ShieldCheck className="w-4 h-4 mr-1.5" strokeWidth={1.5} />}
          Scan this node
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Scan types</p>
        <div className="space-y-2">
          {TYPES.map((t) => (
            <label key={t.key} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={selected[t.key]}
                onCheckedChange={(c) => setSelected((s) => ({ ...s, [t.key]: c === true }))}
                aria-label={t.label}
              />
              <span className="text-sm">{t.label}</span>
            </label>
          ))}
        </div>
        <Button size="sm" className="w-full" onClick={start} disabled={!anySelected}>
          Start scan
        </Button>
      </PopoverContent>
    </Popover>
  );
}
