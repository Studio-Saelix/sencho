import * as React from 'react';
import { Loader2, Play, Plus, RotateCw, ServerCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TogglePill } from '@/components/ui/toggle-pill';
import { useDensity } from '@/hooks/use-density';
import { formatAgeShort } from '@/lib/relativeTime';
import { cn } from '@/lib/utils';

export type RoutingNodeState = 'meshed' | 'idle' | 'degraded' | 'offline';

export interface RoutingAliasRow {
    host: string;
    port: number;
    kind: 'alias' | 'suspended';
    lastTested?: { at: number; ok: boolean };
    testing?: boolean;
}

export interface RoutingNodeCardMeta {
    pilotConnected: boolean;
    reverseBridge: 'up' | 'unavailable' | 'na';
    stacks: number;
    aliases: number;
}

export interface RoutingNodeCardProps {
    crumb: string[];
    name: string;
    isLocal?: boolean;
    nodeState: RoutingNodeState;
    meta: RoutingNodeCardMeta;
    aliases: RoutingAliasRow[];
    onToggleEnabled: (next: boolean) => void;
    onShowDiagnostics: () => void;
    onShowAlias?: (alias: string) => void;
    onTestAlias?: (alias: string) => void;
    onAddStack?: () => void;
    onRetry?: () => void;
    footerContext: string;
    /** Offline-state reason copy; falls back to a generic line. */
    offlineReason?: string | null;
    /**
     * When false, the management affordances (enable/disable toggle and the
     * enable-mesh / add-stack empty-state CTAs) are hidden so a viewer without
     * the admin role gets a read-only card. Read-only affordances (diagnostics,
     * alias probe, retry) stay available. Defaults to true.
     */
    canManage?: boolean;
}

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';

const RAIL_CLASS: Record<RoutingNodeState, string> = {
    meshed: 'bg-brand',
    idle: '',
    degraded: 'bg-warning',
    offline: 'bg-destructive',
};

const RAIL_INLINE_STYLE: Record<RoutingNodeState, React.CSSProperties | undefined> = {
    meshed: undefined,
    idle: { background: 'oklch(0.28 0 0)' },
    degraded: undefined,
    offline: undefined,
};

const STATE_CHIP: Record<RoutingNodeState, { label: string; tone: string }> = {
    meshed: { label: 'Meshed', tone: 'border-brand/40 bg-brand/10 text-brand' },
    idle: { label: 'Idle', tone: 'border-card-border bg-card text-stat-subtitle' },
    degraded: { label: 'Degraded', tone: 'border-warning/40 bg-warning/10 text-warning' },
    offline: { label: 'Offline', tone: 'border-destructive/40 bg-destructive/10 text-destructive' },
};

const REVERSE_LABEL: Record<RoutingNodeCardMeta['reverseBridge'], string> = {
    up: 'up',
    unavailable: 'unavailable',
    na: 'n/a',
};

export function RoutingNodeCard(props: RoutingNodeCardProps) {
    const {
        crumb, name, isLocal, nodeState, meta, aliases,
        onToggleEnabled, onShowDiagnostics, onShowAlias, onTestAlias,
        onAddStack, onRetry, footerContext, offlineReason,
        canManage = true,
    } = props;
    const [density] = useDensity();
    const compact = density === 'compact';

    const toggleDisabled = nodeState === 'offline';
    const diagnosticsDisabled = nodeState === 'offline';
    const isEnabled = nodeState === 'meshed' || nodeState === 'degraded';
    const chip = STATE_CHIP[nodeState];

    const railClass = RAIL_CLASS[nodeState];
    const railStyle = RAIL_INLINE_STYLE[nodeState];

    return (
        <Card className="relative overflow-hidden p-0">
            <span
                aria-hidden="true"
                className={cn('absolute inset-y-0 left-0 w-[3px]', railClass)}
                style={railStyle}
            />
            {compact
                ? <CompactBody
                    name={name}
                    isLocal={isLocal}
                    chip={chip}
                    meta={meta}
                    nodeState={nodeState}
                    isEnabled={isEnabled}
                    toggleDisabled={toggleDisabled}
                    diagnosticsDisabled={diagnosticsDisabled}
                    onToggleEnabled={onToggleEnabled}
                    onShowDiagnostics={onShowDiagnostics}
                    canManage={canManage}
                    footerContext={footerContext}
                    aliasesEmpty={aliases.length === 0}
                    onAddStack={onAddStack}
                    onRetry={onRetry}
                />
                : <ComfortableBody
                    crumb={crumb}
                    name={name}
                    isLocal={isLocal}
                    chip={chip}
                    meta={meta}
                    nodeState={nodeState}
                    isEnabled={isEnabled}
                    toggleDisabled={toggleDisabled}
                    diagnosticsDisabled={diagnosticsDisabled}
                    onToggleEnabled={onToggleEnabled}
                    onShowDiagnostics={onShowDiagnostics}
                    canManage={canManage}
                    aliases={aliases}
                    onShowAlias={onShowAlias}
                    onTestAlias={onTestAlias}
                    onAddStack={onAddStack}
                    onRetry={onRetry}
                    footerContext={footerContext}
                    offlineReason={offlineReason}
                />}
        </Card>
    );
}

