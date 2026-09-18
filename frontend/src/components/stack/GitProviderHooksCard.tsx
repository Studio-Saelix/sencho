import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  Copy,
  History,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { TogglePill } from '@/components/ui/toggle-pill';
import { SettingsCallout } from '@/components/settings/SettingsCallout';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

type GitProviderKind = 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'bitbucket_cloud';
type GitProviderEventScope = 'configured_ref' | 'configured_ref_and_prs';

type GitProviderDeliveryState =
  | 'received'
  | 'authenticated'
  | 'rejected_auth'
  | 'malformed'
  | 'unsupported'
  | 'duplicate'
  | 'ignored_by_policy'
  | 'queued'
  | 'rate_limited'
  | 'processing_failed';

interface ProviderHookDelivery {
  delivery_id: string;
  state: GitProviderDeliveryState;
  event_type: string | null;
  event_action: string | null;
  ref: string | null;
  outcome_class: string | null;
  received_at: number;
  updated_at: number;
}

interface ProviderHookEndpoint {
  id: string;
  provider: GitProviderKind;
  enabled: boolean;
  event_scope: GitProviderEventScope;
  created_at: number;
  updated_at: number;
  deliveries: ProviderHookDelivery[];
}

interface ProviderHooksResponse {
  endpoints: ProviderHookEndpoint[];
  direct_source: boolean;
}

interface GitProviderHooksCardProps {
  stackName: string;
  canEdit: boolean;
  isDarkMode: boolean;
}

const PROVIDER_OPTIONS: { value: GitProviderKind; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'gitea', label: 'Gitea' },
  { value: 'forgejo', label: 'Forgejo' },
  { value: 'bitbucket_cloud', label: 'Bitbucket Cloud' },
];

const EVENT_SCOPE_OPTIONS: { value: GitProviderEventScope; label: string }[] = [
  { value: 'configured_ref', label: 'Configured ref' },
  { value: 'configured_ref_and_prs', label: 'Ref + PRs' },
];

const PROVIDER_LABEL: Record<GitProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  forgejo: 'Forgejo',
  bitbucket_cloud: 'Bitbucket Cloud',
};

const PROVIDER_SETUP_NOTES: Record<GitProviderKind, string> = {
  github:
    'In the repository webhook settings, set content type to JSON, paste the Sencho secret, and enable push events. Add pull request events when scope includes PRs. GitHub signs payloads with X-Hub-Signature-256.',
  gitlab:
    'Add a project webhook with the Sencho URL and secret token. Enable push events and merge request events when scope includes PRs. GitLab accepts the secret via X-Gitlab-Token or X-Gitlab-Hook-Signature-256.',
  gitea:
    'Create a repository webhook with the Sencho URL and secret. Enable push events and, when scope includes PRs, pull request events. Gitea signs payloads with X-Gitea-Signature.',
  forgejo:
    'Create a repository webhook with the Sencho URL and secret. Enable push events and, when scope includes PRs, pull request events. Forgejo signs with X-Forgejo-Signature or X-Gitea-Signature.',
  bitbucket_cloud:
    'Add a repository webhook with the Sencho URL and secret. Enable repository push events and pull request events when scope includes PRs. Bitbucket signs payloads with X-Hub-Signature.',
};

const POSITIVE_DELIVERY_STATES = new Set<GitProviderDeliveryState>([
  'received',
  'authenticated',
  'queued',
]);

const NEGATIVE_DELIVERY_STATES = new Set<GitProviderDeliveryState>([
  'rejected_auth',
  'malformed',
  'unsupported',
  'processing_failed',
  'rate_limited',
]);

function deliveryStateTone(state: GitProviderDeliveryState): 'success' | 'destructive' | 'subtitle' {
  if (POSITIVE_DELIVERY_STATES.has(state)) return 'success';
  if (NEGATIVE_DELIVERY_STATES.has(state)) return 'destructive';
  return 'subtitle';
}

function formatDeliveryState(state: GitProviderDeliveryState): string {
  return state.replace(/_/g, ' ');
}

