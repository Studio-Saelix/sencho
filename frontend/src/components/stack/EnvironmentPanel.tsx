import { useEffect, useState, useCallback } from 'react';
import { Lock, Copy, Info, TriangleAlert, ShieldAlert, X, ChevronUp, ChevronDown, CircleCheck, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { copyToClipboard } from '@/lib/clipboard';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import {
  buildEnvChecklistMarkdown,
  SOURCE_LABELS,
  type EnvInventory,
  type EnvInventoryItem,
  type EnvItemStatus,
  type EnvFileExistence,
} from '@/lib/envChecklist';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath } from '@/components/ui/status-path';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import type { StatusTone } from '@/lib/statusTone';

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

const EXISTENCE_TONE: Record<EnvFileExistence, string> = {
  present: 'border-muted bg-card/40 text-stat-subtitle',
  missing: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
  unverifiable: 'border-warning/40 bg-warning/[0.06] text-warning',
};

interface EnvAnswerModel {
  tone: StatusTone;
  title: string;
  line: string;
  icon: LucideIcon;
  /** True when the fix lives in a file the operator edits. */
  fixable: boolean;
}

/**
 * The one Answer for the tab: the loudest problem across variables and env
 * files. Counts per status live in the group headers below, so the Answer
 * names the problem and what it does, never the tally again.
 */
function envAnswer(inventory: EnvInventory): EnvAnswerModel | null {
  const { missing, duplicate, unpersisted } = inventory.summary;
  const missingFiles = inventory.envFiles.filter(f => f.existence === 'missing' && f.required).length;
  const unverifiableFiles = inventory.envFiles.filter(f => f.existence === 'unverifiable').length;
  if (missing > 0) {
    return { tone: 'destructive', icon: ShieldAlert, fixable: true, title: `${missing} missing`,
      line: 'Referenced by the Compose file but set nowhere. Compose substitutes an empty string, or refuses to start when the variable is required.' };
  }
  if (missingFiles > 0) {
    return { tone: 'destructive', icon: ShieldAlert, fixable: true, title: missingFiles === 1 ? 'env file missing' : `${missingFiles} env files missing`,
      line: 'A declared env file cannot be found, so the variables it carries never reach the service.' };
  }
  if (duplicate > 0) {
    return { tone: 'warning', icon: TriangleAlert, fixable: true, title: `${duplicate} duplicate`,
      line: 'Defined in two places, which can resolve to different values.' };
  }
  if (unpersisted > 0) {
    return { tone: 'warning', icon: TriangleAlert, fixable: true, title: `${unpersisted} shell-only`,
      line: 'Resolved only from the host shell, so they do not follow the stack to another node.' };
  }
  if (unverifiableFiles > 0) {
    return { tone: 'warning', icon: TriangleAlert, fixable: false, title: unverifiableFiles === 1 ? 'env file unverifiable' : `${unverifiableFiles} env files unverifiable`,
      line: 'Sencho cannot read a declared env file to check it.' };
  }
  if (!inventory.renderable) {
    return { tone: 'warning', icon: TriangleAlert, fixable: false, title: 'partial view',
      line: 'Sencho could not render the effective Compose model, so this inventory covers the authored env files only.' };
  }
  if (inventory.items.length === 0) return null;
  return { tone: 'success', icon: CircleCheck, fixable: false, title: 'resolved', line: 'Every referenced variable is set, and no variable is defined twice.' };
}

