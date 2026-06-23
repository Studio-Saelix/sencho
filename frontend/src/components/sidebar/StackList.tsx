import { useMemo, useState } from 'react';
import { ArrowUpRight, Loader2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useStackKeyboardShortcuts } from '@/hooks/useStackKeyboardShortcuts';
import { CommandItem, CommandList } from '@/components/ui/command';
import { Skeleton } from '@/components/ui/skeleton';
import type { Label } from '@/components/label-types';
import { StackRow } from './StackRow';
import { statusText, statusColor } from './stack-status-utils';
import type { StackRowStatus } from './stack-status-utils';
import { StackGroup } from './StackGroup';
import { StackContextMenu } from './StackContextMenu';
import { StackKebabMenu } from './StackKebabMenu';
import { EmptyStackState } from './EmptyStackState';
import type { StackMenuCtx, FilterChip } from './sidebar-types';

interface RemoteNodeResult {
  nodeId: number;
  nodeName: string;
  files: { file: string; status: StackRowStatus }[];
}

interface RemoteSearchFailure {
  nodeId: number;
  nodeName: string;
  reason: string;
}

export interface StackListProps {
  files: string[];
  isLoading: boolean;
  selectedFile: string | null;
  searchQuery: string;
  stackLabelMap: Record<string, Label[]>;
  stackStatuses: Record<string, StackRowStatus | undefined>;
  stackCounts: Record<string, { running: number; total: number } | undefined>;
  stackUpdates: Record<string, boolean>;
  gitSourcePendingMap: Record<string, boolean>;
  pinnedFiles: string[];
  isCollapsed: (groupKey: string) => boolean;
  toggleCollapse: (groupKey: string) => void;
  isBusy: (file: string) => boolean;
  getDisplayName: (file: string) => string;
  onSelectFile: (file: string) => void;
  buildMenuCtx: (file: string) => StackMenuCtx;
  remoteResults: RemoteNodeResult[];
  remoteLoading: boolean;
  remoteFailedNodes: RemoteSearchFailure[];
  onSelectRemoteFile: (nodeId: number, file: string) => void;
  // Active filter chip. The first-run empty state only renders when no chip is
  // applied ('all'), so a filter that matches nothing is not mistaken for "no
  // stacks yet".
  filterChip: FilterChip;
  // Open the create dialog on a starting mode. Present only when the user can
  // create stacks; drives the zero-stacks empty state.
  onOpenCreate?: (mode: 'import' | 'empty') => void;
}

interface BuiltGroup {
  kind: 'pinned' | 'labeled' | 'unlabeled';
  id: string;
  label: string;
  count: number;
  files: string[];
  variant?: 'default' | 'pinned';
}

function buildGroups(
  files: string[],
  pinnedFiles: string[],
  stackLabelMap: Record<string, Label[]>,
): BuiltGroup[] {
  const result: BuiltGroup[] = [];

  const pinnedSet = new Set(pinnedFiles.filter(f => files.includes(f)));
  if (pinnedSet.size > 0) {
    result.push({
      kind: 'pinned', id: 'pinned', label: 'PINNED',
      count: pinnedSet.size, files: Array.from(pinnedSet), variant: 'pinned',
    });
  }

  const labelBuckets = new Map<number, { label: Label; files: string[] }>();
  const unlabeled: string[] = [];
  for (const file of files) {
    const assigned = stackLabelMap[file] ?? [];
    if (assigned.length === 0) {
      unlabeled.push(file);
    } else {
      for (const l of assigned) {
        const bucket = labelBuckets.get(l.id) ?? { label: l, files: [] };
        bucket.files.push(file);
        labelBuckets.set(l.id, bucket);
      }
    }
  }

  const sortedLabels = [...labelBuckets.values()]
    .sort((a, b) => b.files.length - a.files.length || a.label.name.localeCompare(b.label.name));
  for (const { label, files: bucketFiles } of sortedLabels) {
    result.push({
      kind: 'labeled', id: `label:${label.id}`,
      label: label.name.toUpperCase(), count: bucketFiles.length, files: bucketFiles,
    });
  }

  if (unlabeled.length > 0) {
    result.push({ kind: 'unlabeled', id: 'unlabeled', label: 'UNLABELED', count: unlabeled.length, files: unlabeled });
  }

  return result;
}

interface StackListBulkProps {
  bulkMode: boolean;
  selectedFiles: Set<string>;
  onToggleSelect: (file: string) => void;
}