interface BodyChrome {
    name: string;
    isLocal?: boolean;
    chip: { label: string; tone: string };
    meta: RoutingNodeCardMeta;
    nodeState: RoutingNodeState;
    isEnabled: boolean;
    toggleDisabled: boolean;
    diagnosticsDisabled: boolean;
    onToggleEnabled: (next: boolean) => void;
    onShowDiagnostics: () => void;
    canManage: boolean;
    footerContext: string;
    onAddStack?: () => void;
    onRetry?: () => void;
}

interface CompactProps extends BodyChrome {
    aliasesEmpty: boolean;
}

interface ComfortableProps extends BodyChrome {
    crumb: string[];
    aliases: RoutingAliasRow[];
    onShowAlias?: (alias: string) => void;
    onTestAlias?: (alias: string) => void;
    offlineReason?: string | null;
}

function ComfortableBody(props: ComfortableProps) {
    const {
        crumb, name, isLocal, chip, meta, nodeState, isEnabled,
        toggleDisabled, diagnosticsDisabled, onToggleEnabled, onShowDiagnostics,
        aliases, onShowAlias, onTestAlias, onAddStack, onRetry, footerContext, offlineReason,
        canManage,
    } = props;
    const published = aliases.filter((a) => a.kind === 'alias').length;
    const showAliases = aliases.length > 0;
    const sectionTitle = published < aliases.length
        ? `Aliases · ${published} of ${aliases.length}`
        : `Aliases · ${aliases.length}`;

    return (
        <>
            <header className="px-4 pt-4 pb-3 pl-5">
                <div className={cn(KICKER, 'text-stat-subtitle leading-none')}>
                    {crumb.join(' › ')}
                </div>
                <div className="mt-2 flex items-center gap-2">
                    <h3 className="font-display italic text-[22px] leading-[28px] text-stat-value">
                        {name}
                    </h3>
                    {isLocal && (
                        <span className={cn(KICKER, 'inline-flex items-center px-1.5 py-0.5 rounded-sm border border-brand/40 bg-brand/10 text-brand')}>
                            ★ Local
                        </span>
                    )}
                </div>
                <div className={cn(KICKER, 'mt-1.5 text-stat-subtitle leading-none tracking-[0.14em]')}>
                    pilot {meta.pilotConnected ? 'connected' : 'offline'}
                    {' · '}reverse {REVERSE_LABEL[meta.reverseBridge]}
                    {' · '}{meta.stacks} stacks
                    {' · '}{meta.aliases} aliases
                </div>
            </header>

            <Toolbar
                chip={chip}
                isEnabled={isEnabled}
                toggleDisabled={toggleDisabled}
                diagnosticsDisabled={diagnosticsDisabled}
                onToggleEnabled={onToggleEnabled}
                onShowDiagnostics={onShowDiagnostics}
                canManage={canManage}
            />

            <div className="px-4 py-3 pl-5">
                {showAliases
                    ? <AliasList
                        title={sectionTitle}
                        aliases={aliases}
                        onShowAlias={onShowAlias}
                        onTestAlias={onTestAlias}
                    />
                    : <EmptyState
                        nodeState={nodeState}
                        name={name}
                        offlineReason={offlineReason}
                        onAddStack={onAddStack}
                        onRetry={onRetry}
                        onToggleEnabled={onToggleEnabled}
                        canManage={canManage}
                    />}
            </div>

            <Footer context={footerContext} />
        </>
    );
}

