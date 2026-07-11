import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { Loader2 } from 'lucide-react';

interface RegistryRow {
  id: number;
  name: string;
  url: string;
  type: 'dockerhub' | 'ghcr' | 'ecr' | 'custom';
  has_secret: boolean;
}

interface TagListResponse {
  tags: string[];
  nextCursor: string | null;
  registryId: number;
  registryName: string;
  repository: string;
}

export interface RegistryTagsPanelProps {
  repoTags: string[];
  repoDigests: string[];
  nodeId: string | number;
  isAdmin: boolean;
}

function parseRepoFromTag(tag: string): { host: string; repo: string; tagName: string } | null {
  if (!tag || tag === '<none>:<none>') return null;
  const at = tag.indexOf('@');
  const ref = at === -1 ? tag : tag.slice(0, at);
  let rest = ref;
  let host = 'docker.io';
  const slash = ref.indexOf('/');
  if (slash !== -1) {
    const first = ref.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      host = first.toLowerCase();
      rest = ref.slice(slash + 1);
    }
  }
  let tagName = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > 0) {
    tagName = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (host === 'docker.io' && !rest.includes('/')) {
    rest = `library/${rest}`;
  }
  return { host, repo: rest, tagName };
}

function registryMatchesHost(reg: RegistryRow, host: string): boolean {
  const h = host.toLowerCase();
  if (reg.type === 'dockerhub') {
    return h === 'docker.io' || h === 'index.docker.io' || h === 'registry-1.docker.io' || h === '';
  }
  try {
    const withProto = reg.url.startsWith('http') ? reg.url : `https://${reg.url}`;
    return new URL(withProto).host.toLowerCase() === h;
  } catch {
    return reg.url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase() === h;
  }
}

export function RegistryTagsPanel({
  repoTags,
  isAdmin,
}: RegistryTagsPanelProps) {
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: { host: string; repo: string; tagName: string; label: string }[] = [];
    for (const t of repoTags) {
      const parsed = parseRepoFromTag(t);
      if (!parsed) continue;
      const key = `${parsed.host}/${parsed.repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...parsed, label: t });
    }
    return out;
  }, [repoTags]);

  const [registries, setRegistries] = useState<RegistryRow[]>([]);
  const [loadingRegs, setLoadingRegs] = useState(false);
  const [regsError, setRegsError] = useState<string | null>(null);
  const [selectedRepoIdx, setSelectedRepoIdx] = useState(0);
  const [selectedRegistryId, setSelectedRegistryId] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingTags, setLoadingTags] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = candidates[selectedRepoIdx] ?? null;

  const matchingRegistries = useMemo(() => {
    if (!selected) return [];
    return registries.filter((r) => registryMatchesHost(r, selected.host));
  }, [registries, selected]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoadingRegs(true);
    setRegsError(null);
    apiFetch('/registries', { localOnly: true })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load registries');
        return res.json() as Promise<RegistryRow[]>;
      })
      .then((rows) => {
        if (!cancelled) setRegistries(Array.isArray(rows) ? rows : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load registries';
        setRegsError(msg);
        setRegistries([]);
        toast.error(msg);
      })
      .finally(() => {
        if (!cancelled) setLoadingRegs(false);
      });
    return () => { cancelled = true; };
  }, [isAdmin]);

  useEffect(() => {
    if (matchingRegistries.length === 0) {
      setSelectedRegistryId(null);
      return;
    }
    setSelectedRegistryId((prev) =>
      prev && matchingRegistries.some((r) => r.id === prev) ? prev : matchingRegistries[0].id,
    );
  }, [matchingRegistries]);

  const loadTags = async (cursor?: string | null, append = false) => {
    if (!selected || selectedRegistryId == null) return;
    setLoadingTags(true);
    setError(null);
    try {
      const params = new URLSearchParams({ repository: selected.repo, limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const res = await apiFetch(`/registries/${selectedRegistryId}/tags?${params}`, { localOnly: true });
      const data = await res.json().catch(() => null) as (TagListResponse & { error?: string }) | null;
      if (!res.ok) {
        throw new Error(data?.error || `Failed to list tags (${res.status})`);
      }
      const page = Array.isArray(data?.tags) ? data!.tags : [];
      setTags((prev) => (append ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to list tags';
      setError(msg);
      if (!append) setTags([]);
      toast.error(msg);
    } finally {
      setLoadingTags(false);
    }
  };

  useEffect(() => {
    setTags([]);
    setNextCursor(null);
    setError(null);
    if (selected && selectedRegistryId != null) {
      void loadTags(null, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.host, selected?.repo, selectedRegistryId]);

  if (!isAdmin) {
    return (
      <p className="text-xs text-muted-foreground">
        Registry tag browsing is available to admins with a configured registry.
      </p>
    );
  }

  if (candidates.length === 0) {
    return <p className="text-xs text-muted-foreground">No repository tags to browse.</p>;
  }

  let registryBody: ReactNode;
  if (loadingRegs) {
    registryBody = (
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading registries…
      </p>
    );
  } else if (regsError) {
    registryBody = <p className="text-xs text-destructive">{regsError}</p>;
  } else if (matchingRegistries.length === 0) {
    registryBody = (
      <p className="text-xs text-muted-foreground">
        No configured registry matches {selected?.host}. Add credentials under Settings → Registries.
      </p>
    );
  } else {
    registryBody = (
      <>
        {matchingRegistries.length > 1 && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Registry
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-foreground text-xs"
              value={selectedRegistryId ?? ''}
              onChange={(e) => setSelectedRegistryId(Number(e.target.value))}
            >
              {matchingRegistries.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {loadingTags && tags.length === 0 ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading tags…
          </p>
        ) : tags.length === 0 && !error ? (
          <p className="text-xs text-muted-foreground">No tags returned.</p>
        ) : (
          <ul className="max-h-48 overflow-y-auto space-y-1 font-mono text-[11px]">
            {tags.map((tag) => {
              const isCurrent = selected?.tagName === tag;
              return (
                <li key={tag} className="flex items-center gap-2 truncate">
                  <span className={isCurrent ? 'text-foreground font-medium' : 'text-stat-subtitle/90'}>
                    {tag}
                  </span>
                  {isCurrent && (
                    <Badge variant="outline" className="text-[9px] h-4">current</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={loadingTags}
            onClick={() => void loadTags(nextCursor, true)}
          >
            {loadingTags ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {candidates.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {candidates.map((c, i) => (
            <button
              key={c.label}
              type="button"
              className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors ${
                i === selectedRepoIdx
                  ? 'border-foreground/30 bg-muted text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setSelectedRepoIdx(i)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {registryBody}
    </div>
  );
}

export const __test = { parseRepoFromTag, registryMatchesHost };
