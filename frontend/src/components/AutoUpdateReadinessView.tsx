import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Shield, AlertTriangle, ShieldAlert, CircleSlash, Clock, Play, CalendarClock, Monitor, Globe } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch, fetchForNode } from '@/lib/api';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { ImageUpdateStatus, StackUpdateInfo } from '@/types/imageUpdates';
import { isAuthoritativeNegativePreview } from '@/types/imageUpdates';
import { fetchUpdatePreview } from '@/lib/fetchUpdatePreview';
import {
  isActionableUpdatePreview,
  isClearedUpdatePreview,
  isLegacyPreview,
  isPreviewUncertain,
  isReviewRequiredUpdatePreview,
  isServiceApplyActionable,
  isTagOnlyAdvisory,
  isVerificationOnlyPreview,
} from '@/lib/updatePreviewActionability';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, Kicker } from '@/components/mobile/mobile-ui';
import { ImageSourceMenu } from './ImageSourceMenu';
import type { ScheduledTask } from '@/types/scheduling';
import { SERVICE_SCOPED_UPDATE_CAPABILITY } from '@/lib/capabilities';
import { requestServiceUpdate } from '@/lib/serviceUpdate';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';

type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

interface UpdatePreviewImage {
  service: string;
  image: string;
  current_tag: string;
  next_tag: string | null;
  has_update: boolean;
  digest_update?: boolean;
  tag_update?: boolean;
  semver_bump: SemverBump;
  /** Absent on older remotes; backend uses !== 'not_checkable' for checkability. */
  check_status?: 'ok' | 'partial' | 'failed' | 'not_checkable';
  check_error?: string | null;
  /** This image's own digest-comparison failure; not masked by a confirmed tag update. */
  digest_error?: string | null;
}

type UpdateKind = 'tag' | 'digest' | 'none';

interface UpdatePreview {
  stack_name: string;
  images: UpdatePreviewImage[];
  summary: {
    has_update: boolean;
    primary_image: string | null;
    current_tag: string | null;
    next_tag: string | null;
    semver_bump: SemverBump;
    update_kind: UpdateKind;
    blocked: boolean;
    blocked_reason: string | null;
    has_build_services?: boolean;
    rebuild_available?: boolean;
    /** Absent on older remotes; treat missing as non-authoritative. */
    check_status?: 'ok' | 'partial' | 'failed';
    verification_failed?: boolean;
    verification_error?: string | null;
  };
  build_services?: string[];
  rollback_target: string | null;
  changelog: string | null;
}

function declaredServiceCount(preview: UpdatePreview | null | undefined): number {
  if (!preview) return 0;
  const names = new Set<string>();
  for (const img of preview.images) names.add(img.service);
  for (const name of preview.build_services ?? []) names.add(name);
  return names.size;
}

/** Append `: reason` when present, otherwise end the lead-in with a period. */
function withErrorDetail(lead: string, error: string | null | undefined): string {
  return error ? `${lead}: ${error}` : `${lead}.`;
}

export interface StackCard {
  stack: string;
  nodeId: number;
  preview: UpdatePreview | null;
  previewLoaded: boolean;
  scheduledTask: ScheduledTask | null;
  applying: boolean;
  // True when at least one enabled action='update' scheduled task covers this
  // stack on this node (per-stack row or fleet row). Drives the Auto: Off pill
  // and the hero "ready to apply automatically" count. Manual Apply now is
  // schedule-independent and does not read this field.
  autoUpdateEnabled: boolean;
  // Name of the service currently applying a per-service update on this card,
  // or null when none is in flight. Distinct from `applying` (full-stack).
  applyingService: string | null;
  // Post-Apply verification note when Compose succeeded but clearance could
  // not be confirmed (distinct from a failed preview fetch).
  verificationNote: string | null;
}

interface NodeGroup {
  nodeId: number;
  nodeName: string;
  nodeType: 'local' | 'remote';
  cards: StackCard[];
}

interface FleetUpdateResponse {
  [nodeId: string]: Record<string, boolean>;
}

/**
 * Detection-cadence status for the control instance's scanner, shown by the
 * readiness card: when the last registry check ran, when the next is due, and
 * how long the manual-recheck cooldown has left (ticking once a second).
 */
