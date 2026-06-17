import { useState } from 'react';
import { GripVertical, ArrowUp, ArrowDown, X, FolderGit2, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-is-mobile';

export interface GitBrowseResult {
  files: string[];
  truncated: boolean;
}

interface GitComposeFilePickerProps {
  composePaths: string[];
  contextDir: string;
  onComposePathsChange: (paths: string[]) => void;
  onContextDirChange: (value: string) => void;
  /** Parent runs the correct browse endpoint (create vs edit) and returns the repo file list, or null on failure. */
  onBrowse: () => Promise<GitBrowseResult | null>;
  /** True when the repo URL + branch are filled, so a browse can succeed. */
  canBrowse: boolean;
  disabled?: boolean;
}

const isComposeLike = (p: string) => /\.ya?ml$/i.test(p);

export function GitComposeFilePicker({
  composePaths,
  contextDir,
  onComposePathsChange,
  onContextDirChange,
  onBrowse,
  canBrowse,
  disabled = false,
}: GitComposeFilePickerProps) {
  const isMobile = useIsMobile();
  const [manualPath, setManualPath] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [repoFiles, setRepoFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);

  const addPath = (raw: string) => {
    const value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!value || composePaths.includes(value)) return;
    onComposePathsChange([...composePaths, value]);
  };

  const removeAt = (index: number) => {
    onComposePathsChange(composePaths.filter((_, i) => i !== index));
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= composePaths.length || from === to) return;
    const next = [...composePaths];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onComposePathsChange(next);
  };

  const runBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await onBrowse();
      if (result) {
        // Compose-like files first so they are easy to pick out of a large repo.
        const sorted = [...result.files].sort((a, b) => {
          const ac = isComposeLike(a) ? 0 : 1;
          const bc = isComposeLike(b) ? 0 : 1;
          return ac - bc || a.localeCompare(b);
        });
        setRepoFiles(sorted);
        setTruncated(result.truncated);
      }
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="space-y-3">
      <Label>Compose files <span className="text-stat-subtitle font-normal">(merged in order)</span></Label>

      {composePaths.length === 0 ? (
        <p className="text-[11px] text-stat-subtitle rounded-md border border-dashed border-glass-border px-3 py-2">
          No compose files selected. Browse the repository or add a path below.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {composePaths.map((p, index) => (
            <li
              key={`${p}-${index}`}
              draggable={!disabled && !isMobile}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => { if (dragIndex !== null) e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              className={cn(
                'flex items-center gap-2 rounded-md border border-glass-border bg-card-bg/40 px-2 py-1.5',
                dragIndex === index && 'opacity-50',
                !disabled && !isMobile && 'cursor-grab',
              )}
            >
              {isMobile ? (
                <div className="flex flex-col -my-1">
                  <button type="button" disabled={disabled || index === 0} onClick={() => move(index, index - 1)}
                    className="text-stat-subtitle hover:text-foreground disabled:opacity-30" aria-label="Move up">
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" disabled={disabled || index === composePaths.length - 1} onClick={() => move(index, index + 1)}
                    className="text-stat-subtitle hover:text-foreground disabled:opacity-30" aria-label="Move down">
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <GripVertical className="w-3.5 h-3.5 text-stat-subtitle shrink-0" />
              )}
              <span className="font-mono text-xs truncate flex-1" title={p}>{p}</span>
              {index === 0 && <span className="text-[10px] text-stat-subtitle shrink-0">primary</span>}
              <button type="button" disabled={disabled} onClick={() => removeAt(index)}
                className="text-stat-subtitle hover:text-danger disabled:opacity-30 shrink-0" aria-label={`Remove ${p}`}>
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="path/to/compose.yaml"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addPath(manualPath); setManualPath(''); }
          }}
          disabled={disabled}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || !manualPath.trim()}
          onClick={() => { addPath(manualPath); setManualPath(''); }}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || !canBrowse || browsing}
          onClick={runBrowse}>
          <FolderGit2 className="w-3.5 h-3.5 mr-1" />
          {browsing ? 'Browsing...' : 'Browse'}
        </Button>
      </div>

      {repoFiles && (
        <div className="rounded-md border border-glass-border">
          <ScrollArea className="max-h-48">
            <div className="p-2 space-y-1">
              {repoFiles.length === 0 && <p className="text-[11px] text-stat-subtitle px-1 py-2">No files found in the repository.</p>}
              {repoFiles.map((file) => {
                const selected = composePaths.includes(file);
                return (
                  <label key={file} className="flex items-center gap-2 px-1 py-0.5 cursor-pointer">
                    <Checkbox
                      checked={selected}
                      disabled={disabled}
                      onCheckedChange={(c) => {
                        if (c === true) addPath(file);
                        else onComposePathsChange(composePaths.filter(p => p !== file));
                      }}
                    />
                    <span className={cn('font-mono text-xs truncate', isComposeLike(file) ? 'text-foreground' : 'text-stat-subtitle')} title={file}>
                      {file}
                    </span>
                  </label>
                );
              })}
            </div>
          </ScrollArea>
          {truncated && (
            <p className="text-[10px] text-stat-subtitle px-2 py-1 border-t border-glass-border">
              Repository has many files; only the first 2000 are listed. Add other paths manually.
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="git-context-dir" className="text-xs">Project directory <span className="text-stat-subtitle font-normal">(optional)</span></Label>
        <Input
          id="git-context-dir"
          placeholder="e.g. deploy"
          value={contextDir}
          onChange={(e) => onContextDirChange(e.target.value)}
          disabled={disabled}
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-stat-subtitle">
          Sets <span className="font-mono">--project-directory</span> for relative paths. Leave blank to use the stack root.
        </p>
      </div>
    </div>
  );
}
