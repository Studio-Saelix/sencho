import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, Pencil, ExternalLink, Rocket, FolderOpen, X } from 'lucide-react';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ScrollableTabRow } from './ui/ScrollableTabRow';
import { apiFetch } from '@/lib/api';
import { fetchUpdatePreview } from '@/lib/fetchUpdatePreview';
import {
  isActionableUpdatePreview,
  isPreviewUncertain,
  isReviewRequiredUpdatePreview,
  isTagOnlyAdvisory,
  DIGEST_REBUILD_HINT,
} from '@/lib/updatePreviewActionability';
import { cn } from '@/lib/utils';
import { type AnatomyMarkdownInput, type PortRow, type VolumeRow } from '@/lib/anatomyMarkdown';
import { usePreflightDismiss } from '@/hooks/usePreflightDismiss';
import { useScanBannerDismiss } from '@/hooks/useScanBannerDismiss';
import { parseAnatomy, parseEnvKeys, formatGitSource, imageName, primaryPublishedHostPort, type GitSourceInfo } from '@/lib/anatomy';
import { buildServiceUrl } from '@/lib/serviceUrl';
import { StackActivityTimeline } from './stack/StackActivityTimeline';
import StackDossierPanel from './stack/StackDossierPanel';
import DriftPanel from './stack/DriftPanel';
import PreflightPanel from './stack/PreflightPanel';
import StoragePanel from './stack/StoragePanel';
import EnvironmentPanel from './stack/EnvironmentPanel';
import ComposeLabelsPanel from './stack/ComposeLabelsPanel';
import StackNetworkingPanel from './stack/StackNetworkingPanel';
import { useNodes } from '@/context/NodeContext';
import { isPreflightNoteFinding } from '@/lib/preflightNotes';
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
  requestedTab?: 'networking' | 'doctor' | 'dossier' | 'drift';
}

type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';
type UpdateKind = 'tag' | 'digest' | 'none';

interface UpdatePreviewImage {
  service: string;
  image: string;
  current_tag: string;
  next_tag: string | null;
  has_update: boolean;
  digest_update?: boolean;
  tag_update?: boolean;
  semver_bump: SemverBump;
  check_status?: 'ok' | 'partial' | 'failed' | 'not_checkable';
  check_error?: string | null;
  /** This image's own digest-comparison failure; not masked by a confirmed tag update. */
  digest_error?: string | null;
}

interface UpdatePreviewSummary {
  has_update: boolean;
  primary_image: string | null;
  current_tag: string | null;
  next_tag: string | null;
  semver_bump: SemverBump;
  update_kind?: UpdateKind;
  blocked: boolean;
  blocked_reason: string | null;
  has_build_services: boolean;
  rebuild_available: boolean;
  check_status?: 'ok' | 'partial' | 'failed';
  verification_failed?: boolean;
  verification_error?: string | null;
}

interface UpdatePreview {
  summary: UpdatePreviewSummary;
  images: UpdatePreviewImage[];
  build_services?: string[];
  changelog: string | null;
}

