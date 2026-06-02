import { useEffect, useMemo, useRef, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import { GitBranch, Pencil, ExternalLink, Rocket, FolderOpen } from 'lucide-react';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { StackActivityTimeline } from './stack/StackActivityTimeline';
import type { NotificationItem } from '@/components/dashboard/types';

interface StackAnatomyPanelProps {
  stackName: string;
  content: string;
  envContent: string;
  selectedEnvFile: string;
  gitSourcePending: boolean;
  onEditCompose: () => void;
  onOpenGitSource: () => void;
  onApplyUpdate: () => void;
  onOpenFiles?: () => void;
  canEdit: boolean;
  applying?: boolean;
  notifications?: NotificationItem[];
}

type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

interface UpdatePreviewSummary {
  has_update: boolean;
  primary_image: string | null;
  current_tag: string | null;
  next_tag: string | null;
  semver_bump: SemverBump;
  blocked: boolean;
  blocked_reason: string | null;
}

interface UpdatePreview {
  summary: UpdatePreviewSummary;
  changelog: string | null;
}

interface GitSourceInfo {
  repo_url: string;
  branch: string;
  compose_path?: string;
}

interface PortRow {
  host: string;
  container: string;
  proto: string;
}

interface VolumeRow {
  host: string;
  container: string;
}

interface Anatomy {
  services: string[];
  ports: Record<string, PortRow[]>;
  volumes: Record<string, VolumeRow[]>;
  restart: string | null;
  envFiles: string[];
  networks: string[];
  referencedVars: string[];
}

// Matches ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, ${VAR?err}.
// Capture group 1 is the variable name, group 2 (optional) is the modifier form.
const INTERPOLATION_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])[^}]*)?\}/g;

function parsePortMapping(raw: unknown): PortRow | null {
  if (typeof raw === 'string') {
    const s = raw.replace(/^"|"$/g, '');
    const protoMatch = s.match(/\/(tcp|udp)$/i);
    const proto = protoMatch ? protoMatch[1].toLowerCase() : 'tcp';
    const body = proto ? s.replace(/\/(tcp|udp)$/i, '') : s;
    const parts = body.split(':');
    if (parts.length === 2) return { host: parts[0], container: parts[1], proto };
    if (parts.length === 3) return { host: parts[1], container: parts[2], proto };
    return { host: body, container: body, proto };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const host = obj.published !== undefined ? String(obj.published) : '';
    const container = obj.target !== undefined ? String(obj.target) : '';
    const proto = obj.protocol ? String(obj.protocol) : 'tcp';
    if (host && container) return { host, container, proto };
  }
  return null;
}

function parseVolumeMapping(raw: unknown): VolumeRow | null {
  if (typeof raw === 'string') {
    const parts = raw.split(':');
    if (parts.length >= 2) return { host: parts[0], container: parts[1] };
    return null;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.source && obj.target) return { host: String(obj.source), container: String(obj.target) };
  }
  return null;
}

interface ServiceAnatomy {
  ports: PortRow[];
  volumes: VolumeRow[];
  restart: string | null;
  envFiles: string[];
  networks: string[];
}

function parseServiceBlock(svc: Record<string, unknown>): ServiceAnatomy {
  const ports: PortRow[] = Array.isArray(svc.ports)
    ? svc.ports.map(parsePortMapping).filter((r): r is PortRow => r !== null)
    : [];
  const volumes: VolumeRow[] = Array.isArray(svc.volumes)
    ? svc.volumes.map(parseVolumeMapping).filter((r): r is VolumeRow => r !== null)
    : [];
  const restart = typeof svc.restart === 'string' ? svc.restart : null;
  const envFiles: string[] = typeof svc.env_file === 'string'
    ? [svc.env_file]
    : Array.isArray(svc.env_file)
      ? svc.env_file.filter((e): e is string => typeof e === 'string')
      : [];
  let networks: string[] = [];
  if (Array.isArray(svc.networks)) {
    networks = svc.networks.filter((n): n is string => typeof n === 'string');
  } else if (svc.networks && typeof svc.networks === 'object') {
    networks = Object.keys(svc.networks as Record<string, unknown>);
  }
  return { ports, volumes, restart, envFiles, networks };
}

// `:-` and `-` forms supply a default value (no env entry required);
// `:?` and `?` forms signal a required variable (the user still needs to define it).
function extractInterpolations(yamlText: string): string[] {
  const referenced = new Set<string>();
  const defaulted = new Set<string>();
  for (const m of yamlText.matchAll(INTERPOLATION_REGEX)) {
    referenced.add(m[1]);
    if (m[2] === ':-' || m[2] === '-') defaulted.add(m[1]);
  }
  return Array.from(referenced).filter(v => !defaulted.has(v));
}