function CompactBody(props: CompactProps) {
    const {
        name, isLocal, chip, meta, nodeState, isEnabled,
        toggleDisabled, diagnosticsDisabled, onToggleEnabled, onShowDiagnostics,
        footerContext, aliasesEmpty, onAddStack, onRetry, canManage,
    } = props;

    return (
        <>
            <header className="flex items-center gap-2 px-4 py-2.5 pl-5">
                <h3 className="font-display italic text-[18px] leading-[22px] text-stat-value mr-1">
                    {name}
                </h3>
                {isLocal && (
                    <span className={cn(KICKER, 'inline-flex items-center px-1 py-0.5 rounded-sm border border-brand/40 bg-brand/10 text-brand')}>
                        ★
                    </span>
                )}
                <span className={cn(KICKER, 'inline-flex items-center px-1.5 py-0.5 rounded-sm border', chip.tone)}>
                    {chip.label}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                    {canManage && (
                        <TogglePill
                            checked={isEnabled}
                            disabled={toggleDisabled}
                            onChange={onToggleEnabled}
                        />
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onShowDiagnostics}
                        disabled={diagnosticsDisabled}
                        className="h-7 w-7 p-0"
                        aria-label="Diagnostics"
                    >
                        <ServerCog className="w-3 h-3" />
                    </Button>
                </div>
            </header>

            <div className="grid grid-cols-4 divide-x divide-card-border/40 border-y border-card-border/40 bg-card/60 pl-[3px]">
                <CompactCell
                    dot={meta.stacks > 0 ? 'success' : 'muted'}
                    value={String(meta.stacks)}
                    sub="opted in"
                />
                <CompactCell
                    dot={meta.aliases > 0 ? 'success' : 'muted'}
                    value={String(meta.aliases)}
                    sub="published"
                />
                <CompactCell
                    dot={meta.pilotConnected ? 'success' : 'warning'}
                    value={meta.pilotConnected ? 'on' : 'off'}
                    sub="agent"
                />
                <CompactCell
                    dot={reverseDot(meta.reverseBridge)}
                    value={REVERSE_LABEL[meta.reverseBridge]}
                    sub="bridge"
                />
            </div>

            <CompactFooter
                context={footerContext}
                nodeState={nodeState}
                name={name}
                aliasesEmpty={aliasesEmpty}
                onAddStack={onAddStack}
                onRetry={onRetry}
                onToggleEnabled={onToggleEnabled}
                canManage={canManage}
            />
        </>
    );
}

function reverseDot(reverse: RoutingNodeCardMeta['reverseBridge']): DotTone {
    if (reverse === 'up') return 'success';
    if (reverse === 'unavailable') return 'warning';
    return 'muted';
}

type DotTone = 'success' | 'warning' | 'destructive' | 'muted';

function CompactCell({ dot, value, sub }: { dot: DotTone; value: string; sub: string }) {
    return (
        <div className="px-3 py-2.5 flex items-center gap-2">
            <Dot tone={dot} />
            <div className="min-w-0">
                <div className="font-mono text-[12px] leading-none text-stat-value tabular-nums">{value}</div>
                <div className={cn(KICKER, 'text-stat-subtitle leading-none mt-1')}>{sub}</div>
            </div>
        </div>
    );
}

interface ToolbarProps {
    chip: { label: string; tone: string };
    isEnabled: boolean;
    toggleDisabled: boolean;
    diagnosticsDisabled: boolean;
    onToggleEnabled: (next: boolean) => void;
    onShowDiagnostics: () => void;
    canManage: boolean;
}

function Toolbar({ chip, isEnabled, toggleDisabled, diagnosticsDisabled, onToggleEnabled, onShowDiagnostics, canManage }: ToolbarProps) {
    return (
        <div className="flex items-center gap-2 px-4 py-2 pl-5 border-y border-card-border/40 bg-card/60">
            <span className={cn(KICKER, 'inline-flex items-center px-1.5 py-0.5 rounded-sm border', chip.tone)}>
                {chip.label}
            </span>
            <div className="flex-1" />
            {canManage && (
                <TogglePill
                    checked={isEnabled}
                    disabled={toggleDisabled}
                    onChange={onToggleEnabled}
                />
            )}
            <Button
                variant="outline"
                size="sm"
                onClick={onShowDiagnostics}
                disabled={diagnosticsDisabled}
            >
                <ServerCog className="w-3 h-3 mr-1" /> Diagnostics
            </Button>
        </div>
    );
}

interface AliasListProps {
    title: string;
    aliases: RoutingAliasRow[];
    onShowAlias?: (alias: string) => void;
    onTestAlias?: (alias: string) => void;
}

function AliasList({ title, aliases, onShowAlias, onTestAlias }: AliasListProps) {
    return (
        <section>
            <h4 className={cn(KICKER, 'text-stat-subtitle leading-none mb-2 tracking-[0.22em]')}>
                {title}
            </h4>
            <div className="space-y-1">
                {aliases.map((row) => (
                    <AliasRow
                        key={`${row.kind}:${row.host}`}
                        row={row}
                        onShowAlias={onShowAlias}
                        onTestAlias={onTestAlias}
                    />
                ))}
            </div>
        </section>
    );
}

interface AliasRowProps {
    row: RoutingAliasRow;
    onShowAlias?: (alias: string) => void;
    onTestAlias?: (alias: string) => void;
}

function AliasRow({ row, onShowAlias, onTestAlias }: AliasRowProps) {
    const isSuspended = row.kind === 'suspended';
    const dot: DotTone = isSuspended
        ? 'warning'
        : row.lastTested
            ? (row.lastTested.ok ? 'success' : 'destructive')
            : 'muted';
    const ageLabel = row.lastTested
        ? formatAgeShort(Date.now() - row.lastTested.at)
        : '';

    return (
        <div className="flex items-center gap-2 rounded border border-card-border/40 bg-card/40 px-2 py-1.5 shadow-[inset_0_1px_0_oklch(0_0_0_/_0.03)]">
            <Dot tone={dot} />
            {isSuspended
                ? <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-stat-subtitle">
                    {row.host} <span className="opacity-70">(suspended)</span>
                </span>
                : onShowAlias
                    ? <button
                        type="button"
                        className="flex-1 min-w-0 truncate text-left font-mono text-[11px] text-stat-value hover:text-brand transition-colors"
                        onClick={() => onShowAlias(row.host)}
                    >
                        {row.host}<span className="text-brand">:{row.port}</span>
                    </button>
                    : <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-stat-value">
                        {row.host}<span className="text-brand">:{row.port}</span>
                    </span>}
            {!isSuspended && ageLabel && (
                <span className={cn(KICKER, 'shrink-0 text-stat-subtitle tabular-nums')}>{ageLabel}</span>
            )}
            <Button
                variant="ghost"
                size="sm"
                onClick={() => onTestAlias?.(row.host)}
                disabled={isSuspended || row.testing || !onTestAlias}
                className="h-[22px] w-[22px] p-0 shrink-0"
                aria-label={`Test ${row.host}`}
            >
                {row.testing
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Play className="w-3 h-3" strokeWidth={1.75} />}
            </Button>
        </div>
    );
}

interface EmptyStateProps {
    nodeState: RoutingNodeState;
    name: string;
    offlineReason?: string | null;
    onAddStack?: () => void;
    onRetry?: () => void;
    onToggleEnabled: (next: boolean) => void;
    canManage: boolean;
}

function EmptyState({ nodeState, name, offlineReason, onAddStack, onRetry, onToggleEnabled, canManage }: EmptyStateProps) {
    const { headline, sub, cta } = emptyStateCopy(nodeState, name, offlineReason);
    // The idle and meshed CTAs (enable mesh, add stack) are management actions
    // the backend gates on the admin role, so a non-admin viewer sees a hint
    // instead. The degraded/offline retry is a read-only refresh and stays.
    const isManagementState = nodeState === 'idle' || nodeState === 'meshed';

    const handleClick = () => {
        if (nodeState === 'idle') onToggleEnabled(true);
        else if (nodeState === 'meshed') onAddStack?.();
        else onRetry?.();
    };

    return (
        <div className="flex flex-col items-start gap-2 py-3">
            <div className="font-display italic text-[18px] leading-[24px] text-stat-value">
                {headline}
            </div>
            <div className="font-mono text-[11px] leading-snug text-stat-subtitle">
                {sub}
            </div>
            {!canManage && isManagementState ? (
                <div className="font-mono text-[11px] leading-snug text-stat-subtitle">
                    Managing the mesh requires an administrator.
                </div>
            ) : (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClick}
                    className={cn('mt-1', ctaToneFor(nodeState))}
                >
                    {ctaIconFor(nodeState)}{cta}
                </Button>
            )}
        </div>
    );
}