export function GitProviderHooksCard({ stackName, canEdit, isDarkMode: _isDarkMode }: GitProviderHooksCardProps) {
  const { activeNode } = useNodes();
  const [loading, setLoading] = useState(true);
  const [endpoints, setEndpoints] = useState<ProviderHookEndpoint[]>([]);
  const [directSource, setDirectSource] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<GitProviderKind>('github');
  const [newEventScope, setNewEventScope] = useState<GitProviderEventScope>('configured_ref');
  const [revealedSecret, setRevealedSecret] = useState<{ endpointId: string; secret: string } | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedDeliveries, setExpandedDeliveries] = useState<string | null>(null);

  const controlsDisabled = !canEdit || !directSource;
  const nodeId = activeNode?.id;

  const availableProviders = useMemo(
    () => PROVIDER_OPTIONS.filter((opt) => !endpoints.some((ep) => ep.provider === opt.value)),
    [endpoints],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/provider-hooks`);
      if (res.ok) {
        const data: ProviderHooksResponse = await res.json();
        setEndpoints(data.endpoints ?? []);
        setDirectSource(data.direct_source ?? true);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to load provider hooks.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [stackName]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (availableProviders.length > 0 && !availableProviders.some((opt) => opt.value === selectedProvider)) {
      setSelectedProvider(availableProviders[0].value);
    }
  }, [availableProviders, selectedProvider]);

  const handleCopy = async (text: string, label: string) => {
    try {
      await copyToClipboard(text);
      toast.success(`${label} copied to clipboard.`);
    } catch {
      toast.error('Failed to copy to clipboard.');
    }
  };

  const handleCreate = async () => {
    if (!selectedProvider) {
      toast.error('Select a provider.');
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/provider-hooks`, {
        method: 'POST',
        body: JSON.stringify({ provider: selectedProvider, event_scope: newEventScope }),
      });
      if (res.ok) {
        const data = await res.json() as { id: string; secret: string };
        setRevealedSecret({ endpointId: data.id, secret: data.secret });
        setShowCreate(false);
        setNewEventScope('configured_ref');
        toast.success('Provider hook created.');
        await load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to create provider hook.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setCreating(false);
    }
  };

  const handleRotate = async (endpointId: string) => {
    setRotatingId(endpointId);
    try {
      const res = await apiFetch(
        `/stacks/${encodeURIComponent(stackName)}/git-source/provider-hooks/${encodeURIComponent(endpointId)}/rotate`,
        { method: 'POST' },
      );
      if (res.ok) {
        const data = await res.json() as { secret: string };
        setRevealedSecret({ endpointId, secret: data.secret });
        toast.success('Secret rotated.');
        await load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to rotate secret.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setRotatingId(null);
    }
  };

  const handlePatch = async (
    endpointId: string,
    patch: { enabled?: boolean; event_scope?: GitProviderEventScope },
  ) => {
    try {
      const res = await apiFetch(
        `/stacks/${encodeURIComponent(stackName)}/git-source/provider-hooks/${encodeURIComponent(endpointId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
      if (res.ok) {
        await load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to update provider hook.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    }
  };

  const handleDelete = async (endpointId: string) => {
    setDeletingId(endpointId);
    try {
      const res = await apiFetch(
        `/stacks/${encodeURIComponent(stackName)}/git-source/provider-hooks/${encodeURIComponent(endpointId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        toast.success('Provider hook deleted.');
        if (revealedSecret?.endpointId === endpointId) setRevealedSecret(null);
        await load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to delete provider hook.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setDeletingId(null);
    }
  };

  const hookUrl = (endpointId: string): string | null => {
    if (!nodeId) return null;
    return `${window.location.origin}/api/gitops/hooks/${nodeId}/${endpointId}`;
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!directSource && (
        <SettingsCallout
          tone="warn"
          title="Direct Git source required"
          subtitle="Native provider hooks apply to direct Git sources only. Blueprint-bound sources use the Blueprint webhook flow instead."
        />
      )}

      {revealedSecret && (
        <SettingsCallout
          tone="success"
          icon={<CheckCircle className="h-4 w-4" />}
          title="Copy your webhook secret now"
          subtitle={
            <div className="flex flex-col gap-2 mt-1">
              <span>This secret will not be shown again. Paste it into your Git host webhook settings.</span>
              <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
                <code className="flex-1 text-xs font-mono bg-muted px-3 py-2 rounded-md break-all">
                  {revealedSecret.secret}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="max-md:w-full"
                  onClick={() => handleCopy(revealedSecret.secret, 'Secret')}
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
          }
          action={
            <Button variant="outline" size="sm" onClick={() => setRevealedSecret(null)}>
              Dismiss
            </Button>
          }
        />
      )}

      {canEdit && directSource && availableProviders.length > 0 && (
        <div className="flex justify-end max-md:justify-stretch">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 max-md:w-full"
            onClick={() => setShowCreate((open) => !open)}
            disabled={controlsDisabled}
          >
            <Plus className="h-3.5 w-3.5" />
            Add provider hook
          </Button>
        </div>
      )}

      {showCreate && canEdit && directSource && (
        <div className="rounded-lg border border-card-border bg-card p-3 space-y-3">
          <div className="space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Provider</div>
            <Select value={selectedProvider} onValueChange={(v) => setSelectedProvider(v as GitProviderKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableProviders.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Event scope</div>
            <SegmentedControl
              value={newEventScope}
              options={EVENT_SCOPE_OPTIONS}
              onChange={setNewEventScope}
              ariaLabel="New provider hook event scope"
              fullWidth
              disabled={controlsDisabled}
            />
          </div>
          <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
            <Button variant="outline" size="sm" className="max-md:w-full" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="gap-1.5 max-md:w-full"
              onClick={() => { void handleCreate(); }}
              disabled={creating || controlsDisabled}
            >
              {creating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
              {creating ? 'Creating' : 'Create'}
            </Button>
          </div>
        </div>
      )}

      {endpoints.length === 0 && !showCreate && (
        <SettingsCallout
          icon={<Webhook className="h-4 w-4" />}
          title="No provider hooks"
          subtitle={
            directSource
              ? (canEdit
                ? 'Add a hook to receive push and pull request events from your Git host.'
                : 'An operator with stack edit permission can configure native provider hooks here.')
              : 'Provider hooks are unavailable while this source is Blueprint-bound.'
          }
        />
      )}

      {endpoints.map((endpoint) => {
        const url = hookUrl(endpoint.id);
        const isExpanded = expandedDeliveries === endpoint.id;
        const setupNote = PROVIDER_SETUP_NOTES[endpoint.provider];
        return (
          <div
            key={endpoint.id}
            className={cn(
              'rounded-lg border border-card-border bg-card overflow-hidden',
              !endpoint.enabled && 'opacity-80',
            )}
          >
            <div className="p-3 space-y-3">
              <div className="flex items-start justify-between gap-3 max-md:flex-col">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <Webhook className="w-4 h-4 text-stat-subtitle shrink-0" />
                  <span className="font-medium text-sm text-stat-value">
                    {PROVIDER_LABEL[endpoint.provider]}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle border border-card-border rounded px-1.5 py-0.5">
                    {endpoint.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 max-md:w-full max-md:justify-between">
                  {canEdit ? (
                    <>
                      <TogglePill
                        checked={endpoint.enabled}
                        onChange={(enabled) => { void handlePatch(endpoint.id, { enabled }); }}
                        disabled={controlsDisabled}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => { void handleRotate(endpoint.id); }}
                        disabled={controlsDisabled || rotatingId === endpoint.id}
                      >
                        {rotatingId === endpoint.id ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          'Rotate'
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => { void handleDelete(endpoint.id); }}
                        disabled={controlsDisabled || deletingId === endpoint.id}
                      >
                        <Trash2 className="w-4 h-4 text-stat-subtitle" />
                      </Button>
                    </>
                  ) : (
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle border border-card-border rounded px-1.5 py-0.5">
                      {endpoint.enabled ? 'On' : 'Off'}
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Event scope</div>
                {canEdit ? (
                  <SegmentedControl
                    value={endpoint.event_scope}
                    options={EVENT_SCOPE_OPTIONS}
                    onChange={(scope) => { void handlePatch(endpoint.id, { event_scope: scope }); }}
                    ariaLabel={`${PROVIDER_LABEL[endpoint.provider]} event scope`}
                    fullWidth
                    disabled={controlsDisabled}
                  />
                ) : (
                  <div className="text-xs text-stat-subtitle">
                    {endpoint.event_scope === 'configured_ref' ? 'Configured ref' : 'Ref + PRs'}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Webhook URL</div>
                {url ? (
                  <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
                    <code className="flex-1 text-[11px] font-mono bg-muted px-2.5 py-1.5 rounded-md break-all">
                      {url}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 max-md:w-full"
                      onClick={() => handleCopy(url, 'URL')}
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-stat-subtitle">Select a node to show the hub webhook URL.</p>
                )}
              </div>

              <p className="text-xs text-stat-subtitle leading-relaxed">{setupNote}</p>

              <button
                type="button"
                onClick={() => setExpandedDeliveries(isExpanded ? null : endpoint.id)}
                className="flex items-center gap-1.5 text-xs text-stat-subtitle hover:text-stat-value transition-colors"
              >
                <History className="w-3 h-3" />
                Recent deliveries
              </button>
            </div>

            {isExpanded && (
              <div className="border-t border-card-border bg-muted/20 px-3 py-3">
                {endpoint.deliveries.length === 0 ? (
                  <p className="text-xs text-stat-subtitle">No deliveries yet.</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {endpoint.deliveries.map((delivery) => {
                      const tone = deliveryStateTone(delivery.state);
                      return (
                        <div
                          key={`${delivery.delivery_id}-${delivery.received_at}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs max-md:flex-col max-md:items-start"
                        >
                          {tone === 'success' ? (
                            <CheckCircle className="w-3 h-3 text-success shrink-0" />
                          ) : tone === 'destructive' ? (
                            <XCircle className="w-3 h-3 text-destructive shrink-0" />
                          ) : (
                            <History className="w-3 h-3 text-stat-subtitle shrink-0" />
                          )}
                          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-value">
                            {formatDeliveryState(delivery.state)}
                          </span>
                          {delivery.outcome_class && (
                            <span className="font-mono text-[10px] text-stat-subtitle">
                              {delivery.outcome_class}
                            </span>
                          )}
                          {delivery.event_type && (
                            <span className="text-stat-subtitle">{delivery.event_type}</span>
                          )}
                          {delivery.ref && (
                            <span className="font-mono text-stat-subtitle truncate max-w-full">{delivery.ref}</span>
                          )}
                          <span className="text-stat-subtitle ml-auto max-md:ml-0">
                            {new Date(delivery.received_at).toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