function EnvironmentSkeleton() {
  return (
    <div data-testid="environment-skeleton" role="status" className="flex flex-col gap-4">
      <span className="sr-only">Loading environment</span>
      <Skeleton className="h-14 w-full" />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

function scopeLabel(item: EnvInventoryItem): string {
  const parts: string[] = [];
  if (item.usedForInterpolation) parts.push('interpolation');
  if (item.injectedIntoService) parts.push('injected');
  return parts.join(' + ') || 'unused';
}

function ItemRow({ item }: { item: EnvInventoryItem }) {
  const sources = item.sources.map(s => SOURCE_LABELS[s] ?? s).join(', ') || '-';
  return (
    <div className="border-t border-muted py-2 first:border-t-0" data-testid="env-item-row" data-key={item.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium text-foreground/90">{item.key}</span>
        {item.likelySecret && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-testid="env-secret-badge"
                  className="inline-flex items-center gap-1 rounded border border-muted bg-card/40 px-1.5 py-0.5 font-mono text-[10px] text-stat-subtitle"
                >
                  <Lock className="h-2.5 w-2.5" strokeWidth={1.5} /> secret
                </span>
              </TooltipTrigger>
              <TooltipContent>Likely a secret. Its value is never read or shown.</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {item.required && (
          <span className="rounded border border-muted px-1.5 py-0.5 font-mono text-[10px] text-stat-subtitle">required</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10px] text-stat-subtitle">
        <span>source: {sources}</span>
        <span>scope: {scopeLabel(item)}</span>
      </div>
    </div>
  );
}

const STATUS_GROUPS: { status: EnvItemStatus; label: string }[] = [
  { status: 'missing', label: 'missing' },
  { status: 'duplicate', label: 'duplicate' },
  { status: 'unpersisted', label: 'shell-only' },
  { status: 'unused', label: 'unused' },
  { status: 'present', label: 'present' },
];

export default function EnvironmentPanel({ stackName, onOpenFiles }: { stackName: string; onOpenFiles?: () => void }) {
  const { activeNode, hasCapability } = useNodes();
  const { can } = useAuth();
  const nodeId = activeNode?.id;
  const [inventory, setInventory] = useState<EnvInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [copying, setCopying] = useState(false);
  const { showBusy } = useVisualBusy(loading && !inventory);

  // Project env file selection
  const projectEnvCapable = hasCapability('project-env-files');
  const canEdit = can('stack:edit', 'stack', stackName, nodeId);
  const [projectEnvFiles, setProjectEnvFiles] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [savingProjectEnv, setSavingProjectEnv] = useState(false);

  const fetchJsonEnvFiles = useCallback(async (suffix: string, setter: (v: string[]) => void) => {
    if (!projectEnvCapable) return;
    try {
      const res = await apiFetch(`/stacks/${stackName}/project-env-files${suffix}`);
      if (res.ok) {
        const data = await res.json() as { envFiles: string[] };
        setter(data.envFiles);
      }
    } catch { /* silently skip on older nodes */ }
  }, [stackName, projectEnvCapable]);

  const fetchProjectEnvFiles = useCallback(
    () => fetchJsonEnvFiles('', setProjectEnvFiles),
    [fetchJsonEnvFiles],
  );

  const fetchCandidates = useCallback(
    () => fetchJsonEnvFiles('/candidates', setCandidates),
    [fetchJsonEnvFiles],
  );

  const fetchInventory = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiFetch(`/stacks/${stackName}/env-inventory`);
      if (!res.ok) {
        setLoadError(true);
        toast.error('Failed to load the environment inventory.');
        return;
      }
      setInventory((await res.json()) as EnvInventory);
    } catch {
      setLoadError(true);
      toast.error('Failed to load the environment inventory.');
    } finally {
      setLoading(false);
    }
  }, [stackName]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await fetchInventory();
      if (cancelled) return;
      await fetchProjectEnvFiles();
      if (cancelled) return;
      await fetchCandidates();
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveProjectEnvFiles = async (files: string[]) => {
    setSavingProjectEnv(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/project-env-files`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envFiles: files }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? 'Failed to save project env file selection.');
        return;
      }
      setProjectEnvFiles(files);
      toast.success('Project env file selection saved.');
      // Refresh inventory to reflect new interpolation source.
      await fetchInventory();
    } catch {
      toast.error('Failed to save project env file selection.');
    } finally {
      setSavingProjectEnv(false);
    }
  };

  const addProjectEnvFile = (file: string) => {
    if (!file || projectEnvFiles.includes(file)) return;
    saveProjectEnvFiles([...projectEnvFiles, file]);
  };

  const removeProjectEnvFile = (idx: number) => {
    saveProjectEnvFiles(projectEnvFiles.filter((_, i) => i !== idx));
  };

  const moveProjectEnvFile = (idx: number, dir: -1 | 1) => {
    const newFiles = [...projectEnvFiles];
    const target = idx + dir;
    if (target < 0 || target >= newFiles.length) return;
    [newFiles[idx], newFiles[target]] = [newFiles[target], newFiles[idx]];
    saveProjectEnvFiles(newFiles);
  };

  const copyChecklist = async () => {
    if (!inventory) return;
    setCopying(true);
    try {
      await copyToClipboard(buildEnvChecklistMarkdown(inventory));
      toast.success('Env checklist copied. Names and status only, no values.');
    } catch {
      toast.error('Failed to copy the env checklist.');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div data-testid="environment-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>environment</span>
        <button
          type="button"
          data-testid="env-copy-checklist-btn"
          onClick={copyChecklist}
          disabled={!inventory || copying}
          className={ACTION_CLASS}
        >
          <Copy className="h-3 w-3" strokeWidth={1.5} /> copy env checklist
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-stat-subtitle">
        Compose reads the project environment file and the shell for <span className="font-mono">{'${VAR}'}</span> interpolation,
        while <span className="font-mono">env_file</span> and inline <span className="font-mono">environment</span> are injected into the container.
        Values are never read or shown: likely secrets show presence only.
      </p>

      {projectEnvCapable && (
        <section data-testid="project-env-section">
          <div className={cn(LABEL_CLASS, 'mb-1.5')}>project environment file</div>
          <div className="rounded-lg border border-muted bg-card/40 px-3 py-2">
            {projectEnvFiles.length === 0 ? (
              <p className="text-[11px] text-stat-subtitle py-1">
                Using <span className="font-mono">.env</span> (default). Compose auto-discovers <span className="font-mono">.env</span> in the project directory.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {projectEnvFiles.map((file, idx) => (
                  <div key={file} className="flex items-center gap-1.5 py-1 border-t border-muted first:border-t-0">
                    <span className="font-mono text-[12px] text-foreground/90 flex-1">{file}</span>
                    {canEdit && (
                      <>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => moveProjectEnvFile(idx, -1)}
                                disabled={idx === 0 || savingProjectEnv}
                                className="p-0.5 text-stat-subtitle hover:text-brand disabled:opacity-30"
                              >
                                <ChevronUp className="h-3 w-3" strokeWidth={1.5} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Move up</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => moveProjectEnvFile(idx, 1)}
                                disabled={idx === projectEnvFiles.length - 1 || savingProjectEnv}
                                className="p-0.5 text-stat-subtitle hover:text-brand disabled:opacity-30"
                              >
                                <ChevronDown className="h-3 w-3" strokeWidth={1.5} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Move down</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => removeProjectEnvFile(idx)}
                                disabled={savingProjectEnv}
                                className="p-0.5 text-stat-subtitle hover:text-destructive disabled:opacity-30"
                              >
                                <X className="h-3 w-3" strokeWidth={1.5} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Remove</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canEdit && candidates.length > 0 && (
              <div className="flex items-center gap-2 mt-2 pt-2 border-t border-muted">
                <Select
                  value=""
                  onValueChange={addProjectEnvFile}
                  disabled={savingProjectEnv}
                >
                  <SelectTrigger className="h-7 text-[11px] bg-muted border-none w-full">
                    <SelectValue placeholder="Add env file…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates
                      .filter(f => !projectEnvFiles.includes(f))
                      .map(file => (
                        <SelectItem key={file} value={file} className="text-[11px]">
                          {file}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </section>
      )}

      {loadError ? (
        <StatusPath
          stages={[]}
          answer={{
            tone: 'destructive',
            icon: ShieldAlert,
            title: 'could not load',
            line: 'Could not load the environment inventory.',
            action: (
              <Button type="button" size="sm" variant="outline" data-testid="env-retry-btn" disabled={loading} className="h-7 rounded-lg max-md:h-11" onClick={() => void fetchInventory()}>
                Retry
              </Button>
            ),
          }}
        />
      ) : !inventory ? (
        showBusy ? <EnvironmentSkeleton /> : null
      ) : (
        <>
          {(() => {
            const answer = envAnswer(inventory);
            if (!answer) return null;
            return (
              <StatusPath
                stages={[]}
                data-testid="env-answer"
                answer={{
                  tone: answer.tone,
                  icon: answer.icon,
                  title: answer.title,
                  line: answer.line,
                  marker: inventory.renderable ? undefined : 'effective model unavailable',
                  action: answer.fixable && onOpenFiles ? (
                    <Button type="button" size="sm" variant="outline" className="h-7 rounded-lg max-md:h-11" onClick={onOpenFiles}>
                      Edit env files
                    </Button>
                  ) : undefined,
                }}
              />
            );
          })()}

          {(() => {
            // Declared env files plus anything not cleanly present, so a missing or
            // unreadable env_file is visible right here, alongside the variables.
            const files = inventory.envFiles.filter(f => f.isInjectionSource || f.existence !== 'present');
            if (files.length === 0) return null;
            return (
              <section data-testid="env-files-section">
                <div className={cn(LABEL_CLASS, 'mb-1.5')}>env files · {files.length}</div>
                <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                  {files.map((f, i) => (
                    <div key={`${f.rawPaths.join(',')}-${i}`} className="flex flex-wrap items-center gap-2 border-t border-muted py-2 first:border-t-0">
                      <span className="font-mono text-[12px] text-foreground/90">{f.rawPaths.join(', ')}</span>
                      <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]', EXISTENCE_TONE[f.existence])}>
                        {f.existence}
                      </span>
                      {f.declaringServices.length > 0 && (
                        <span className="font-mono text-[10px] text-stat-subtitle">{f.declaringServices.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          {inventory.items.length === 0 ? (
            <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex items-center gap-2 text-stat-subtitle')}>
              <Info className="h-4 w-4" strokeWidth={1.5} />
              <span className="text-[12px]">No environment variables are referenced or defined for this stack.</span>
            </div>
          ) : (
            STATUS_GROUPS.map(({ status, label }) => {
              const items = inventory.items.filter(i => i.status === status);
              if (items.length === 0) return null;
              return (
                <section key={status} aria-labelledby={`env-group-${status}`}>
                  <div id={`env-group-${status}`} className={cn(LABEL_CLASS, 'mb-1.5')}>{label} · {items.length}</div>
                  <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                    {items.map(item => <ItemRow key={item.key} item={item} />)}
                  </div>
                </section>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