function ctaIconFor(state: RoutingNodeState): React.ReactNode {
    if (state === 'meshed') return <Plus className="w-3 h-3 mr-1" />;
    if (state === 'degraded' || state === 'offline') return <RotateCw className="w-3 h-3 mr-1" />;
    return null;
}

const CTA_TONE: Record<RoutingNodeState, string> = {
    meshed: '',
    idle: '',
    degraded: 'border-warning/40 text-warning hover:bg-warning/10',
    offline: 'border-destructive/40 text-destructive hover:bg-destructive/10',
};

function ctaToneFor(state: RoutingNodeState): string {
    return CTA_TONE[state];
}

function emptyStateCopy(state: RoutingNodeState, name: string, offlineReason?: string | null): {
    headline: string; sub: string; cta: string;
} {
    switch (state) {
        case 'idle':
            return {
                headline: 'Not in the mesh.',
                sub: 'Toggle on to start publishing aliases from this node.',
                cta: `Enable mesh on ${name}`,
            };
        case 'meshed':
            return {
                headline: 'No services routed yet.',
                sub: 'Mesh is on. Opt a stack in to start publishing aliases.',
                cta: '+ Add stack to mesh',
            };
        case 'degraded':
            return {
                headline: 'Pilot tunnel disconnected.',
                sub: 'Mesh traffic resumes when the agent reconnects.',
                cta: 'Retry now',
            };
        case 'offline':
            return {
                headline: 'Node unreachable.',
                sub: offlineReason || 'Connection refused.',
                cta: 'Retry now',
            };
    }
}

