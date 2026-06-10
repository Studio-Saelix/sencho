import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Save, TriangleAlert } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { downloadTextFile } from '@/lib/download';
import { toast } from '@/components/ui/toast-store';
import { Input } from '@/components/ui/input';
import {
  buildStackDossierMarkdown,
  EMPTY_DOSSIER_FIELDS,
  type StackDossierFields,
} from '@/lib/dossierMarkdown';
import type { AnatomyMarkdownInput } from '@/lib/anatomyMarkdown';
import { computeDocDrift, type DocDriftFinding } from '@/lib/docDrift';
import { useNodes } from '@/context/NodeContext';

interface StackDossierPanelProps {
  stackName: string;
  /** Generated anatomy for this stack, or null when compose.yaml cannot be parsed. */
  anatomy: AnatomyMarkdownInput | null;
  canEdit: boolean;
}

const FIELD_KEYS = Object.keys(EMPTY_DOSSIER_FIELDS) as Array<keyof StackDossierFields>;

// `max` caps mirror the backend dossier validation schema (routes/stacks.ts), so
// the input stops at the limit instead of letting a save fail with a 400.
const TEXT_FIELDS: Array<{ key: keyof StackDossierFields; label: string; placeholder: string; max: number }> = [
  { key: 'purpose', label: 'purpose', placeholder: 'What this stack is for', max: 1000 },
  { key: 'owner', label: 'owner', placeholder: 'Who maintains it', max: 1000 },
  { key: 'static_ip', label: 'static ip', placeholder: 'e.g. 10.0.20.5', max: 255 },
  { key: 'vlan', label: 'vlan', placeholder: 'e.g. 20 / iot', max: 255 },
];

const TEXTAREA_FIELDS: Array<{ key: keyof StackDossierFields; label: string; placeholder: string; rows: number; max: number }> = [
  { key: 'access_urls', label: 'access urls', placeholder: 'One URL per line', rows: 2, max: 2000 },
  { key: 'firewall_notes', label: 'firewall', placeholder: 'Ports opened, rules, zones', rows: 2, max: 8000 },
  { key: 'reverse_proxy_notes', label: 'reverse proxy', placeholder: 'Hostnames, upstreams, TLS', rows: 2, max: 8000 },
  { key: 'backup_notes', label: 'backup', placeholder: 'What to back up and how', rows: 2, max: 8000 },
  { key: 'upgrade_notes', label: 'upgrade', placeholder: 'Upgrade steps and gotchas', rows: 2, max: 8000 },
  { key: 'recovery_notes', label: 'recovery', placeholder: 'How to rebuild from scratch', rows: 2, max: 8000 },
  { key: 'custom_notes', label: 'notes', placeholder: 'Anything else worth recording', rows: 3, max: 8000 },
];

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const MONO_FACT_CLASS = 'font-mono text-[11px]';
const TEXTAREA_CLASS =
  'w-full rounded-md border border-glass-border bg-input px-3 py-2 text-[12px] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40 disabled:hover:text-stat-subtitle';

function pickFields(data: unknown): StackDossierFields {
  const out = { ...EMPTY_DOSSIER_FIELDS };
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of FIELD_KEYS) {
      if (typeof obj[k] === 'string') out[k] = obj[k] as string;
    }
  }
  return out;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-3 border-t border-muted py-2 first:border-t-0">
      <span className={cn(LABEL_CLASS, 'pt-0.5')}>{label}</span>
      <div className="min-w-0 text-[12px] text-foreground/90">{children}</div>
    </div>
  );
}