function parseAnatomy(yamlText: string): Anatomy | null {
  if (!yamlText.trim()) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const servicesObj = (root.services && typeof root.services === 'object')
    ? root.services as Record<string, unknown>
    : {};
  const serviceNames = Object.keys(servicesObj);

  const ports: Record<string, PortRow[]> = {};
  const volumes: Record<string, VolumeRow[]> = {};
  let restart: string | null = null;
  const envFilesSet = new Set<string>();
  const networksSet = new Set<string>();

  for (const name of serviceNames) {
    const svc = servicesObj[name];
    if (!svc || typeof svc !== 'object') continue;
    const a = parseServiceBlock(svc as Record<string, unknown>);
    if (a.ports.length > 0) ports[name] = a.ports;
    if (a.volumes.length > 0) volumes[name] = a.volumes;
    if (restart === null && a.restart !== null) restart = a.restart;
    for (const f of a.envFiles) envFilesSet.add(f);
    for (const n of a.networks) networksSet.add(n);
  }

  if (root.networks && typeof root.networks === 'object' && !Array.isArray(root.networks)) {
    for (const n of Object.keys(root.networks)) networksSet.add(n);
  }

  return {
    services: serviceNames,
    ports,
    volumes,
    restart,
    envFiles: Array.from(envFilesSet),
    networks: Array.from(networksSet),
    referencedVars: extractInterpolations(yamlText),
  };
}

