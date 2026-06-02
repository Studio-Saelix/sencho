import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNodes } from '@/context/NodeContext';
import type { Node } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { AlertTriangle, Plus, Trash2, Wifi, WifiOff, Star, Pencil, Monitor, Globe, Copy, KeyRound, Check, Calendar, RefreshCw, Terminal } from 'lucide-react';
import { formatTimeUntil, formatTimeAgo } from '@/lib/relativeTime';
import { SettingsPrimaryButton } from './settings/SettingsActions';
import { useMastheadStats } from './settings/MastheadStatsContext';
import { NodeLabelPicker } from './blueprints/NodeLabelPicker';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { useNodeActions, type NodeTestInfo } from './nodes/useNodeActions';
import { useFleetSyncStatus } from '@/hooks/useFleetSyncStatus';
import { resetFleetSyncAnchor, STICKY_CONTROL_IDENTITY_MISMATCH } from '@/lib/fleetSyncApi';

interface NodeSchedulingSummary {
  active_tasks: number;
  auto_update_enabled: boolean;
  next_run_at: number | null;
  stacks_with_updates: number;
}

export const SENCHO_NAVIGATE_EVENT = 'sencho-navigate';
export interface SenchoNavigateDetail {
  view: 'scheduled-ops' | 'auto-updates' | 'security-history';
  nodeId?: number;
}