function GeneratedFacts({ anatomy }: { anatomy: AnatomyMarkdownInput }) {
  const portRows = Object.values(anatomy.ports).flat();
  const volumeCount = Object.values(anatomy.volumes).reduce((n, list) => n + list.length, 0);
  return (
    <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
      <Row label="services">
        {anatomy.services.length === 0 ? (
          <span className="text-stat-subtitle">none defined</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {anatomy.services.map(s => (
              <span key={s} className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{s}</span>
            ))}
          </div>
        )}
      </Row>
      <Row label="ports">
        {portRows.length === 0 ? (
          <span className="text-stat-subtitle">none</span>
        ) : (
          <span className={MONO_FACT_CLASS}>
            {portRows.length} published <span className="text-stat-subtitle">· {portRows.map(r => `:${r.host}`).join(' ')}</span>
          </span>
        )}
      </Row>
      <Row label="volumes">
        <span className={MONO_FACT_CLASS}>{volumeCount === 0 ? <span className="text-stat-subtitle">none</span> : volumeCount}</span>
      </Row>
      <Row label="network">
        <span className={MONO_FACT_CLASS}>{anatomy.networkName} <span className="text-stat-subtitle">· bridge</span></span>
      </Row>
      <Row label="restart">
        <span className={MONO_FACT_CLASS}>{anatomy.restart ?? <span className="text-stat-subtitle">default</span>}</span>
      </Row>
      <Row label="env_file">
        {!anatomy.envFile ? (
          <span className="text-stat-subtitle">none</span>
        ) : (
          <span className={MONO_FACT_CLASS}>
            {anatomy.envFile} <span className="text-stat-subtitle">· {anatomy.envVarCount} var{anatomy.envVarCount === 1 ? '' : 's'}</span>
            {anatomy.missingVars.length > 0 && (
              <span className="text-destructive"> · {anatomy.missingVars.length} missing</span>
            )}
          </span>
        )}
      </Row>
      <Row label="source">
        <span className={MONO_FACT_CLASS}>
          {anatomy.gitSource ? <>git <span className="text-stat-subtitle">·</span> {anatomy.gitSource}</> : 'local'}
        </span>
      </Row>
    </div>
  );
}

