import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { getStackEntryPermissions, setStackEntryPermissions } from '@/lib/stackFilesApi';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Bit mapping: owner (6-8), group (3-5), other (0-2)
// Within each set: read=4, write=2, execute=1
// ---------------------------------------------------------------------------

interface BitInfo {
  label: 'r' | 'w' | 'x';
  shift: number; // bit position
}

const BITS: BitInfo[] = [
  { label: 'r', shift: 2 },
  { label: 'w', shift: 1 },
  { label: 'x', shift: 0 },
];

interface Category {
  label: string;
  baseShift: number; // owner=6, group=3, other=0
}

const CATEGORIES: Category[] = [
  { label: 'Owner', baseShift: 6 },
  { label: 'Group', baseShift: 3 },
  { label: 'Other', baseShift: 0 },
];

function getBit(mode: number, totalShift: number): boolean {
  return Boolean(mode & (1 << totalShift));
}

function toggleBit(mode: number, totalShift: number): number {
  return mode ^ (1 << totalShift);
}

// ---------------------------------------------------------------------------

interface FilePermissionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  relPath: string;
  entryName: string;
  canEdit: boolean;
}

export function FilePermissionsDialog({
  open,
  onOpenChange,
  stackName,
  relPath,
  entryName,
  canEdit,
}: FilePermissionsDialogProps) {
  const [mode, setMode] = useState<number>(0o644);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getStackEntryPermissions(stackName, relPath);
      setMode(result.mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load permissions.');
    } finally {
      setLoading(false);
    }
  }, [stackName, relPath]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleClose = (next: boolean) => {
    if (saving) return;
    onOpenChange(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setStackEntryPermissions(stackName, relPath, mode);
      toast.success('Permissions updated.');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update permissions.');
    } finally {
      setSaving(false);
    }
  };

  const octal = mode.toString(8).padStart(3, '0');
  const canModify = canEdit;

  return (
    <Modal open={open} onOpenChange={handleClose} size="sm">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · PERMISSIONS`}
        title="Permissions"
        description={`Unix permission bits for ${entryName}.`}
      />
      <ModalBody>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" strokeWidth={1.5} />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div className="space-y-4">
            {/* bit grid */}
            <div className="grid grid-cols-4 gap-x-3 gap-y-2 text-xs">
              {/* header row */}
              <div /> {/* empty corner */}
              {BITS.map((b) => (
                <div key={b.label} className="text-center font-mono font-medium text-muted-foreground uppercase tracking-wider">
                  {b.label}
                </div>
              ))}
              {/* category rows */}
              {CATEGORIES.map((cat) => (
                <>
                  <div key={cat.label} className="text-muted-foreground flex items-center">{cat.label}</div>
                  {BITS.map((bit) => {
                    const totalShift = cat.baseShift + bit.shift;
                    const checked = getBit(mode, totalShift);
                    return (
                      <button
                        key={bit.label}
                        type="button"
                        disabled={!canModify || saving}
                        onClick={() => setMode((m) => toggleBit(m, totalShift))}
                        className={cn(
                          'mx-auto flex h-7 w-7 items-center justify-center rounded-md border text-xs font-mono transition-colors',
                          checked
                            ? 'border-primary/60 bg-primary/10 text-primary'
                            : 'border-border bg-muted/30 text-muted-foreground',
                          canModify && !saving && 'hover:border-primary/50 cursor-pointer',
                          (!canModify || saving) && 'opacity-50 cursor-not-allowed'
                        )}
                        aria-label={`${cat.label} ${bit.label} ${checked ? 'on' : 'off'}`}
                      >
                        {bit.label}
                      </button>
                    );
                  })}
                </>
              ))}
            </div>

            {/* octal summary */}
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2">
              <span className="text-xs text-muted-foreground">Octal</span>
              <span className="font-mono text-sm tracking-widest">{octal}</span>
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter
        secondary={
          <Button variant="outline" size="sm" onClick={() => handleClose(false)} disabled={saving}>
            {canModify ? 'Cancel' : 'Close'}
          </Button>
        }
        primary={
          canModify ? (
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || loading}
            >
              {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />}
              Save
            </Button>
          ) : null
        }
      />
    </Modal>
  );
}