function Footer({ context }: { context: string }) {
    return (
        <div className="px-4 py-2 pl-5 border-t border-card-border/40 bg-card/60">
            <div className={cn(KICKER, 'text-stat-subtitle leading-none')}>
                {context}
            </div>
        </div>
    );
}

interface CompactFooterProps {
    context: string;
    nodeState: RoutingNodeState;
    name: string;
    aliasesEmpty: boolean;
    onAddStack?: () => void;
    onRetry?: () => void;
    onToggleEnabled: (next: boolean) => void;
    canManage: boolean;
}

function CompactFooter({ context, nodeState, name, aliasesEmpty, onAddStack, onRetry, onToggleEnabled, canManage }: CompactFooterProps) {
    // Hide the management CTAs (enable mesh / add stack) for non-admins; the
    // read-only retry on a degraded/offline node stays available.
    const isManagementState = nodeState === 'idle' || nodeState === 'meshed';
    const showCta = (nodeState !== 'meshed' || aliasesEmpty) && (canManage || !isManagementState);
    const { cta } = emptyStateCopy(nodeState, name);
    const handleClick = () => {
        if (nodeState === 'idle') onToggleEnabled(true);
        else if (nodeState === 'meshed') onAddStack?.();
        else onRetry?.();
    };

    return (
        <div className="flex items-center gap-2 px-4 py-2 pl-5 border-t border-card-border/40 bg-card/60">
            <div className={cn(KICKER, 'text-stat-subtitle leading-none truncate')}>
                {context}
            </div>
            {showCta && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClick}
                    className={cn('ml-auto h-7', ctaToneFor(nodeState))}
                >
                    {ctaIconFor(nodeState)}{cta}
                </Button>
            )}
        </div>
    );
}

const DOT_CLASS: Record<DotTone, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
    muted: 'bg-stat-subtitle/50',
};

function Dot({ tone }: { tone: DotTone }) {
    return <span aria-hidden="true" className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', DOT_CLASS[tone])} />;
}