// Documentation drift: ports the operator documented in access_urls that the
// stack does not publish. Read-only and advisory; it never edits notes or
// compose. Visual language matches the Drift tab's warning findings.
function DocDriftWarnings({ findings }: { findings: DocDriftFinding[] }) {
  return (
    <section data-testid="dossier-doc-drift">
      <div className={cn(LABEL_CLASS, 'mb-1.5')}>documentation drift</div>
      <div className="rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-1">
        {findings.map(f => (
          <div key={f.port} className="border-t border-warning/20 py-2 first:border-t-0">
            <div className="flex items-center gap-2">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.5} />
              <span className="rounded-md bg-warning/15 px-1.5 py-0.5 font-mono text-[11px] text-warning">:{f.port}</span>
              <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">not published</span>
            </div>
            <div className="mt-1 text-[12px] text-foreground/90">{f.detail}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-stat-subtitle" title={f.source}>{f.source}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function StackDossierPanel({ stackName, anatomy, canEdit }: StackDossierPanelProps) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  // Identifies the dossier currently in view. Doc-drift renders only once the
  // load for *this* key has succeeded (see loadedKey), so a switch-in-flight or
  // a failed load never diffs new anatomy against the prior stack's fields.
  const currentKey = `${nodeId ?? ''}::${stackName}`;
  const [fields, setFields] = useState<StackDossierFields>(EMPTY_DOSSIER_FIELDS);
  // The last-saved values, kept in state so dirty-tracking compares against them
  // without reading a ref during render.
  const [serverFields, setServerFields] = useState<StackDossierFields>(EMPTY_DOSSIER_FIELDS);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The (node, stack) whose dossier has successfully loaded. Set only on a
  // successful fetch, so it lags during a switch and stays behind on a failed
  // load, which is exactly when doc-drift must stay hidden.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Reload when the stack OR the active node changes: the same stack name can
  // exist on two nodes with independent dossiers, and apiFetch scopes by the
  // active node, so a node switch must refetch. On failure we keep the existing
  // values and show a distinct error state rather than blanking the form, so a
  // failed load can never be mistaken for an empty dossier or saved as one.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/dossier`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the stack dossier.');
          return;
        }
        const next = pickFields(await res.json());
        setServerFields(next);
        setFields(next);
        setLoadError(false);
        setLoadedKey(`${nodeId ?? ''}::${stackName}`);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the stack dossier.');
        }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  const dirty = useMemo(
    () => FIELD_KEYS.some(k => fields[k] !== serverFields[k]),
    [fields, serverFields],
  );

  // Recomputes live as the operator edits access_urls; depends on that single
  // field so unrelated edits do not re-run the comparison.
  const docDrift = useMemo(
    () => computeDocDrift(anatomy, fields.access_urls),
    [anatomy, fields.access_urls],
  );

  const setField = (key: keyof StackDossierFields, value: string) =>
    setFields(prev => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/dossier`, {
        method: 'PUT',
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const err = await res.json().catch((parseErr) => {
          console.error('[Dossier] save error response was not JSON:', parseErr);
          return {};
        });
        toast.error(err?.error || 'Failed to save the dossier.');
        return;
      }
      const saved = pickFields(await res.json());
      setServerFields(saved);
      setFields(saved);
      toast.success('Stack dossier saved.');
    } catch {
      // apiFetch throws a sentinel ('Unauthorized') or a network error here; show
      // a fixed friendly message rather than echoing an internal error string.
      toast.error('Failed to save the dossier. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!anatomy) return;
    try {
      await copyToClipboard(buildStackDossierMarkdown(anatomy, fields));
      toast.success('Stack dossier copied as Markdown.');
    } catch {
      toast.error('Failed to copy to clipboard.');
    }
  };

  const handleDownload = () => {
    if (!anatomy) return;
    try {
      // Stack names are already constrained, but sanitize defensively so the
      // file always has a coherent, safe name ending in .md.
      const base = stackName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'stack';
      downloadTextFile(`${base}-dossier.md`, buildStackDossierMarkdown(anatomy, fields));
    } catch {
      toast.error('Failed to download the dossier.');
    }
  };

  return (
    <div data-testid="dossier-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>export</span>
        <div className="flex items-center gap-3">
          <button type="button" data-testid="dossier-copy-btn" onClick={() => { void handleCopy(); }} disabled={!anatomy || loadError} className={ACTION_CLASS}>
            <Copy className="h-3 w-3" strokeWidth={1.5} /> copy md
          </button>
          <button type="button" data-testid="dossier-download-btn" onClick={handleDownload} disabled={!anatomy || loadError} className={ACTION_CLASS}>
            <Download className="h-3 w-3" strokeWidth={1.5} /> download
          </button>
        </div>
      </div>

      <section>
        <div className={cn(LABEL_CLASS, 'mb-1.5')}>generated facts</div>
        {anatomy ? (
          <GeneratedFacts anatomy={anatomy} />
        ) : (
          <div className="rounded-lg border border-muted bg-card/40 px-3 py-3 font-mono text-[11px] text-stat-subtitle">
            Unable to parse compose.yaml.
          </div>
        )}
      </section>

      {loadedKey === currentKey && docDrift.length > 0 && <DocDriftWarnings findings={docDrift} />}

      <section>
        <div className={cn(LABEL_CLASS, 'mb-1.5')}>operator notes</div>
        {loadError ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
            <span className="font-mono text-[11px] text-destructive">Could not load this dossier.</span>
            <button
              type="button"
              data-testid="dossier-retry-btn"
              onClick={() => setReloadKey(k => k + 1)}
              className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline"
            >
              retry
            </button>
          </div>
        ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            {TEXT_FIELDS.map(({ key, label, placeholder, max }) => (
              <label key={key} className="flex flex-col gap-1">
                <span className={LABEL_CLASS}>{label}</span>
                <Input
                  data-testid={`dossier-field-${key}`}
                  value={fields[key]}
                  onChange={e => setField(key, e.target.value)}
                  placeholder={placeholder}
                  disabled={!canEdit}
                  maxLength={max}
                  className="h-8 text-[12px]"
                />
              </label>
            ))}
          </div>
          {TEXTAREA_FIELDS.map(({ key, label, placeholder, rows, max }) => (
            <label key={key} className="flex flex-col gap-1">
              <span className={LABEL_CLASS}>{label}</span>
              <textarea
                data-testid={`dossier-field-${key}`}
                value={fields[key]}
                onChange={e => setField(key, e.target.value)}
                placeholder={placeholder}
                disabled={!canEdit}
                rows={rows}
                maxLength={max}
                className={TEXTAREA_CLASS}
              />
            </label>
          ))}
          {canEdit && (
            <div className="flex items-center justify-end gap-3 pt-1">
              {dirty && <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">unsaved changes</span>}
              <button
                type="button"
                data-testid="dossier-save-btn"
                onClick={() => { void handleSave(); }}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-1.5 rounded-md border border-brand/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-brand transition-colors hover:bg-brand/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Save className={cn('h-3 w-3', saving && 'animate-pulse')} strokeWidth={1.5} />
                {saving ? 'saving…' : 'save'}
              </button>
            </div>
          )}
        </div>
        )}
      </section>
    </div>
  );
}