export function StackList(props: StackListProps & StackListBulkProps) {
  const {
    files, isLoading, selectedFile, searchQuery, stackLabelMap, stackStatuses, stackCounts,
    stackUpdates, gitSourcePendingMap, pinnedFiles, isCollapsed, toggleCollapse,
    isBusy, getDisplayName, onSelectFile, buildMenuCtx,
    bulkMode, selectedFiles, onToggleSelect,
    remoteResults, remoteLoading, remoteFailedNodes, onSelectRemoteFile,
    filterChip, onOpenCreate,
  } = props;

  const [failedNodesExpanded, setFailedNodesExpanded] = useState(false);

  const groups = useMemo(
    () => buildGroups(files, pinnedFiles, stackLabelMap),
    [files, pinnedFiles, stackLabelMap],
  );

  useStackKeyboardShortcuts(selectedFile, buildMenuCtx);

  if (isLoading) {
    return (
      <div className="space-y-2 px-2 mt-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  // First-run prompt only when the node has no stacks at all: no search text and
  // no active filter chip, so a filter that happens to match nothing does not
  // masquerade as an empty fleet.
  if (files.length === 0 && !searchQuery.trim() && filterChip === 'all') {
    return <EmptyStackState onOpenCreate={onOpenCreate} />;
  }

  return (
    <CommandList className="max-h-none overflow-visible">
      {groups.map(g => (
        <StackGroup
          key={g.id}
          id={g.id}
          label={g.label}
          count={g.count}
          collapsed={isCollapsed(g.id)}
          onToggle={() => toggleCollapse(g.id)}
          variant={g.variant}
        >
          {g.files.map(file => {
            const ctx = buildMenuCtx(file);
            return (
              <StackContextMenu key={`${g.id}:${file}`} file={file} ctx={ctx}>
                <CommandItem
                  value={file}
                  onSelect={() => onSelectFile(file)}
                  className="p-0 data-[selected=true]:bg-transparent"
                >
                  <StackRow
                    file={file}
                    displayName={getDisplayName(file)}
                    status={stackStatuses[file] ?? 'unknown'}
                    running={stackCounts[file]?.running}
                    total={stackCounts[file]?.total}
                    isBusy={isBusy(file)}
                    isActive={selectedFile === file}
                    labels={stackLabelMap[file] ?? []}
                    hasUpdate={!!stackUpdates[file]}
                    hasGitPending={!!gitSourcePendingMap[file]}
                    onSelect={onSelectFile}
                    kebabSlot={<StackKebabMenu file={file} ctx={ctx} />}
                    bulkMode={bulkMode}
                    isSelected={selectedFiles.has(file)}
                    onToggleSelect={onToggleSelect}
                  />
                </CommandItem>
              </StackContextMenu>
            );
          })}
        </StackGroup>
      ))}

      {searchQuery.trim() && (remoteLoading || remoteResults.length > 0 || remoteFailedNodes.length > 0) && (
        <div className="mt-3 pt-3 border-t border-glass-border">
          <h3 className="text-[10px] font-medium tracking-[0.08em] uppercase text-stat-subtitle px-4 pb-2 flex items-center gap-2">
            Other nodes
            {remoteLoading && <Loader2 className="w-3 h-3 animate-spin text-stat-icon" strokeWidth={1.5} />}
          </h3>
          {remoteFailedNodes.length > 0 && (
            <button
              type="button"
              onClick={() => setFailedNodesExpanded(prev => !prev)}
              className="w-full mx-4 mb-2 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.06em] text-warning hover:text-warning/80 cursor-pointer"
              style={{ width: 'calc(100% - 2rem)' }}
              aria-expanded={failedNodesExpanded}
              title={remoteFailedNodes.map(f => `${f.nodeName}: ${f.reason}`).join('\n')}
            >
              <AlertCircle className="w-3 h-3 shrink-0" strokeWidth={1.5} />
              <span className="shrink-0">
                {remoteFailedNodes.length} {remoteFailedNodes.length === 1 ? 'node' : 'nodes'} unreachable
              </span>
              {failedNodesExpanded
                ? <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={1.5} />
                : <ChevronRight className="w-3 h-3 shrink-0" strokeWidth={1.5} />}
            </button>
          )}
          {failedNodesExpanded && remoteFailedNodes.length > 0 && (
            <div className="px-4 pb-2 space-y-0.5">
              {remoteFailedNodes.map(f => (
                <div key={f.nodeId} className="text-[10px] font-mono text-stat-subtitle truncate">
                  <span className="text-warning">·</span> {f.nodeName}: {f.reason}
                </div>
              ))}
            </div>
          )}
          {remoteResults.map(({ nodeId, nodeName, files: remoteFiles }) => (
            <div key={nodeId} className="mb-2">
              <div className="px-4 pb-1 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.06em] text-stat-subtitle">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                <span className="truncate">{nodeName}</span>
              </div>
              {remoteFiles.map(({ file, status }) => (
                <button
                  key={`${nodeId}:${file}`}
                  type="button"
                  onClick={() => onSelectRemoteFile(nodeId, file)}
                  className="w-full text-left justify-start rounded-lg mb-1 cursor-pointer hover:bg-glass-highlight px-2 py-1.5 flex items-center gap-2"
                >
                  <span className={`font-mono text-[10px] shrink-0 w-5 ${statusColor(status, false)}`}>
                    {statusText(status)}
                  </span>
                  <span className="flex-1 truncate font-mono text-xs">{file}</span>
                  <ArrowUpRight className="w-3 h-3 text-stat-icon shrink-0" strokeWidth={1.5} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </CommandList>
  );
}