/** Secret-safe effective facts from GET /stacks/:name/effective-anatomy. */
interface EffectiveAnatomyFacts {
  services: string[];
  ports: Record<string, PortRow[]>;
  volumes: Record<string, VolumeRow[]>;
  restart: string | null;
  networks: string[];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-3 border-t border-muted py-2 first:border-t-0">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-stat-subtitle pt-0.5">{label}</span>
      <div className="min-w-0 text-xs text-foreground/90">{children}</div>
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
  requestedTab,
}: StackAnatomyPanelProps) {
  const anatomy = useMemo(() => parseAnatomy(content), [content]);
  const envKeys = useMemo(() => parseEnvKeys(envContent), [envContent]);
  const missingVars = useMemo(() => {
    if (!anatomy) return [];
    return anatomy.referencedVars.filter(v => !envKeys.has(v));
  }, [anatomy, envKeys]);

  const envVarCount = envKeys.size;

  const { hasCapability, activeNode } = useNodes();
  const doctorEnabled = hasCapability('compose-doctor');
  const networkingEnabled = hasCapability('compose-networking');
  const storageEnabled = hasCapability('compose-storage');
  const envInventoryEnabled = hasCapability('env-inventory');
  const composeLabelsEnabled = hasCapability('container-label-inventory');

  const [gitSource, setGitSource] = useState<{ stack: string; info: GitSourceInfo; multiFile: boolean } | null>(null);
  // Merged effective facts (services/ports/volumes/networks/restart) for a
  // multi-file Git stack, fetched from the backend's rendered model so the Dossier
  // and its doc-drift reflect every override file. Null for single-file / non-git
  // stacks and whenever the render is unavailable, where the root-only parse stands.
  const [effectiveAnatomy, setEffectiveAnatomy] = useState<({ stack: string } & EffectiveAnatomyFacts) | null>(null);
  const [updatePreview, setUpdatePreview] = useState<UpdatePreview | null>(null);
  // Last preflight severity, used only to dot the Doctor tab. Radix mounts the
  // active tab content lazily, so the badge cannot come from PreflightPanel; the
  // parent reads the stored run once per stack/node change.
  const [preflightSeverity, setPreflightSeverity] = useState<string | null>(null);
  // Findings power the dismiss fingerprint so the dot clears in lockstep with the
  // banner and re-appears when the findings change.
  const [preflightFindings, setPreflightFindings] = useState<Array<{ ruleId: string; severity: string; service?: string }> | undefined>(undefined);
  // The Doctor tab dot clears when the high-risk banner is dismissed, and returns
  // when the findings change (shared fingerprint with PreflightPanel).
  const { dismissed: doctorDismissed } = usePreflightDismiss(stackName, activeNode?.id, preflightFindings);
  const [scanStatus, setScanStatus] = useState<{
    status: 'ok' | 'partial' | 'failed' | 'skipped' | null;
    attemptedAt?: number;
    errorMessage?: string | null;
  } | null>(null);
  const [activeTab, setActiveTab] = useState('anatomy');

  useEffect(() => {
    if (requestedTab === 'networking' && networkingEnabled) setActiveTab('networking');
    if (requestedTab === 'doctor' && doctorEnabled) setActiveTab('doctor');
    // Dossier and Drift are unconditional base tabs (no capability gate), unlike
    // Doctor/Networking which require a node capability.
    if (requestedTab === 'dossier') setActiveTab('dossier');
    if (requestedTab === 'drift') setActiveTab('drift');
  }, [doctorEnabled, networkingEnabled, requestedTab]);
  const { dismissed: scanBannerDismissed, dismiss: dismissScanBanner } =
    useScanBannerDismiss(stackName, activeNode?.id, scanStatus);

  // Best-effort badge: read the last stored preflight severity to dot the tab.
  // Skipped when the active node does not advertise the capability.
  useEffect(() => {
    // The dot and tab are gated on doctorEnabled, so a stale severity is never
    // shown; no synchronous reset needed when the capability is absent.
    if (!doctorEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/preflight`);
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setPreflightSeverity(typeof data?.activeHighestSeverity === 'string' ? data.activeHighestSeverity : null);
          const findings = Array.isArray(data?.findings) ? data.findings : undefined;
          // Notes do not drive the Doctor tab dismiss fingerprint.
          setPreflightFindings(findings?.filter((f: { acknowledged?: boolean; ruleId?: string }) =>
            !f.acknowledged && !isPreflightNoteFinding(f.ruleId)));
        }
      } catch {
        if (!cancelled) { setPreflightSeverity(null); setPreflightFindings(undefined); }
      }
    })();
    return () => { cancelled = true; };
  }, [stackName, activeNode?.id, doctorEnabled]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/git-source`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          // An unlinked stack answers 200 { linked: false }; only render the
          // badge when an actual source is attached.
          if (data && data.linked === false) {
            setGitSource(null);
          } else {
            // More than one configured compose path means override files merge into
            // the deployed model, so the dossier must read the effective render.
            const multiFile = Array.isArray(data.compose_paths) && data.compose_paths.length > 1;
            setGitSource({
              stack: stackName,
              info: { repo_url: data.repo_url, branch: data.branch, compose_path: data.compose_path },
              multiFile,
            });
          }
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

  // Multi-file Git stacks deploy a merged model, so the dossier reads the backend's
  // rendered effective facts instead of the root compose alone.
  useEffect(() => {
    // Single-file / non-git stacks keep the root-only parse and skip the fetch.
    // Any tagged result left from a previous stack is ignored downstream by the
    // stack-name guard, so there is no need to clear state synchronously here.
    if (!(gitSource?.stack === stackName && gitSource.multiFile)) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/effective-anatomy`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          // Adopt the merged facts only when the model actually rendered; on a render
          // error keep the root-only parse so the dossier never shows an empty summary.
          setEffectiveAnatomy(data && data.renderable ? {
            stack: stackName,
            services: Array.isArray(data.services) ? data.services : [],
            ports: data.ports ?? {},
            volumes: data.volumes ?? {},
            restart: data.restart ?? null,
            networks: Array.isArray(data.networks) ? data.networks : [],
          } : null);
        } else {
          setEffectiveAnatomy(null);
        }
      } catch {
        if (!cancelled) setEffectiveAnatomy(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, activeNode?.id, gitSource]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await fetchUpdatePreview(stackName);
        if (cancelled) return;
        if (result.ok && result.preview) {
          setUpdatePreview(result.preview as UpdatePreview);
        } else {
          setUpdatePreview(null);
        }
      } catch (err) {
        console.error('[StackAnatomyPanel] update-preview load failed', err);
        if (!cancelled) setUpdatePreview(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName]);

  // When an apply for the current stack finishes (applying true -> false on the same
  // stackName), re-check the preview: a landed update clears has_update so the banner
  // unmounts; if it did not land, or the re-check itself fails, the banner stays.
  // Tracking stackName alongside applying avoids treating a stack switch made while the
  // first stack is still applying as a completion for the newly selected stack.
  const prevApplyRef = useRef({ applying, stackName });
  useEffect(() => {
    const prev = prevApplyRef.current;
    const finishedApplying = prev.applying && !applying && prev.stackName === stackName;
    prevApplyRef.current = { applying, stackName };
    if (!finishedApplying) return;
    let cancelled = false;
    const run = async () => {
      try {
        const result = await fetchUpdatePreview(stackName);
        if (cancelled) return;
        if (!result.ok) {
          // Re-check failed: keep the banner already shown rather than hiding a
          // possibly-still-pending update. The apply action reports its own outcome.
          console.error(`[StackAnatomyPanel] update-preview re-check returned ${result.status}; keeping the existing banner`);
          return;
        }
        if (!cancelled && result.preview) setUpdatePreview(result.preview as UpdatePreview);
      } catch (err) {
        console.error('[StackAnatomyPanel] update-preview re-check failed:', err);
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
  // Only treat the fetched source as current when it belongs to the selected stack, so a
  // slow /git-source response for a previously selected stack cannot render or be exported here.
  const activeGitSource = gitSource?.stack === stackName ? gitSource.info : null;
  const primaryHostPort = useMemo(
    () => (anatomy ? primaryPublishedHostPort(anatomy.ports) : null),
    [anatomy],
  );
  const primaryServiceUrl = useMemo(
    () => (primaryHostPort !== null ? buildServiceUrl({ node: activeNode, publicPort: primaryHostPort }) : null),
    [primaryHostPort, activeNode],
  );

  // Assembled facts for this stack, passed to the Dossier tab for its read-only
  // summary and Markdown export. Null until compose parses.
  const anatomyInput = useMemo<AnatomyMarkdownInput | null>(() => {
    // Prefer the merged effective facts for multi-file Git stacks so the dossier and
    // its doc-drift reflect every override file; fall back to the root-only parse.
    // Env-derived fields (count, missing vars, env file) always come from the raw
    // parse, which reads the unresolved `${VAR}` references the render has substituted.
    // `anatomy` already carries the same structural fields (plus env-only extras we
    // read separately below), so the raw parse stands in directly when there are no
    // effective facts for this stack.
    const activeEffective = effectiveAnatomy?.stack === stackName ? effectiveAnatomy : null;
    const structural = activeEffective ?? anatomy;
    if (!structural) return null;
    return {
      stackName,
      services: structural.services,
      ports: structural.ports,
      volumes: structural.volumes,
      restart: structural.restart,
      envFile: firstEnvFile,
      envVarCount,
      missingVars,
      networkName: structural.networks.length > 0 ? structural.networks[0] : `${stackName}_default`,
      gitSource: activeGitSource ? formatGitSource(activeGitSource) : null,
    };
  }, [effectiveAnatomy, anatomy, stackName, firstEnvFile, envVarCount, missingVars, activeGitSource]);

  const bump = updatePreview?.summary.semver_bump ?? 'none';
  const hasUpdate = Boolean(updatePreview?.summary.has_update);
  const hasBuildServices = Boolean(updatePreview?.summary.has_build_services);
  const rebuildAvailable = Boolean(updatePreview?.summary.rebuild_available);
  const verificationError = updatePreview?.summary.verification_error ?? null;
  const previewCheckStatus = updatePreview?.summary.check_status;
  const previewUncertain = isPreviewUncertain(updatePreview);
  // Failed digest verification is never a verified rebuild claim, but a confirmed
  // tag update or intentional local rebuild affordance still shows.
  const showUpdateBanner = hasUpdate || rebuildAvailable;
  const showCheckStatusBanner = previewUncertain && !showUpdateBanner;
  const updateKind = updatePreview?.summary.update_kind ?? 'none';
  const blocked = Boolean(updatePreview?.summary.blocked);
  // Another image in the stack failed digest verification: applying the
  // full-stack update would pull/recreate that image as collateral, so the
  // banner must not claim "safe to apply" and the Apply button is withheld
  // (per-service update actions elsewhere are unaffected). Uses the same
  // per-image logic as Fleet so the two surfaces never disagree; a stack
  // whose only unverified image is the one being updated is unaffected.
  const reviewRequired = isReviewRequiredUpdatePreview(updatePreview);
  const updatedImages = (updatePreview?.images ?? []).filter((img) => img.has_update);
  const bannerSeverity: 'danger' | 'warn' | 'ok' = bump === 'major' || blocked
    ? 'danger'
    : bump === 'minor' || reviewRequired ? 'warn' : 'ok';
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
  const tagOnlyAdvisory = isTagOnlyAdvisory(updatePreview);
  const canApplyPreview = isActionableUpdatePreview(updatePreview);

  let bannerLeadIn = '';
  if (blocked || reviewRequired) {
    bannerLeadIn = 'review required';
  } else if (tagOnlyAdvisory) {
    bannerLeadIn = 'newer tag · edit Compose pin';
  } else if (hasUpdate && updateKind === 'digest') {
    bannerLeadIn = 'same-tag digest rebuild';
  } else if (hasUpdate && hasBuildServices) {
    bannerLeadIn = 'registry update + local rebuild';
  } else if (rebuildAvailable && !hasUpdate) {
    bannerLeadIn = 'local build / rebuild required';
  } else if (bump === 'patch') {
    bannerLeadIn = 'safe to apply';
  } else if (bump === 'minor') {
    bannerLeadIn = 'review recommended';
  } else if (bump === 'major') {
    bannerLeadIn = 'breaking changes possible';
  }
  const buildServiceNames = updatePreview?.build_services ?? [];
  const buildHint = hasBuildServices
    ? `Rebuilds ${buildServiceNames.length} local build service${buildServiceNames.length === 1 ? '' : 's'} from Dockerfile context; may take longer and needs network access for base images.`
    : '';
  const gitRebuildHint = hasBuildServices && activeGitSource
    ? 'After applying Git source changes, use Rebuild & Update to deploy the updated source.'
    : '';
  const changelogLine = updatePreview?.changelog ? updatePreview.changelog.split(/[.\n]/)[0] : '';
  const bannerTailSegments = [buildHint, gitRebuildHint, changelogLine].filter(Boolean);
  const applyLabel = hasBuildServices
    ? (applying ? 'rebuilding...' : 'Rebuild & Update')
    : (applying ? 'applying...' : 'apply');

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-muted bg-card/40">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-muted px-3 py-1.5 gap-2">
        <ScrollableTabRow surface="card" wrapperClassName="min-w-0 flex-1">
          <TabsList className="h-7 w-max gap-0.5 bg-transparent border-none p-0">
            <TabsTrigger value="anatomy" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Anatomy</TabsTrigger>
            <TabsTrigger value="activity" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Activity</TabsTrigger>
            {doctorEnabled && (
              <TabsTrigger value="doctor" data-testid="doctor-tab" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">
                <span className="inline-flex items-center gap-1">
                  Doctor
                  {(preflightSeverity === 'blocker' || preflightSeverity === 'high') && !doctorDismissed && (
                    <span
                      data-testid="doctor-tab-dot"
                      className={cn('h-1.5 w-1.5 rounded-full', preflightSeverity === 'blocker' ? 'bg-destructive' : 'bg-warning')}
                    />
                  )}
                </span>
              </TabsTrigger>
            )}
            <TabsTrigger value="drift" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Drift</TabsTrigger>
            <TabsTrigger value="dossier" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Dossier</TabsTrigger>
            {envInventoryEnabled && (
              <TabsTrigger value="environment" data-testid="environment-tab" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Environment</TabsTrigger>
            )}
            {composeLabelsEnabled && (
              <TabsTrigger value="compose-labels" data-testid="compose-labels-tab" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Compose Labels</TabsTrigger>
            )}
            {networkingEnabled && (
              <TabsTrigger value="networking" data-testid="networking-tab" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Networking</TabsTrigger>
            )}
            {storageEnabled && (
              <TabsTrigger value="storage" data-testid="storage-tab" className="py-1 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">Storage</TabsTrigger>
            )}
          </TabsList>
        </ScrollableTabRow>
        <div className="flex items-center gap-3 shrink-0">
          {onOpenFiles && (
            <button
              type="button"
              data-testid="anatomy-files-btn"
              onClick={onOpenFiles}
              className="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors"
            >
              <FolderOpen className="h-3 w-3" strokeWidth={1.5} />
              files
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              data-testid="anatomy-edit-compose-btn"
              onClick={onEditCompose}
              className="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors"
            >
              <Pencil className="h-3 w-3" strokeWidth={1.5} />
              Edit compose
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
          <div className="py-3 font-mono text-xs text-stat-subtitle">Unable to parse compose.yaml.</div>
        ) : (
          <>
            <Row label="services">
              {anatomy.services.length === 0 ? (
                <span className="text-stat-subtitle">none defined</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {anatomy.services.map(s => (
                    <span key={s} className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-xs text-brand">
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
                <div className="flex flex-col gap-0.5 font-mono text-xs">
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
                <div className="flex flex-col gap-0.5 font-mono text-xs">
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
              <span className="font-mono text-xs">{anatomy.restart ?? <span className="text-stat-subtitle">default</span>}</span>
            </Row>
            <Row label="env_file">
              {!firstEnvFile ? (
                <span className="text-stat-subtitle">none</span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  <div className="font-mono text-xs">
                    <span className="text-foreground/90">{firstEnvFile}</span>
                    <span className="text-stat-subtitle"> · {envVarCount} var{envVarCount === 1 ? '' : 's'}</span>
                  </div>
                  {missingVars.length > 0 && (
                    <div className="flex flex-wrap gap-1 font-mono text-xs text-destructive">
                      {missingVars.map(v => (
                        <span key={v}>{'${'}{v}{'}'} missing</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Row>
            <Row label="network">
              <span className="font-mono text-xs">{networkName} <span className="text-stat-subtitle">· bridge</span></span>
            </Row>
            <Row label="source">
              <button
                type="button"
                onClick={onOpenGitSource}
                aria-label="Git Source"
                className="inline-flex items-center gap-1.5 font-mono text-xs text-left hover:text-brand transition-colors"
              >
                <GitBranch className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                {activeGitSource ? (
                  <span className="truncate">git <span className="text-stat-subtitle">·</span> {formatGitSource(activeGitSource)}</span>
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
        {showCheckStatusBanner && updatePreview && (
          <div
            data-testid="update-check-status-banner"
            className="mt-3 mb-3 rounded-lg border border-warning/40 bg-warning/[0.06] p-3 text-warning"
            role="status"
          >
            <div className="font-mono text-xs uppercase tracking-wide">
              {previewCheckStatus === 'failed' ? 'Update check failed' : 'Update check incomplete'}
            </div>
            <div className="mt-1 font-mono text-xs text-foreground/80 leading-relaxed">
              {verificationError
                ?? (previewCheckStatus === 'failed'
                  ? 'Registry checks could not verify image status. Retained update indicators may be stale.'
                  : 'Some image checks did not complete. Status is uncertain until a full check succeeds.')}
            </div>
          </div>
        )}
        {showUpdateBanner && updatePreview && (
          <div data-testid="update-available-banner" className={cn('mt-3 mb-3 rounded-lg border p-3', bannerTone)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-xs uppercase tracking-wide">
                  {hasBuildServices && !hasUpdate ? 'Rebuild available' : 'Update available'}
                </div>
                {updatedImages.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {updatedImages.map((img) => (
                      <li key={img.service} className="flex min-w-0 items-baseline gap-2 font-mono text-xs text-foreground">
                        <span className="min-w-0 truncate text-foreground/90">{imageName(img.image)}</span>
                        {img.current_tag && (
                          <span className="shrink-0 text-foreground/80">
                            <span className="text-stat-subtitle">{img.current_tag}</span>
                            {img.next_tag && img.next_tag !== img.current_tag && (
                              <>
                                {' -> '}
                                <span className="font-semibold">{img.next_tag}</span>
                              </>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-1 font-mono text-xs text-foreground/80 leading-relaxed">
                  {/* The tooltip belongs to the digest-rebuild lead-in only: when a
                      review hold or tag advisory overrides bannerLeadIn, render the
                      plain joined line so the hint never rides on other copy. */}
                  {updateKind === 'digest' && hasUpdate && bannerLeadIn === 'same-tag digest rebuild' ? (
                    <>
                      {bumpLabel && <span>{bumpLabel} · </span>}
                      <span title={DIGEST_REBUILD_HINT}>{bannerLeadIn}</span>
                      {bannerTailSegments.length > 0 && <span> · {bannerTailSegments.join(' · ')}</span>}
                    </>
                  ) : (
                    [bumpLabel, bannerLeadIn, ...bannerTailSegments].filter(Boolean).join(' · ')
                  )}
                </div>
                {blocked && updatePreview.summary.blocked_reason && (
                  <div className="mt-1 font-mono text-[10px] text-destructive">{updatePreview.summary.blocked_reason}</div>
                )}
              </div>
              {canEdit && !blocked && canApplyPreview && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={applying}
                  className={cn('shrink-0 h-7 gap-1', applyBtnTone)}
                  onClick={onApplyUpdate}
                >
                  <Rocket className={cn('h-3 w-3', applying && 'animate-pulse')} strokeWidth={1.5} />
                  {applyLabel}
                </Button>
              )}
            </div>
          </div>
        )}
        {scanStatus && scanStatus.status && scanStatus.status !== 'ok' && !scanBannerDismissed && (
          <div
            className="mx-3 my-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-2 py-1.5 text-xs text-warning"
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
            <button
              type="button"
              className="shrink-0 ml-2 p-0.5 rounded hover:bg-warning/10 transition-colors"
              onClick={dismissScanBanner}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
      {anatomy && anatomy.services.length > 0 && (
        <div className="border-t border-muted px-3 py-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">
            {Object.keys(anatomy.ports).length > 0 ? 'exposed' : 'no ports'}
          </span>
          {primaryHostPort !== null && (
            primaryServiceUrl ? (
              <a
                href={primaryServiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[10px] text-stat-subtitle hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                :{primaryHostPort}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-stat-subtitle">
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                :{primaryHostPort}
              </span>
            )
          )}
        </div>
      )}
      </TabsContent>
      <TabsContent value="drift" className="flex flex-col flex-1 min-h-0 mt-0">
        <DriftPanel stackName={stackName} />
      </TabsContent>
      <TabsContent value="dossier" className="flex flex-col flex-1 min-h-0 mt-0">
        <StackDossierPanel stackName={stackName} anatomy={anatomyInput} canEdit={canEdit} />
      </TabsContent>
      {doctorEnabled && (
        <TabsContent value="doctor" className="flex flex-col flex-1 min-h-0 mt-0">
          <PreflightPanel stackName={stackName} canEdit={canEdit} />
        </TabsContent>
      )}
      {networkingEnabled && (
        <TabsContent value="networking" className="flex flex-col flex-1 min-h-0 mt-0">
          <StackNetworkingPanel stackName={stackName} canEdit={canEdit} doctorEnabled={doctorEnabled} />
        </TabsContent>
      )}
      {envInventoryEnabled && (
        <TabsContent value="environment" className="flex flex-col flex-1 min-h-0 mt-0">
          <EnvironmentPanel stackName={stackName} />
        </TabsContent>
      )}
      {composeLabelsEnabled && (
        <TabsContent value="compose-labels" className="flex flex-col flex-1 min-h-0 mt-0">
          <ComposeLabelsPanel stackName={stackName} />
        </TabsContent>
      )}
      {storageEnabled && (
        <TabsContent value="storage" className="flex flex-col flex-1 min-h-0 mt-0">
          <StoragePanel stackName={stackName} />
        </TabsContent>
      )}
      </Tabs>
    </div>
  );
}