function parseEnvKeys(envText: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

function formatGitSource(src: GitSourceInfo): string {
  try {
    const url = new URL(src.repo_url);
    const host = url.host;
    const repo = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return `${host}/${repo}#${src.branch}`;
  } catch {
    return `${src.repo_url}#${src.branch}`;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-3 border-t border-muted py-2 first:border-t-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle pt-0.5">{label}</span>
      <div className="min-w-0 text-[12px] text-foreground/90">{children}</div>
    </div>
  );
}

export default function StackAnatomyPanel({
  stackName,
  content,
  envContent,
  selectedEnvFile,
  gitSourcePending,
  onEditCompose,
  onOpenGitSource,
  onApplyUpdate,
  onOpenFiles,
  canEdit,
  applying = false,
  notifications,
}: StackAnatomyPanelProps) {
  const anatomy = useMemo(() => parseAnatomy(content), [content]);
  const envKeys = useMemo(() => parseEnvKeys(envContent), [envContent]);
  const missingVars = useMemo(() => {
    if (!anatomy) return [];
    return anatomy.referencedVars.filter(v => !envKeys.has(v));
  }, [anatomy, envKeys]);

  const envVarCount = envKeys.size;

  const [gitSource, setGitSource] = useState<GitSourceInfo | null>(null);
  const [updatePreview, setUpdatePreview] = useState<UpdatePreview | null>(null);
  const [scanStatus, setScanStatus] = useState<{
    status: 'ok' | 'partial' | 'failed' | 'skipped' | null;
    attemptedAt?: number;
    errorMessage?: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/git-source`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setGitSource({ repo_url: data.repo_url, branch: data.branch, compose_path: data.compose_path });
        } else {
          setGitSource(null);
        }
      } catch {
        if (!cancelled) setGitSource(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/update-preview`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setUpdatePreview(data);
        } else {
          setUpdatePreview(null);
        }
      } catch {
        if (!cancelled) setUpdatePreview(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName]);

  // Re-check the preview when an in-flight apply finishes (applying true -> false).
  // A successful update clears has_update so the banner unmounts; a failed one
  // leaves it in place, since an update is still pending.
  const prevApplyingRef = useRef(applying);
  useEffect(() => {
    const finishedApplying = prevApplyingRef.current && !applying;
    prevApplyingRef.current = applying;
    if (!finishedApplying) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/update-preview`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setUpdatePreview(data);
        } else {
          setUpdatePreview(null);
        }
      } catch {
        // Advisory background read: on failure show no banner rather than a stale one.
        // The apply action reports its own success or failure; this refresh does not.
        if (!cancelled) setUpdatePreview(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [applying, stackName]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/scan-status`);
        if (cancelled) return;
        if (res.ok) {
          setScanStatus(await res.json());
        } else {
          setScanStatus(null);
        }
      } catch {
        if (!cancelled) setScanStatus(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName]);

  const networkName = anatomy && anatomy.networks.length > 0
    ? anatomy.networks[0]
    : `${stackName}_default`;
  const firstEnvFile = anatomy?.envFiles[0] ?? selectedEnvFile ?? null;
  const primaryHostPort = useMemo(() => {
    if (!anatomy) return null;
    for (const svc of anatomy.services) {
      const rows = anatomy.ports[svc];
      if (rows && rows.length > 0) return rows[0].host;
    }
    return null;
  }, [anatomy]);

  const bump = updatePreview?.summary.semver_bump ?? 'none';
  const hasUpdate = Boolean(updatePreview?.summary.has_update);
  const blocked = Boolean(updatePreview?.summary.blocked);
  const bannerSeverity: 'danger' | 'warn' | 'ok' = bump === 'major' || blocked
    ? 'danger'
    : bump === 'minor' ? 'warn' : 'ok';
  const bannerTone = bannerSeverity === 'danger'
    ? 'border-destructive/40 bg-destructive/[0.06] text-destructive'
    : bannerSeverity === 'warn'
      ? 'border-warning/40 bg-warning/[0.06] text-warning'
      : 'border-success/40 bg-success/[0.06] text-success';
  const applyBtnTone = bannerSeverity === 'danger'
    ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
    : bannerSeverity === 'warn'
      ? 'border-warning/40 text-warning hover:bg-warning/10'
      : 'border-success/40 text-success hover:bg-success/10';
  const bumpLabel = bump === 'none' || bump === 'unknown' ? '' : `${bump}`;
  const bannerLeadIn = blocked
    ? 'review required'
    : bump === 'patch'
      ? 'safe to apply'
      : bump === 'minor'
        ? 'review recommended'
        : bump === 'major'
          ? 'breaking changes possible'
          : '';

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-muted bg-card/40">
      <Tabs defaultValue="anatomy" className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-muted px-3 py-1.5 gap-2">
        <TabsList className="h-7 gap-0.5 bg-transparent border-none p-0">
          <TabsTrigger value="anatomy" className="h-6 px-2.5 font-mono text-[10px] uppercase tracking-[0.18em]">Anatomy</TabsTrigger>
          <TabsTrigger value="activity" className="h-6 px-2.5 font-mono text-[10px] uppercase tracking-[0.18em]">Activity</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-3">
          {onOpenFiles && (
            <button
              type="button"
              data-testid="anatomy-files-btn"
              onClick={onOpenFiles}
              className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors"
            >
              <FolderOpen className="h-3 w-3" strokeWidth={1.5} />
              files
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={onEditCompose}
              className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors"
            >
              <Pencil className="h-3 w-3" strokeWidth={1.5} />
              edit
            </button>
          )}
        </div>
      </div>
      <TabsContent value="activity" className="flex-1 min-h-0 overflow-y-auto px-3 mt-0">
        <StackActivityTimeline stackName={stackName} liveEvents={notifications?.filter(n => n.stack_name === stackName)} />
      </TabsContent>
      <TabsContent value="anatomy" className="flex flex-col flex-1 min-h-0 mt-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-3">
        {!anatomy ? (
          <div className="py-3 font-mono text-[11px] text-stat-subtitle">Unable to parse compose.yaml.</div>
        ) : (
          <>
            <Row label="services">
              {anatomy.services.length === 0 ? (
                <span className="text-stat-subtitle">none defined</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {anatomy.services.map(s => (
                    <span key={s} className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </Row>
            <Row label="ports">
              {Object.keys(anatomy.ports).length === 0 ? (
                <span className="text-stat-subtitle">none</span>
              ) : (
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {Object.entries(anatomy.ports).flatMap(([svc, rows]) =>
                    rows.map((r, i) => (
                      <div key={`${svc}-${i}`} className="flex items-center gap-1.5">
                        {anatomy.services.length > 1 && (
                          <span className="text-stat-subtitle">{svc}</span>
                        )}
                        <span className="font-semibold text-foreground">{r.host}</span>
                        <span className="text-stat-subtitle">→</span>
                        <span>{r.container}/{r.proto}</span>
                      </div>
                    )),
                  )}
                </div>
              )}
            </Row>
            <Row label="volumes">
              {Object.keys(anatomy.volumes).length === 0 ? (
                <span className="text-stat-subtitle">none</span>
              ) : (
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {Object.entries(anatomy.volumes).flatMap(([svc, rows]) =>
                    rows.map((r, i) => (
                      <div key={`${svc}-${i}`} className="flex items-center gap-1.5 min-w-0">
                        {anatomy.services.length > 1 && (
                          <span className="text-stat-subtitle shrink-0">{svc}</span>
                        )}
                        <span className="truncate text-foreground/90">{r.host}</span>
                        <span className="text-stat-subtitle shrink-0">→</span>
                        <span className="truncate">{r.container}</span>
                      </div>
                    )),
                  )}
                </div>
              )}
            </Row>
            <Row label="restart">
              <span className="font-mono text-[11px]">{anatomy.restart ?? <span className="text-stat-subtitle">default</span>}</span>
            </Row>
            <Row label="env_file">
              {!firstEnvFile ? (
                <span className="text-stat-subtitle">none</span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  <div className="font-mono text-[11px]">
                    <span className="text-foreground/90">{firstEnvFile}</span>
                    <span className="text-stat-subtitle"> · {envVarCount} var{envVarCount === 1 ? '' : 's'}</span>
                  </div>
                  {missingVars.length > 0 && (
                    <div className="flex flex-wrap gap-1 font-mono text-[11px] text-destructive">
                      {missingVars.map(v => (
                        <span key={v}>{'${'}{v}{'}'} missing</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Row>
            <Row label="network">
              <span className="font-mono text-[11px]">{networkName} <span className="text-stat-subtitle">· bridge</span></span>
            </Row>
            <Row label="source">
              <button
                type="button"
                onClick={onOpenGitSource}
                aria-label="Git Source"
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-left hover:text-brand transition-colors"
              >
                <GitBranch className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                {gitSource ? (
                  <span className="truncate">git <span className="text-stat-subtitle">·</span> {formatGitSource(gitSource)}</span>
                ) : (
                  <span>local</span>
                )}
                {gitSourcePending && (
                  <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand animate-pulse" />
                )}
              </button>
            </Row>
          </>
        )}
        {hasUpdate && updatePreview && (
          <div data-testid="update-available-banner" className={cn('mt-3 mb-3 rounded-lg border p-3', bannerTone)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase tracking-wide">
                  Update available
                  {updatePreview.summary.current_tag && updatePreview.summary.next_tag && (
                    <span className="text-foreground">
                      {' · '}
                      <span className="text-stat-subtitle">{updatePreview.summary.current_tag}</span>
                      {' -> '}
                      <span className="text-foreground font-semibold">{updatePreview.summary.next_tag}</span>
                    </span>
                  )}
                </div>
                <div className="mt-1 font-mono text-[11px] text-foreground/80 leading-relaxed">
                  {[
                    bumpLabel,
                    bannerLeadIn,
                    updatePreview.changelog ? updatePreview.changelog.split(/[.\n]/)[0] : '',
                  ].filter(Boolean).join(' · ')}
                </div>
                {blocked && updatePreview.summary.blocked_reason && (
                  <div className="mt-1 font-mono text-[10px] text-destructive">{updatePreview.summary.blocked_reason}</div>
                )}
              </div>
              {canEdit && !blocked && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={applying}
                  className={cn('shrink-0 h-7 gap-1', applyBtnTone)}
                  onClick={onApplyUpdate}
                >
                  <Rocket className={cn('h-3 w-3', applying && 'animate-pulse')} strokeWidth={1.5} />
                  {applying ? 'applying...' : 'apply'}
                </Button>
              )}
            </div>
          </div>
        )}
        {scanStatus && scanStatus.status && scanStatus.status !== 'ok' && (
          <div
            className="mx-3 my-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-2 py-1.5 text-[11px] text-warning"
            role="status"
            title={scanStatus.errorMessage ?? undefined}
          >
            <span className="font-mono text-[9px] uppercase tracking-wide shrink-0 mt-0.5">scan</span>
            <span className="flex-1">
              {scanStatus.status === 'failed' && 'Last post-deploy scan failed.'}
              {scanStatus.status === 'partial' && 'Last post-deploy scan partially failed.'}
              {scanStatus.status === 'skipped' && 'Post-deploy scan did not run.'}
              {scanStatus.errorMessage ? ` ${scanStatus.errorMessage}` : ''}
            </span>
          </div>
        )}
      </div>
      {anatomy && anatomy.services.length > 0 && (
        <div className="border-t border-muted px-3 py-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">
            {Object.keys(anatomy.ports).length > 0 ? 'exposed' : 'no ports'}
          </span>
          {primaryHostPort && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-stat-subtitle">
              <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
              :{primaryHostPort}
            </span>
          )}
        </div>
      )}
      </TabsContent>
      </Tabs>
    </div>
  );
}