export function NodeManager() {
  const { isPaid } = useLicense();
  const { isAdmin, can } = useAuth();
  const canEditLabels = isPaid && isAdmin;
  // Mirror the backend node:manage guard. This top-level flag checks the global
  // role only (admin or global node-admin); the per-row Test/Edit/Delete buttons
  // below additionally honor scoped per-node grants via can('node:manage', 'node', id).
  // Admins resolve immediately via isAdmin; node-admins once /permissions/me lands.
  // Generate-token and reset-anchor below stay admin-only to match their stricter
  // backend guards (requireAdmin, and requireAdmin + requirePaid).
  const canManageNodes = isAdmin || can('node:manage');
  const { nodes, refreshNodeMeta } = useNodes();
  useMastheadStats([
    { label: 'NODES', value: `${nodes.length}` },
    {
      label: 'REMOTE',
      value: `${nodes.filter(n => n.type === 'remote').length}`,
      tone: 'subtitle',
    },
  ]);

  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ nodeId: number; info: NodeTestInfo } | null>(null);

  // Node token generation state
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  // Per-node scheduling summary
  const [nodeSummary, setNodeSummary] = useState<Record<number, NodeSchedulingSummary>>({});

  const { openCreate, openEdit, openDelete, NodeActionModals } = useNodeActions({
    onTestResult: (result) => setTestResult(result),
  });

  const { statuses: syncStatuses, refresh: refreshSyncStatuses } = useFleetSyncStatus();
  const [resettingAnchor, setResettingAnchor] = useState<number | null>(null);

  // Per-node aggregate of CONTROL_IDENTITY_MISMATCH sticky errors. All resources
  // for one peer share the same root cause (the peer's cached fingerprint), so
  // collapse to one entry per node id and surface a single banner.
  const anchorMismatches = useMemo(() => {
    const byNode = new Map<number, { expected: string | null; got: string | null; resources: string[] }>();
    for (const row of syncStatuses) {
      if (row.sticky_error_code !== STICKY_CONTROL_IDENTITY_MISMATCH) continue;
      const existing = byNode.get(row.node_id);
      if (existing) {
        existing.resources.push(row.resource);
        if (!existing.expected && row.sticky_error_expected) existing.expected = row.sticky_error_expected;
        if (!existing.got && row.sticky_error_got) existing.got = row.sticky_error_got;
      } else {
        byNode.set(row.node_id, {
          expected: row.sticky_error_expected,
          got: row.sticky_error_got,
          resources: [row.resource],
        });
      }
    }
    return Array.from(byNode.entries()).map(([nodeId, agg]) => {
      const node = nodes.find((n) => n.id === nodeId);
      return { nodeId, node, ...agg };
    }).filter((entry) => entry.node !== undefined);
  }, [syncStatuses, nodes]);

  const handleResetAnchor = async (nodeId: number) => {
    setResettingAnchor(nodeId);
    try {
      await resetFleetSyncAnchor(nodeId);
      toast.success('Anchor reset. Security policy sync will resume on the next push.');
      refreshSyncStatuses();
    } catch (error) {
      toast.error((error as Error).message || 'Failed to reset anchor on peer');
    } finally {
      setResettingAnchor(null);
    }
  };

  const fetchSchedulingSummary = useCallback(async () => {
    try {
      const res = await apiFetch('/nodes/scheduling-summary', { localOnly: true });
      if (res.ok) setNodeSummary(await res.json());
    } catch {
      // Non-fatal — summary is supplementary info
    }
  }, []);

  const nodeIdKey = useMemo(() => nodes.map(n => n.id).join(','), [nodes]);

  useEffect(() => {
    fetchSchedulingSummary();
  }, [nodeIdKey, fetchSchedulingSummary]);

  const testConnection = async (node: Node) => {
    setTesting(node.id);
    setTestResult(null);
    try {
      const res = await apiFetch(`/nodes/${node.id}/test`, { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        toast.success(`Connected to "${node.name}" successfully`);
        setTestResult({ nodeId: node.id, info: result.info });
        // The test dropped the server-side metadata cache; force a client refresh
        // so the version pill and capability gates reflect the node's current state
        // now, instead of waiting out the dashboard's metadata TTL.
        void refreshNodeMeta(node.id, true);
      } else {
        toast.error(`Failed to connect: ${result.error}`);
      }
    } catch (error) {
      toast.error((error as Error).message || 'Connection test failed');
    } finally {
      setTesting(null);
    }
  };

  const generateNodeToken = async () => {
    setGeneratingToken(true);
    setGeneratedToken(null);
    try {
      const res = await apiFetch('/auth/generate-node-token', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate token');
      const { token } = await res.json();
      setGeneratedToken(token);
      toast.success('Node token generated');
    } catch (error) {
      toast.error((error as Error).message || 'Failed to generate token');
    } finally {
      setGeneratingToken(false);
    }
  };

  const copyToken = async () => {
    if (!generatedToken) return;
    try {
      await copyToClipboard(generatedToken);
      setTokenCopied(true);
      toast.success('Token copied to clipboard');
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      toast.error('Could not copy automatically. Please select and copy the token manually.');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'online':
        return <Badge variant="default" className="bg-success text-success-foreground gap-1"><Wifi className="w-3 h-3" /> Online</Badge>;
      case 'offline':
        return <Badge variant="destructive" className="gap-1"><WifiOff className="w-3 h-3" /> Offline</Badge>;
      default:
        return <Badge variant="secondary" className="gap-1">Unknown</Badge>;
    }
  };

  const getNodeIcon = (type: string) => {
    return type === 'local'
      ? <Monitor className="w-4 h-4 text-muted-foreground" />
      : <Globe className="w-4 h-4 text-muted-foreground" />;
  };

  return (
    <div className="space-y-6">
      {/* Actions (node management is admin / node-admin only, mirroring the
          node:manage backend guard). The read-only table below stays visible to
          every role with node:read. */}
      {canManageNodes && (
        <>
          <div className="flex justify-end">
            <SettingsPrimaryButton
              size="sm"
              className="gap-1 shrink-0"
              onClick={openCreate}
            >
              <Plus className="w-4 h-4" />
              Add node
            </SettingsPrimaryButton>
          </div>

          <Separator />
        </>
      )}

      {/* Generate a node token so THIS instance can serve as a remote target.
          Admin-only, matching the requireAdmin guard on /auth/generate-node-token. */}
      {isAdmin && (
      <div className="rounded-md border p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-brand" />
              Generate Node Token
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Create a long-lived token that allows another Sencho instance to use <strong>this</strong> instance as a remote node. Copy it and paste it into the other Sencho instance's "Add Node" form.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={generateNodeToken}
            disabled={generatingToken}
            className="shrink-0"
          >
            {generatingToken ? 'Generating...' : 'Generate Token'}
          </Button>
        </div>

        {generatedToken && (
          <div className="flex items-center gap-2 rounded-md bg-muted p-2">
            <code className="flex-1 text-xs font-mono truncate text-muted-foreground">{generatedToken}</code>
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={copyToken}>
              {tokenCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
        )}
      </div>
      )}

      {/* Sync issues: surfaces FleetSync sticky errors (currently CONTROL_IDENTITY_MISMATCH). */}
      {anchorMismatches.length > 0 && (
        <div className="space-y-3">
          {anchorMismatches.map(({ nodeId, node, expected, got, resources }) => (
            <div
              key={nodeId}
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-3 shadow-card-bevel"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={1.75} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="font-medium">
                  Node "{node?.name ?? `id ${nodeId}`}" is anchored to another central
                </div>
                <div className="text-xs leading-relaxed text-destructive/90">
                  Security policy sync is paused for {resources.join(', ')}.
                  {expected && got && (
                    <> This peer is anchored to <span className="font-mono">{expected}</span>; this central is <span className="font-mono">{got}</span>.</>
                  )}
                  {' '}Reset the anchor on the peer to resume sync, or remove the node from this fleet.
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {isAdmin && isPaid && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleResetAnchor(nodeId)}
                      disabled={resettingAnchor === nodeId}
                    >
                      {resettingAnchor === nodeId ? 'Resetting...' : 'Reset anchor on peer'}
                    </Button>
                  )}
                  {node && !node.is_default && (isAdmin || can('node:manage', 'node', String(nodeId))) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openDelete(node)}
                    >
                      Remove node
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Nodes Table */}
      <div className="rounded-md border overflow-x-auto w-full">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Labels</TableHead>
              <TableHead>Schedules</TableHead>
              <TableHead>Updates</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => {
              const canManageThis = isAdmin || can('node:manage', 'node', String(node.id));
              return (
              <TableRow key={node.id}>
                <TableCell>
                  {node.is_default && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                        </TooltipTrigger>
                        <TooltipContent>Default Node</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {getNodeIcon(node.type)}
                    {node.name}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{node.type === 'local' ? 'Local' : 'Remote'}</Badge>
                </TableCell>
                <TableCell>
                  {node.type === 'local' ? (
                    <span className="text-muted-foreground text-sm">-</span>
                  ) : node.mode === 'pilot_agent' ? (
                    <Badge variant="outline" className="gap-1 text-xs">
                      <Terminal className="w-3 h-3" strokeWidth={1.5} />
                      Pilot Agent
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-xs">
                      <Globe className="w-3 h-3" strokeWidth={1.5} />
                      Proxy
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm font-mono">
                  {node.type === 'local'
                    ? 'docker.sock'
                    : node.mode === 'pilot_agent'
                      ? (node.pilot_last_seen
                        ? `tunnel (seen ${formatTimeAgo(node.pilot_last_seen)})`
                        : 'tunnel (waiting)')
                      : (node.api_url || '-')}
                </TableCell>
                <TableCell>{getStatusBadge(node.status)}</TableCell>
                <TableCell>
                  {isPaid ? (
                    <NodeLabelPicker nodeId={node.id} canEdit={canEditLabels} />
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {(() => {
                    const summary = nodeSummary[node.id];
                    if (!summary || summary.active_tasks === 0) {
                      return <span className="text-muted-foreground text-sm">—</span>;
                    }
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm tabular-nums tracking-tight">
                          {summary.active_tasks}
                        </span>
                        {summary.next_run_at && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <span className="text-xs text-muted-foreground">
                                  next {formatTimeUntil(summary.next_run_at)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {new Date(summary.next_run_at).toLocaleString()}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    );
                  })()}
                </TableCell>
                <TableCell>
                  {(() => {
                    const summary = nodeSummary[node.id];
                    return (
                      <div className="flex items-center gap-1.5">
                        {summary?.auto_update_enabled ? (
                          <Badge variant="outline" className="text-stat-subtitle border-card-border gap-1 text-xs">
                            <RefreshCw className="w-3 h-3" strokeWidth={1.5} />
                            Auto
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">Off</span>
                        )}
                        {(summary?.stacks_with_updates ?? 0) > 0 && (
                          <span className="flex items-center gap-1">
                            <span className="relative inline-flex w-2 h-2 shrink-0">
                              <span className="absolute inset-0 rounded-full bg-update opacity-75 animate-ping" />
                              <span className="relative w-2 h-2 rounded-full bg-update" />
                            </span>
                            <span className="font-mono text-xs tabular-nums tracking-tight text-update">
                              {summary!.stacks_with_updates}
                            </span>
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => {
                              window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
                                detail: { view: 'scheduled-ops', nodeId: node.id },
                              }));
                            }}
                          >
                            <Calendar className="w-4 h-4" strokeWidth={1.5} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>View Schedules</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    {canManageThis && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => testConnection(node)}
                              disabled={testing === node.id}
                              aria-label="Test connection"
                            >
                              <Wifi className={`w-4 h-4 ${testing === node.id ? 'animate-pulse' : ''}`} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Test Connection</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}

                    {canManageThis && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(node)}
                              aria-label="Edit node"
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit Node</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}

                    {!node.is_default && canManageThis && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => openDelete(node)}
                              aria-label="Delete node"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete Node</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Connection Test Result */}
      {testResult && (
        <div className="rounded-md border p-4 bg-muted/30 space-y-2">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Wifi className="w-4 h-4 text-success" />
            Connection Details - {nodes.find(n => n.id === testResult.nodeId)?.name}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <div><span className="text-muted-foreground">Instance:</span> {testResult.info.serverVersion}</div>
            {testResult.info.senchoVersion && (
              <div><span className="text-muted-foreground">Sencho:</span> <span className="font-mono tabular-nums">v{testResult.info.senchoVersion}</span></div>
            )}
            <div><span className="text-muted-foreground">OS:</span> {testResult.info.os}</div>
            <div><span className="text-muted-foreground">Arch:</span> {testResult.info.architecture}</div>
            <div><span className="text-muted-foreground">Containers:</span> {testResult.info.containers}</div>
            <div><span className="text-muted-foreground">Images:</span> {testResult.info.images}</div>
            <div><span className="text-muted-foreground">CPUs:</span> {testResult.info.cpus}</div>
          </div>
        </div>
      )}

      {NodeActionModals}
    </div>
  );
}