export function CadenceStrip({ cadence, className }: { cadence: ImageUpdateStatus | null; className?: string }) {
  const [remainingMs, setRemainingMs] = useState(0);
  useEffect(() => {
    setRemainingMs(cadence?.manualCooldownRemainingMs ?? 0);
  }, [cadence]);
  const cooling = remainingMs > 0;
  useEffect(() => {
    if (!cooling) return;
    const id = setInterval(() => setRemainingMs(prev => Math.max(0, prev - 1000)), 1000);
    return () => clearInterval(id);
  }, [cooling]);

  if (!cadence) return null;

  const checksOff = cadence.enabled === false;
  const lastChecked = cadence.lastCheckedAt != null ? formatTimeAgo(cadence.lastCheckedAt) : 'never';
  const nextCheck = checksOff
    ? 'disabled'
    : cadence.checking
      ? 'checking now'
      : cadence.nextCheckAt != null
        ? formatRelative(cadence.nextCheckAt)
        : 'not scheduled';
  const cooldown = checksOff
    ? 'Detection off'
    : cooling
      ? `Recheck available in ${Math.ceil(remainingMs / 1000)}s`
      : 'Recheck ready';

  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-stat-subtitle/90 ${className ?? ''}`}>
      <span>Last checked {lastChecked}</span>
      <span aria-hidden="true">·</span>
      <span>Next check {nextCheck}</span>
      <span aria-hidden="true">·</span>
      <span>{cooldown}</span>
    </div>
  );
}

function formatRelative(ts: number | null): string {
  if (ts == null) return '';
  const delta = ts - Date.now();
  if (delta <= 0) return 'due now';
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

function formatClock(ts: number | null): string {
  if (ts == null) return '';
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function RiskBadge({
  bump,
  blocked,
  reviewRequired,
  uncertain,
  tagOnly,
}: {
  bump: SemverBump;
  blocked: boolean;
  reviewRequired?: boolean;
  uncertain?: boolean;
  tagOnly?: boolean;
}) {
  if (blocked || bump === 'major') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-destructive">
        <ShieldAlert className="h-3 w-3" strokeWidth={1.5} />
        Blocked · major
      </span>
    );
  }
  if (reviewRequired) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-warning">
        <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
        Review · unverified
      </span>
    );
  }
  if (uncertain) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-warning">
        <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
        Check uncertain
      </span>
    );
  }
  if (tagOnly) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
        Newer tag · edit Compose
      </span>
    );
  }
  if (bump === 'minor') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-warning">
        <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
        Review · minor
      </span>
    );
  }
  if (bump === 'patch') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-success">
        <Shield className="h-3 w-3" strokeWidth={1.5} />
        Safe · patch
      </span>
    );
  }
  if (bump === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
        Digest rebuild
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
      None
    </span>
  );
}

function VersionDiff({ current, next }: { current: string | null; next: string | null }) {
  if (!current) return null;
  const changed = next && next !== current;
  return (
    <div className="flex items-baseline gap-2 font-mono text-sm">
      <span className="text-stat-subtitle">{current}</span>
      <span className="text-stat-subtitle/60">→</span>
      <span className={changed ? 'text-brand font-medium' : 'text-stat-subtitle'}>
        {next ?? current}
      </span>
    </div>
  );
}

function StackReadinessCard({
  card,
  canServiceUpdate = false,
  onApply,
  onApplyService,
}: {
  card: StackCard;
  canServiceUpdate?: boolean;
  onApply: (stack: string, nodeId: number) => void;
  onApplyService?: (stack: string, nodeId: number, serviceName: string) => void;
}) {
  const { stack, nodeId, preview, previewLoaded, scheduledTask, applying, applyingService, autoUpdateEnabled, verificationNote } = card;
  const loading = !previewLoaded;
  const uncertain = previewLoaded && !!verificationNote;
  const failed = previewLoaded && preview === null && !verificationNote;
  const blocked = preview?.summary.blocked ?? false;
  const bump = preview?.summary.semver_bump ?? 'none';
  const updatingImages = preview?.images.filter(i => i.has_update) ?? [];
  const updatingImageCount = updatingImages.length;
  // Multi-service only: count declared Compose services (image-backed and
  // build-only), not preview.images.length (shared tags collapse that list).
  const showServiceApply = canServiceUpdate && declaredServiceCount(preview) > 1 && updatingImageCount > 0;
  const nextRun = scheduledTask?.next_run_at ?? null;
  const verificationOnly = isVerificationOnlyPreview(preview);
  const reviewRequired = isReviewRequiredUpdatePreview(preview);
  // Full-stack apply is held for review when another image in the same stack
  // failed digest verification: applying would pull/recreate that image as
  // collateral. Per-service apply targets only images with their own confirmed
  // update, so it is not gated by a different image's verification failure.
  const applyDisabled = !isActionableUpdatePreview(preview)
    || applying
    || applyingService !== null;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle/80">
            Stack
          </span>
          <span className="font-heading text-2xl leading-tight tracking-tight text-stat-value truncate">
            {stack}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!autoUpdateEnabled && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
              <CircleSlash className="h-3 w-3" strokeWidth={1.5} />
              Auto: Off
            </span>
          )}
          {previewLoaded && preview && (
            <RiskBadge
              bump={bump}
              blocked={blocked}
              reviewRequired={reviewRequired}
              uncertain={isPreviewUncertain(preview)}
              tagOnly={isTagOnlyAdvisory(preview)}
            />
          )}
        </div>
      </div>

      {loading ? (
        <div className="font-mono text-xs text-stat-subtitle/80">Checking registry...</div>
      ) : uncertain ? (
        <div className="font-mono text-xs text-warning">
          {verificationNote}
        </div>
      ) : failed ? (
        <div className="font-mono text-xs text-destructive/80">
          Preview failed. Registry may be unreachable.
        </div>
      ) : (
        (() => {
          const p = preview!;
          const blockedReason = p.summary.blocked_reason;
          const verificationFailed = Boolean(p.summary.verification_failed);
          const verificationError = p.summary.verification_error;
          let applyTitle: string | undefined;
          if (blocked) applyTitle = blockedReason ?? undefined;
          else if (verificationOnly) applyTitle = 'Digest verification failed';
          else if (reviewRequired) applyTitle = 'Another image in this stack failed digest verification; apply the confirmed service individually or resolve verification first.';

          let headline: ReactNode;
          if (verificationFailed && !p.summary.has_update) {
            headline = (
              <div className="font-mono text-xs text-warning" data-testid="readiness-verification-failed">
                {withErrorDetail('Digest verification failed', verificationError)}
              </div>
            );
          } else if (p.summary.update_kind === 'digest') {
            headline = (
              <div className="flex items-baseline gap-2 font-mono text-sm">
                <span className="text-stat-subtitle">{p.summary.current_tag}</span>
                <span className="text-brand text-[10px] leading-3 uppercase tracking-[0.18em]">
                  Rebuild available
                </span>
              </div>
            );
          } else {
            headline = (
              <VersionDiff
                current={p.summary.current_tag}
                next={p.summary.next_tag}
              />
            );
          }

          return (
            <>
              {headline}
              {verificationFailed && p.summary.has_update && (
                <div className="font-mono text-[11px] text-warning" data-testid="readiness-verification-warning">
                  {withErrorDetail('Digest check could not be verified', verificationError)}
                </div>
              )}

              <div className="flex items-center gap-1.5 font-mono text-[11px] text-stat-subtitle/80">
                <span>{p.summary.primary_image ?? '-'}</span>
                {updatingImageCount > 1 && (
                  <span className="text-stat-subtitle/60">
                    · {updatingImageCount} services
                  </span>
                )}
                <ImageSourceMenu imageRef={p.summary.primary_image} />
              </div>

              <div className="border-t border-dashed border-card-border pt-3 text-xs text-stat-subtitle/90 leading-relaxed">
                {p.changelog ?? 'No changelog available from the registry yet.'}
              </div>

              {blocked && blockedReason && (
                <div className="rounded border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive/90">
                  {blockedReason}
                </div>
              )}

              {showServiceApply && (
                <div className="flex flex-col gap-1.5 rounded-md border border-card-border bg-muted/20 p-2">
                  {updatingImages.map(img => (
                    <div key={img.service} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-stat-subtitle">{img.service}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 gap-1 rounded-md px-2 text-[11px]"
                        onClick={() => onApplyService?.(stack, nodeId, img.service)}
                        disabled={blocked || applying || applyingService !== null || !isServiceApplyActionable(preview, img.service)}
                      >
                        {applyingService === img.service ? 'Applying...' : 'Apply'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-stat-subtitle">
                  {nextRun ? (
                    <>
                      <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                      <span>Scheduled · <span className="text-stat-value">{formatClock(nextRun)}</span></span>
                      <span className="text-stat-subtitle/70">· {formatRelative(nextRun)}</span>
                    </>
                  ) : (
                    <>
                      <Clock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                      <span>No schedule</span>
                    </>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => onApply(stack, nodeId)}
                  disabled={applyDisabled}
                  title={applyTitle}
                  className="gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                  {applying ? 'Applying...' : 'Apply now'}
                </Button>
              </div>
            </>
          );
        })()
      )}
    </Card>
  );
}

function ReadinessHero({
  total,
  ready,
  nodeCount,
  refreshing,
  onRefresh,
  canRefresh,
  unresolvedChecks = false,
  detectionDisabled = false,
}: {
  total: number;
  ready: number;
  nodeCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  canRefresh: boolean;
  unresolvedChecks?: boolean;
  detectionDisabled?: boolean;
}) {
  const headline = detectionDisabled
    ? 'Image update detection disabled'
    : total === 0
      ? (unresolvedChecks ? 'No verified updates' : 'Everything is up to date')
      : total === 1
        ? '1 update pending'
        : `${total} updates pending`;
  const acrossNodes = nodeCount > 1
    ? ` across ${nodeCount} nodes`
    : nodeCount === 1
      ? ' across 1 node'
      : '';

  return (
    <div className="relative overflow-hidden rounded-lg border border-brand/25 border-t-brand/35 bg-card shadow-card-bevel">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.10] via-brand/[0.02] to-transparent" />
      <div className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
      <div className="relative grid grid-cols-[1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-brand">
            Fleet readiness
          </span>
          <span className="font-heading text-3xl leading-tight tracking-tight text-stat-value">
            {headline}
          </span>
          {total > 0 && (
            <span className="font-mono text-[11px] text-stat-subtitle/90">
              {ready} of {total} ready to apply automatically{acrossNodes}
              {total - ready > 0 ? ` · ${total - ready} need a schedule or review` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {total > 0 && (
            <div className="text-right">
              <div className="font-mono tabular-nums text-2xl text-stat-value">
                {ready}<span className="text-stat-subtitle/60"> / {total}</span>
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                Ready
              </div>
            </div>
          )}
          {canRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Recheck registries"
              className="gap-2"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
                strokeWidth={1.5}
                aria-hidden="true"
              />
              Recheck
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeGroupSection({
  group,
  canServiceUpdate,
  onApply,
  onApplyService,
}: {
  group: NodeGroup;
  canServiceUpdate: boolean;
  onApply: (stack: string, nodeId: number) => void;
  onApplyService: (stack: string, nodeId: number, serviceName: string) => void;
}) {
  const TypeIcon = group.nodeType === 'local' ? Monitor : Globe;
  const stackCount = group.cards.length;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3 border-b border-card-border/60 pb-2">
        <TypeIcon className="h-4 w-4 text-stat-subtitle self-center" strokeWidth={1.5} aria-hidden="true" />
        <span className="font-heading text-xl leading-tight tracking-tight text-stat-value truncate">
          {group.nodeName}
        </span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0 self-center">
          {group.nodeType}
        </Badge>
        <span className="font-mono text-[11px] text-stat-subtitle/80">
          {stackCount} {stackCount === 1 ? 'stack' : 'stacks'}
        </span>
      </div>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
        {group.cards.map(card => (
          <StackReadinessCard
            key={`${card.nodeId}::${card.stack}`}
            card={card}
            canServiceUpdate={canServiceUpdate}
            onApply={onApply}
            onApplyService={onApplyService}
          />
        ))}
      </div>
    </section>
  );
}

// --- mobile (<md) bespoke pieces ---------------------------------------------

/** One-up readiness card for the phone screen. Reuses RiskBadge + VersionDiff
 *  and the same apply/disabled logic as the desktop card. Exported for tests. */
export function MobileReadinessCard({
  card,
  canServiceUpdate = false,
  onApply,
  onApplyService,
}: {
  card: StackCard;
  canServiceUpdate?: boolean;
  onApply: (stack: string, nodeId: number) => void;
  onApplyService?: (stack: string, nodeId: number, serviceName: string) => void;
}) {
  const { stack, nodeId, preview, previewLoaded, scheduledTask, applying, applyingService, autoUpdateEnabled, verificationNote } = card;
  const uncertain = previewLoaded && !!verificationNote;
  const failed = previewLoaded && preview === null && !verificationNote;
  const blocked = preview?.summary.blocked ?? false;
  const bump = preview?.summary.semver_bump ?? 'none';
  const updatingImages = preview?.images.filter(i => i.has_update) ?? [];
  const showServiceApply = canServiceUpdate && declaredServiceCount(preview) > 1 && updatingImages.length > 0;
  const nextRun = scheduledTask?.next_run_at ?? null;
  const verificationOnly = isVerificationOnlyPreview(preview);
  const reviewRequired = isReviewRequiredUpdatePreview(preview);
  const applyDisabled = !isActionableUpdatePreview(preview)
    || applying
    || applyingService !== null;
  const changelog = preview?.changelog ?? 'No changelog available from the registry yet.';
  const dot = changelog.indexOf('.');
  const lead = dot > 0 ? changelog.slice(0, dot + 1) : '';
  const rest = dot > 0 ? changelog.slice(dot + 1) : changelog;

  return (
    <div className="flex flex-col gap-[10px] rounded-xl border border-card-border border-t-card-border-top bg-card p-[14px] shadow-card-bevel">
      <div className="flex items-start justify-between gap-[10px]">
        <div className="min-w-0 flex-1">
          <Kicker>stack</Kicker>
          <div className="mt-px truncate font-heading text-[23px] leading-[26px] text-stat-value">{stack}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!autoUpdateEnabled && (
            <span className="inline-flex items-center gap-1 rounded-full border border-card-border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.1em] text-stat-subtitle">
              <CircleSlash className="h-3 w-3" strokeWidth={1.5} />Auto: Off
            </span>
          )}
          {previewLoaded && preview && (
            <RiskBadge
              bump={bump}
              blocked={blocked}
              reviewRequired={reviewRequired}
              uncertain={isPreviewUncertain(preview)}
              tagOnly={isTagOnlyAdvisory(preview)}
            />
          )}
        </div>
      </div>

      {!previewLoaded ? (
        <div className="font-mono text-xs text-stat-subtitle/80">Checking registry...</div>
      ) : uncertain ? (
        <div className="font-mono text-xs text-warning">{verificationNote}</div>
      ) : failed ? (
        <div className="font-mono text-xs text-destructive/80">Preview failed. Registry may be unreachable.</div>
      ) : (() => {
        const p = preview!;
        const verificationFailed = Boolean(p.summary.verification_failed);
        const verificationError = p.summary.verification_error;

        let headline: ReactNode;
        if (verificationFailed && !p.summary.has_update) {
          headline = (
            <div className="font-mono text-xs text-warning" data-testid="readiness-verification-failed">
              {withErrorDetail('Digest verification failed', verificationError)}
            </div>
          );
        } else if (p.summary.update_kind === 'digest') {
          headline = (
            <div className="flex items-baseline gap-2 font-mono text-[13px]">
              <span className="text-stat-subtitle">{p.summary.current_tag}</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-brand">Rebuild available</span>
            </div>
          );
        } else {
          headline = <VersionDiff current={p.summary.current_tag} next={p.summary.next_tag} />;
        }

        return (
          <>
            {headline}
            {verificationFailed && p.summary.has_update && (
              <div className="font-mono text-[11px] text-warning" data-testid="readiness-verification-warning">
                {withErrorDetail('Digest check could not be verified', verificationError)}
              </div>
            )}
            <div className="truncate font-mono text-[11px] text-stat-subtitle">{p.summary.primary_image ?? '-'}</div>
            <div className="border-t border-dashed border-card-border pt-[9px] text-[12.5px] leading-[18px] text-stat-subtitle">
              {lead && <b className="text-stat-title">{lead}</b>}{rest}
            </div>
            {showServiceApply && (
              <div className="flex flex-col gap-1.5 rounded-md border border-card-border bg-muted/20 p-2">
                {updatingImages.map(img => (
                  <div key={img.service} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-stat-subtitle">{img.service}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 rounded-md px-2 text-[11px]"
                      onClick={() => onApplyService?.(stack, nodeId, img.service)}
                      disabled={blocked || applying || applyingService !== null || !isServiceApplyActionable(preview, img.service)}
                    >
                      {applyingService === img.service ? 'Applying...' : 'Apply'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-[10px] pt-0.5">
              <span className={`font-mono text-[11px] ${blocked || reviewRequired ? 'text-destructive' : 'text-stat-subtitle'}`}>
                {nextRun ? <>{formatClock(nextRun)} · {formatRelative(nextRun)}</> : (blocked || reviewRequired ? 'Held for review' : 'No schedule')}
              </span>
              <Button
                size="sm"
                variant={blocked || verificationOnly || reviewRequired ? 'outline' : 'default'}
                onClick={() => onApply(stack, nodeId)}
                disabled={applyDisabled}
                title={reviewRequired ? 'Another image in this stack failed digest verification; apply the confirmed service individually or resolve verification first.' : undefined}
                className="gap-1.5"
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                {applying ? 'Applying...' : 'Apply now'}
              </Button>
            </div>
          </>
        );
      })()}
    </div>
  );
}

function MobileNodeSection({
  group,
  canServiceUpdate,
  onApply,
  onApplyService,
}: {
  group: NodeGroup;
  canServiceUpdate: boolean;
  onApply: (stack: string, nodeId: number) => void;
  onApplyService: (stack: string, nodeId: number, serviceName: string) => void;
}) {
  return (
    <section>
      <div className="mb-[13px] flex items-baseline gap-2 border-b border-hairline pb-2">
        <span className="truncate font-heading text-[19px] leading-tight text-stat-value">{group.nodeName}</span>
        <span className="shrink-0 rounded-[5px] border border-card-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.1em] text-stat-subtitle">{group.nodeType}</span>
        <span className="shrink-0 font-mono text-[11px] text-stat-icon">{group.cards.length} {group.cards.length === 1 ? 'stack' : 'stacks'}</span>
      </div>
      <div className="flex flex-col gap-3">
        {group.cards.map(card => (
          <MobileReadinessCard
            key={`${card.nodeId}::${card.stack}`}
            card={card}
            canServiceUpdate={canServiceUpdate}
            onApply={onApply}
            onApplyService={onApplyService}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Advisory for local-node stacks whose latest image-update check could not
 * determine status. These never appear in the card grid (which lists only
 * confirmed updates), so without this they would be invisible here.
 */
function CheckFailuresNotice({ failures }: { failures: { stack: string; reason: string | null }[] }) {
  if (failures.length === 0) return null;
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
      <div className="flex items-center gap-2 font-mono text-[11px] text-warning">
        <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        {failures.length} stack{failures.length !== 1 ? 's' : ''} could not be checked
      </div>
      <ul className="mt-1.5 space-y-0.5 pl-5">
        {failures.map(f => (
          <li key={f.stack} className="font-mono text-[11px] text-stat-subtitle">
            <span className="text-stat-value">{f.stack}</span>{f.reason ? `: ${f.reason}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface AutoUpdateReadinessProps {
  /** Notifications + more-menu cluster for the mobile masthead, rehomed from the dropped TopBar. */
  headerActions?: ReactNode;
}

function AutoUpdateReadinessContent({ headerActions }: AutoUpdateReadinessProps) {
  const isMobile = useIsMobile();
  const { runWithLog } = useDeployFeedback();
  const { can } = useAuth();
  const canRefreshFleet = can('node:manage');
  const { nodes, nodeMeta, refreshNodeMeta } = useNodes();
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  const [reachableNodeCount, setReachableNodeCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cadence, setCadence] = useState<ImageUpdateStatus | null>(null);
  // Local-node stacks whose latest check could not determine status. The fleet
  // list only shows stacks with a confirmed update, so without this a stack
  // whose checks all fail would silently vanish from this view.
  const [checkFailures, setCheckFailures] = useState<{ stack: string; reason: string | null }[]>([]);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token guards against stale setGroups from older fetches.
  const loadTokenRef = useRef(0);
  // Separate token for the cadence fetch: a slow initial /status must not
  // overwrite the fresher status a Recheck just loaded, and neither may set
  // state after unmount.
  const cadenceTokenRef = useRef(0);
  // Holds the latest nodes array so loadReadiness can reference it without
  // re-firing every time NodeContext rebuilds the array on a meta refresh.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Stable signature: only changes when membership or node identity actually
  // changes, not when NodeContext reissues the same logical list.
  const nodesSignature = useMemo(
    () => nodes.map(n => `${n.id}:${n.type}:${n.status}`).sort().join('|'),
    [nodes],
  );

  const localNodeId = useMemo(() => nodes.find(n => n.type === 'local')?.id ?? null, [nodes]);
  const onlineNodeCount = useMemo(() => nodes.filter(n => n.status === 'online').length, [nodes]);

  const loadReadiness = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    try {
      const [statusRes, tasksRes, detailRes] = await Promise.all([
        apiFetch('/image-updates/fleet', { localOnly: true }),
        apiFetch('/scheduled-tasks?action=update', { localOnly: true }),
        apiFetch('/image-updates/detail', { localOnly: true }),
      ]);
      if (token !== loadTokenRef.current) return;

      if (!statusRes.ok) {
        throw new Error('Failed to load fleet update status');
      }
      const fleetStatus = await statusRes.json() as FleetUpdateResponse;
      setReachableNodeCount(Object.keys(fleetStatus).length);

      // Local-node check failures: surfaced separately because the fleet map is
      // boolean and the card grid only lists stacks with a confirmed update.
      // Sticky has_update during a failed check is not a verified rebuild, so those
      // stacks stay in the advisory only.
      let failedLocalStacks = new Set<string>();
      if (detailRes.ok) {
        const detail = await detailRes.json() as Record<string, StackUpdateInfo>;
        const failures = Object.entries(detail)
          .filter(([, info]) => info.checkStatus === 'failed')
          .map(([stack, info]) => ({ stack, reason: info.lastError }))
          .sort((a, b) => a.stack.localeCompare(b.stack));
        failedLocalStacks = new Set(failures.map(f => f.stack));
        setCheckFailures(failures);
      } else {
        // Clear stale failures rather than persist them across a load, but log:
        // an empty advisory must not silently stand in for "detail unavailable".
        console.error('[AutoUpdateReadiness] /image-updates/detail failed:', detailRes.status);
        setCheckFailures([]);
      }

      const tasks: ScheduledTask[] = tasksRes.ok ? await tasksRes.json() : [];
      // A stack is "covered" by an enabled action='update' row when either
      // a per-stack row targets it or a fleet row targets its node. We pick
      // the earliest next-run covering task so the readiness card renders
      // the next-run time accurately for both shapes.
      const taskByNodeStack = new Map<string, ScheduledTask>();
      const fleetTaskByNode = new Map<number, ScheduledTask>();
      for (const t of tasks) {
        if (!t.enabled) continue;
        // The fetch URL filters on action=update; this guard makes the
        // coverage check robust against a future regression there.
        if (t.action !== 'update') continue;
        const taskNodeId = t.node_id ?? localNodeId;
        if (taskNodeId == null) continue;
        if (t.target_type === 'fleet') {
          const existing = fleetTaskByNode.get(taskNodeId);
          if (!existing || (t.next_run_at ?? Infinity) < (existing.next_run_at ?? Infinity)) {
            fleetTaskByNode.set(taskNodeId, t);
          }
        } else if (t.target_type === 'stack' && t.target_id) {
          const key = `${taskNodeId}::${t.target_id}`;
          const existing = taskByNodeStack.get(key);
          if (!existing || (t.next_run_at ?? Infinity) < (existing.next_run_at ?? Infinity)) {
            taskByNodeStack.set(key, t);
          }
        }
      }

      const flatPairs: { nodeId: number; stack: string }[] = [];
      const initialGroups: NodeGroup[] = [];
      const currentNodes = nodesRef.current;
      for (const [nodeIdStr, stackMap] of Object.entries(fleetStatus)) {
        const nodeId = Number(nodeIdStr);
        const node = currentNodes.find(n => n.id === nodeId);
        if (!node) continue;
        const stacks = Object.entries(stackMap)
          .filter(([stack, hasUpdate]) =>
            hasUpdate && !(node.type === 'local' && failedLocalStacks.has(stack)),
          )
          .map(([stack]) => stack)
          .sort();
        if (stacks.length === 0) continue;
        const cards: StackCard[] = stacks.map(stack => {
          flatPairs.push({ nodeId, stack });
          const stackTask = taskByNodeStack.get(`${nodeId}::${stack}`) ?? null;
          const fleetTask = fleetTaskByNode.get(nodeId) ?? null;
          // Prefer whichever covering task fires next.
          // Earliest next-run wins; on a tie, the per-stack row beats the
          // fleet row so the user sees the more specific schedule.
          const scheduledTask = stackTask && fleetTask
            ? ((stackTask.next_run_at ?? Infinity) <= (fleetTask.next_run_at ?? Infinity) ? stackTask : fleetTask)
            : (stackTask ?? fleetTask);
          return {
            stack,
            nodeId,
            preview: null,
            previewLoaded: false,
            scheduledTask,
            applying: false,
            applyingService: null,
            autoUpdateEnabled: scheduledTask !== null,
            verificationNote: null,
          };
        });
        initialGroups.push({
          nodeId,
          nodeName: node.name,
          nodeType: node.type,
          cards,
        });
      }
      initialGroups.sort((a, b) => {
        if (a.nodeType !== b.nodeType) return a.nodeType === 'local' ? -1 : 1;
        return a.nodeName.localeCompare(b.nodeName);
      });

      if (token !== loadTokenRef.current) return;
      setGroups(initialGroups);
      // Resolve service-scoped-update capability for every node in this fleet
      // view (not just the active one) so per-service Apply can gate on each
      // card's own node; skips nodes whose meta is already cached.
      for (const g of initialGroups) {
        void refreshNodeMeta(g.nodeId);
      }

      const previews = await Promise.all(
        flatPairs.map(async ({ nodeId, stack }) => {
          try {
            const result = await fetchUpdatePreview(stack, {
              fetchImpl: (path, init) => fetchForNode(path, nodeId, init),
            });
            if (!result.ok || !result.preview) return null;
            return result.preview as UpdatePreview;
          } catch {
            return null;
          }
        }),
      );
      if (token !== loadTokenRef.current) return;

      const previewByKey = new Map<string, UpdatePreview | null>();
      flatPairs.forEach((pair, idx) => {
        previewByKey.set(`${pair.nodeId}::${pair.stack}`, previews[idx]);
      });

      const previewAdvisory: { stack: string; reason: string | null }[] = [];
      const groupsWithPreview = initialGroups
        .map(g => {
          const cards: StackCard[] = [];
          for (const c of g.cards) {
            const preview = previewByKey.get(`${c.nodeId}::${c.stack}`) ?? null;
            if (isVerificationOnlyPreview(preview)) {
              previewAdvisory.push({
                stack: g.nodeType === 'remote' ? `${c.stack} (${g.nodeName})` : c.stack,
                reason: preview?.summary.verification_error ?? 'Digest verification failed',
              });
              continue;
            }
            // Sticky fleet booleans can outlive a successful no-update preview.
            // Drop those cards without treating them as check failures.
            if (isClearedUpdatePreview(preview)) continue;
            // A legacy preview (missing verification_failed entirely) is kept
            // rather than cleared, but that alone renders as a pending card
            // with nothing to explain it; flag why in the advisory too. Skip
            // this when the preview is already actionable on its own terms
            // (the remote's own has_update/rebuild_available): the card
            // already speaks for itself, and pairing it with "could not be
            // checked" would contradict the Apply affordance right next to it.
            if (isLegacyPreview(preview) && !isActionableUpdatePreview(preview)) {
              previewAdvisory.push({
                stack: g.nodeType === 'remote' ? `${c.stack} (${g.nodeName})` : c.stack,
                reason: 'This node\'s preview predates digest verification reporting',
              });
            }
            cards.push({ ...c, preview, previewLoaded: true });
          }
          return { ...g, cards };
        })
        .filter(g => g.cards.length > 0);

      if (previewAdvisory.length > 0) {
        setCheckFailures(prev => {
          const byStack = new Map(prev.map(f => [f.stack, f]));
          for (const entry of previewAdvisory) {
            if (!byStack.has(entry.stack)) byStack.set(entry.stack, entry);
          }
          return [...byStack.values()].sort((a, b) => a.stack.localeCompare(b.stack));
        });
      }

      setGroups(groupsWithPreview);
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      toast.error((err as Error)?.message || 'Failed to load readiness');
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, [localNodeId, refreshNodeMeta]);

  // Detection-cadence status for the control instance (localOnly): the readiness
  // list is fleet-wide, but the cadence shown by the card is this instance's own
  // scanner, configured in Settings. Each node runs its own scanner.
  const loadCadence = useCallback(async () => {
    const token = ++cadenceTokenRef.current;
    try {
      const res = await apiFetch('/image-updates/status', { localOnly: true });
      if (!res.ok) return;
      const data = await res.json() as ImageUpdateStatus;
      // Drop the result if a newer cadence load started, or the view unmounted,
      // while this one was in flight.
      if (token === cadenceTokenRef.current) setCadence(data);
    } catch (e) {
      console.error('[AutoUpdate] failed to load image-update cadence status', e);
    }
  }, []);

  useEffect(() => {
    if (nodesSignature === '') return;
    loadReadiness();
    void loadCadence();
    return () => {
      // Invalidate any in-flight fetch and cancel pending refresh timers on unmount.
      loadTokenRef.current++;
      cadenceTokenRef.current++;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [loadReadiness, loadCadence, nodesSignature]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch('/image-updates/fleet/refresh', { method: 'POST', localOnly: true });
      if (!res.ok) {
        toast.error('Failed to trigger refresh');
        return;
      }
      const data = await res.json() as { triggered: number[]; rateLimited: number[]; failed: number[] };
      const tCount = data.triggered.length;
      const rCount = data.rateLimited.length;
      const fCount = data.failed.length;
      // Re-seed the cadence strip so the manual-cooldown countdown reflects the
      // recheck we just fired.
      void loadCadence();
      if (tCount > 0) {
        toast.success(`Rechecking ${tCount} ${tCount === 1 ? 'node' : 'nodes'}...`);
      }
      if (rCount > 0) {
        toast.warning(`${rCount} ${rCount === 1 ? 'node is' : 'nodes are'} rate-limited; try again shortly`);
      }
      if (fCount > 0) {
        toast.error(`${fCount} ${fCount === 1 ? 'node' : 'nodes'} failed to refresh`);
      }
      if (tCount === 0 && rCount === 0 && fCount === 0) {
        toast.info('No reachable nodes to refresh');
        return;
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        loadReadiness();
      }, 2500);
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to trigger refresh');
    } finally {
      setRefreshing(false);
    }
  }, [loadReadiness, loadCadence]);

  // Nodes that advertise service-scoped updates, resolved per node (not just
  // the active one) since this view spans the whole fleet.
  const serviceScopedNodeIds = useMemo(
    () => new Set(
      Array.from(nodeMeta.entries())
        .filter(([, meta]) => meta.capabilities.includes(SERVICE_SCOPED_UPDATE_CAPABILITY))
        .map(([id]) => id),
    ),
    [nodeMeta],
  );

  const handleApplyService = useCallback(async (stack: string, nodeId: number, serviceName: string) => {
    const setCardField = (predicate: (c: StackCard) => boolean, patch: Partial<StackCard>) =>
      setGroups(prev => prev.map(g => ({
        ...g,
        cards: g.cards.map(c => predicate(c) ? { ...c, ...patch } : c),
      })));

    setCardField(c => c.stack === stack && c.nodeId === nodeId, { applyingService: serviceName });
    const loadingId = toast.loading(`Applying update to "${serviceName}" in ${stack}...`);
    try {
      await runWithLog({ stackName: stack, action: 'update', nodeId, serviceName }, async (started, ds) => {
        await started;
        const result = await requestServiceUpdate({
          nodeId, stackName: stack, serviceName, mode: 'update', deploySessionId: ds,
        });
        if (!result.ok) {
          toast.error(result.error);
          return { ok: false as const, errorMessage: result.error };
        }
        if (result.recheckWarning) toast.info(result.recheckWarning);
        if (result.healthGateId && result.observing) {
          toast.info(`Service "${serviceName}" updated. Verifying health...`);
        } else {
          toast.success(`Service "${serviceName}" updated successfully`);
        }
        // Reload authoritative preview so summary / Apply affordances stay accurate.
        try {
          const result = await fetchUpdatePreview(stack, {
            fetchImpl: (path, init) => fetchForNode(path, nodeId, init),
          });
          if (result.ok && result.preview) {
            const next = result.preview as UpdatePreview;
            if (isAuthoritativeNegativePreview(next)) {
              setGroups(prev => prev
                .map(g => g.nodeId === nodeId
                  ? { ...g, cards: g.cards.filter(c => c.stack !== stack) }
                  : g)
                .filter(g => g.cards.length > 0));
            } else {
              setCardField(c => c.stack === stack && c.nodeId === nodeId, { preview: next, previewLoaded: true });
            }
          } else {
            console.error(`[AutoUpdateReadinessView] post-apply update-preview failed (${result.status})`);
          }
        } catch (err) {
          console.error('[AutoUpdateReadinessView] post-apply update-preview refresh failed', err);
        }
        return {
          ok: true as const,
          healthGateId: result.observing ? result.healthGateId : null,
          recoveryId: result.recoveryId,
        };
      });
    } catch (err) {
      toast.error((err as Error)?.message || 'Update failed');
    } finally {
      toast.dismiss(loadingId);
      setCardField(c => c.stack === stack && c.nodeId === nodeId, { applyingService: null });
    }
  }, [runWithLog]);

  const handleApply = useCallback(async (stack: string, nodeId: number) => {
    const setCardField = (predicate: (c: StackCard) => boolean, patch: Partial<StackCard>) =>
      setGroups(prev => prev.map(g => ({
        ...g,
        cards: g.cards.map(c => predicate(c) ? { ...c, ...patch } : c),
      })));
    const matchCard = (c: StackCard) => c.stack === stack && c.nodeId === nodeId;
    const removeCard = () => setGroups(prev => prev
      .map(g => g.nodeId === nodeId
        ? { ...g, cards: g.cards.filter(c => c.stack !== stack) }
        : g)
      .filter(g => g.cards.length > 0));
    const retainPreviewFailed = () => setCardField(matchCard, {
      applying: false,
      preview: null,
      previewLoaded: true,
      verificationNote: null,
    });
    const retainUncertain = (note: string) => setCardField(matchCard, {
      applying: false,
      preview: null,
      previewLoaded: true,
      verificationNote: note,
    });

    setCardField(matchCard, { applying: true, verificationNote: null });
    const loadingId = toast.loading(`Applying update to ${stack}...`);
    try {
      const res = await fetchForNode(
        `/stacks/${encodeURIComponent(stack)}/update`,
        nodeId,
        { method: 'POST' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Update failed' }));
        throw new Error(data.error ?? 'Update failed');
      }
      const body = await res.json().catch(() => ({})) as { recheckWarning?: unknown };
      const recheckWarning = typeof body.recheckWarning === 'string' ? body.recheckWarning : undefined;
      if (recheckWarning) toast.info(recheckWarning);
      else toast.success(`${stack} updated successfully`);

      // Authoritative live preview decides card removal. When it disagrees with
      // a backend recheckWarning (preview cleared, persisted check uncertain),
      // keep an uncertain card so Fleet does not diverge from the sidebar.
      try {
        const previewRes = await fetchForNode(
          `/stacks/${encodeURIComponent(stack)}/update-preview`,
          nodeId,
        );
        if (!previewRes.ok) {
          retainPreviewFailed();
          return;
        }
        const next = await previewRes.json() as UpdatePreview;
        if (typeof next?.summary?.has_update !== 'boolean') {
          retainPreviewFailed();
          return;
        }
        // Drop only when the live preview proves nothing remains (tag-only
        // advisories stay pending via isClearedUpdatePreview).
        const cleared = isAuthoritativeNegativePreview(next) || isClearedUpdatePreview(next);
        if (!cleared) {
          if (next.summary.has_update && !recheckWarning) {
            toast.info(
              'The update command completed, but Sencho still detects an available image update.',
            );
          }
          setCardField(matchCard, {
            applying: false,
            preview: next,
            previewLoaded: true,
            verificationNote: recheckWarning ?? null,
          });
          return;
        }
        if (recheckWarning) {
          retainUncertain(recheckWarning);
          return;
        }
        removeCard();
      } catch (previewErr) {
        console.error('[AutoUpdate] post-Apply preview reconciliation failed', previewErr);
        retainPreviewFailed();
      }
    } catch (err) {
      toast.error((err as Error)?.message || 'Update failed');
      setCardField(matchCard, { applying: false });
    } finally {
      toast.dismiss(loadingId);
    }
  }, []);

  const flatCards = useMemo(() => groups.flatMap(g => g.cards), [groups]);
  const { total, ready } = useMemo(() => {
    const t = flatCards.length;
    // Schedule-covered and actionable (confirmed update/rebuild, not blocked).
    const r = flatCards.filter(c =>
      c.autoUpdateEnabled
      && c.previewLoaded
      && c.preview !== null
      && isActionableUpdatePreview(c.preview),
    ).length;
    return { total: t, ready: r };
  }, [flatCards]);

  const showPartialBanner = reachableNodeCount != null
    && onlineNodeCount > 0
    && reachableNodeCount < onlineNodeCount;

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Masthead
          kicker="fleet · updates"
          state={cadence?.enabled === false
            ? 'Disabled'
            : total === 0
              ? (checkFailures.length > 0 ? 'No verified updates' : 'Up to date')
              : `${total} pending`}
          stateTone={cadence?.enabled === false
            ? 'brand'
            : total === 0 && checkFailures.length === 0 ? 'success' : 'warning'}
          live={total > 0 && cadence?.enabled !== false}
          meta={cadence?.enabled === false
            ? 'image update detection off'
            : total > 0
              ? `${ready} ready · ${total - ready} in review`
              : (checkFailures.length > 0 ? 'some checks unresolved' : 'all stacks current')}
          right={headerActions}
        />
        <div className="flex-1 min-h-0 overflow-y-auto p-4 [&>*+*]:mt-4">
          <div className="flex justify-end">
            {canRefreshFleet && (
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || cadence?.enabled === false} aria-label="Recheck registries" className="gap-1.5">
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.5} aria-hidden="true" />
                Recheck
              </Button>
            )}
          </div>
          <CadenceStrip cadence={cadence} />

          {showPartialBanner && (
            <div className="font-mono text-[11px] text-stat-subtitle">
              {reachableNodeCount} of {onlineNodeCount} nodes reachable. Unreachable nodes are not shown.
            </div>
          )}
          <CheckFailuresNotice failures={checkFailures} />
          {loading && groups.length === 0 ? (
            <div className="flex items-center justify-center py-16 font-mono text-xs text-stat-subtitle">Loading readiness...</div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-card-border bg-card/40 py-16 text-center">
              <Shield className={`h-8 w-8 ${checkFailures.length > 0 ? 'text-warning/70' : 'text-success/70'}`} strokeWidth={1.5} aria-hidden="true" />
              <div className="font-display italic text-xl text-stat-value">
                {cadence?.enabled === false
                  ? 'Detection disabled'
                  : checkFailures.length > 0 ? 'No verified updates pending' : 'All stacks on current builds'}
              </div>
              <div className="font-mono text-[11px] text-stat-subtitle">
                {cadence?.enabled === false
                  ? 'Turn image update checks back on in Settings when Sencho should monitor registries again.'
                  : checkFailures.length > 0
                    ? 'Review the unresolved checks above, then recheck.'
                    : 'Sencho rechecks registries on the configured interval.'}
              </div>
            </div>
          ) : (
            groups.map(group => (
              <MobileNodeSection
                key={group.nodeId}
                group={group}
                canServiceUpdate={serviceScopedNodeIds.has(group.nodeId)}
                onApply={handleApply}
                onApplyService={handleApplyService}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto w-full">
      <ReadinessHero
        total={total}
        ready={ready}
        nodeCount={groups.length}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        canRefresh={canRefreshFleet}
        unresolvedChecks={checkFailures.length > 0}
        detectionDisabled={cadence?.enabled === false}
      />

      <CadenceStrip cadence={cadence} className="-mt-3 pl-7" />

      {showPartialBanner && (
        <div className="font-mono text-[11px] text-stat-subtitle/90 -mt-3 pl-7">
          {reachableNodeCount} of {onlineNodeCount} nodes reachable. Unreachable nodes are not shown.
        </div>
      )}

      <CheckFailuresNotice failures={checkFailures} />

      {loading && groups.length === 0 ? (
        <div className="flex items-center justify-center py-16 font-mono text-xs text-stat-subtitle">
          Loading readiness...
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-card-border bg-card/40 py-16">
          <Shield className={`h-8 w-8 ${checkFailures.length > 0 ? 'text-warning/70' : 'text-success/70'}`} strokeWidth={1.5} aria-hidden="true" />
          <div className="font-display italic text-xl text-stat-value">
            {cadence?.enabled === false
              ? 'Detection disabled'
              : checkFailures.length > 0 ? 'No verified updates pending' : 'All stacks on current builds'}
          </div>
          <div className="font-mono text-[11px] text-stat-subtitle">
            {cadence?.enabled === false
              ? 'Turn image update checks back on in Settings when Sencho should monitor registries again.'
              : checkFailures.length > 0
                ? 'Review the unresolved checks above, then recheck.'
                : 'Sencho rechecks registries on the configured interval.'}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(group => (
            <NodeGroupSection
              key={group.nodeId}
              group={group}
              canServiceUpdate={serviceScopedNodeIds.has(group.nodeId)}
              onApply={handleApply}
              onApplyService={handleApplyService}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AutoUpdateReadinessView(props: AutoUpdateReadinessProps = {}) {
  return <AutoUpdateReadinessContent {...props} />;
}
