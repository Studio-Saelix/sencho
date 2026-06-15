// Mobile (<md) reflow pieces for the node-scoped Security page. These render
// only on the phone branch (gated by useIsMobile() in the parent components)
// and never affect the desktop layout. Tokens only, no new colors or fonts;
// they translate the approved prototype onto the existing design tokens.
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Kicker, MobileSubTabs, MobileChipRow } from '@/components/mobile/mobile-ui';
import { getSeverityKey, SEVERITY_DOT_CLASSES, type ImageFilterValue } from '@/lib/severityStyles';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { SecurityTab } from '@/lib/events';
import type { ScanSummary, SecurityOverview, ScanDetailTab } from '@/types/security';

export interface SecurityMobileTab {
  value: SecurityTab;
  label: string;
}

/** The Security tab strip is the shared mono sub-tab scroller; every section
 *  stays reachable by horizontal scroll, matching the desktop IA. */
export function SecurityMobileTabs({ tabs, active, onSelect }: {
  tabs: SecurityMobileTab[];
  active: SecurityTab;
  onSelect: (tab: SecurityTab) => void;
}) {
  return <MobileSubTabs tabs={tabs} active={active} onSelect={onSelect} ariaLabel="Security sections" />;
}

function StripCell({ kicker, value, valueClass, last }: {
  kicker: string;
  value: string;
  valueClass: string;
  last?: boolean;
}) {
  return (
    <div className={cn('min-w-0 flex-1 px-[13px] py-3', !last && 'border-r border-hairline')}>
      <Kicker>{kicker}</Kicker>
      <div className={cn('mt-[3px] truncate font-mono text-[26px] leading-none tabular-nums tracking-[-0.02em]', valueClass)}>
        {value}
      </div>
    </div>
  );
}

/** CRITICAL / HIGH / LAST SCAN strip that the desktop masthead carries inline;
 *  on mobile the masthead hides its stat cluster and this sits below the tabs. */
export function SecuritySevStrip({ overview }: { overview: SecurityOverview }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
      <StripCell kicker="critical" value={String(overview.critical)} valueClass={overview.critical > 0 ? 'text-destructive' : 'text-stat-value'} />
      <StripCell kicker="high" value={String(overview.high)} valueClass={overview.high > 0 ? 'text-warning' : 'text-stat-value'} />
      <StripCell
        kicker="last scan"
        value={overview.lastSuccessfulScanAt ? formatTimeAgo(overview.lastSuccessfulScanAt) : 'never'}
        valueClass="text-stat-value"
        last
      />
    </div>
  );
}

/** The six desktop totals as a 3-col x 2-row hairline-divided card (replaces the
 *  min-w-[640px] SignalRail, which forces a horizontal scroll on a phone). */
export function SecurityTotalsGrid({ overview }: { overview: SecurityOverview }) {
  const cells: Array<{ kicker: string; value: number; valueClass: string }> = [
    { kicker: 'scanned', value: overview.scannedImages, valueClass: 'text-stat-value' },
    { kicker: 'fixable', value: overview.fixable, valueClass: overview.fixable > 0 ? 'text-warning' : 'text-stat-value' },
    { kicker: 'secrets', value: overview.secrets, valueClass: overview.secrets > 0 ? 'text-destructive' : 'text-stat-value' },
    { kicker: 'misconfigs', value: overview.misconfigs, valueClass: overview.misconfigs > 0 ? 'text-warning' : 'text-stat-value' },
    { kicker: 'stale', value: overview.staleScans, valueClass: overview.staleScans > 0 ? 'text-warning' : 'text-stat-value' },
    { kicker: 'failed', value: overview.failedScans, valueClass: overview.failedScans > 0 ? 'text-destructive' : 'text-stat-value' },
  ];
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
      {cells.map((cell, i) => (
        <div
          key={cell.kicker}
          className={cn('px-[13px] py-3', i % 3 !== 0 && 'border-l border-hairline', i >= 3 && 'border-t border-hairline')}
        >
          <Kicker>{cell.kicker}</Kicker>
          <div className={cn('mt-[3px] font-mono text-[21px] leading-none tabular-nums tracking-[-0.01em]', cell.valueClass)}>
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Footer freshness band (§9.11): context, not chrome. States the truthful scan
 *  freshness and scanner version for the active node. */
export function SecurityFooterBand({ overview }: { overview: SecurityOverview }) {
  const parts: string[] = [
    overview.lastSuccessfulScanAt ? `last scan ${formatTimeAgo(overview.lastSuccessfulScanAt)}` : 'no successful scan yet',
  ];
  if (overview.scanner.available) {
    parts.push(`${overview.scanner.source}${overview.scanner.version ? ` v${overview.scanner.version}` : ''}`);
  } else {
    parts.push('scanner not installed');
  }
  return (
    <div className="-mx-4 mt-2 border-t border-hairline bg-band px-4 py-[9px]">
      <Kicker className="text-stat-subtitle">{parts.join(' · ')}</Kicker>
    </div>
  );
}

const COUNT_TAG_TONE = {
  destructive: 'border-destructive/30 bg-destructive/[0.14] text-destructive',
  warning: 'border-warning/30 bg-warning/[0.14] text-warning',
  success: 'border-success/30 bg-success/[0.14] text-success',
} as const;

function CountTag({ tone, children }: { tone: keyof typeof COUNT_TAG_TONE; children: ReactNode }) {
  return (
    <span className={cn('whitespace-nowrap rounded-[5px] border px-[7px] py-[2px] font-mono text-[10px] uppercase tracking-[0.08em]', COUNT_TAG_TONE[tone])}>
      {children}
    </span>
  );
}

/** One image row in the mobile Images list: severity dot, truncated mono ref over
 *  a freshness meta line, trailing C/H count tags (or CLEAN), and a chevron. */
export function ImageScanRow({ summary, onInspect }: {
  summary: ScanSummary;
  onInspect: (scanId: number, initialTab?: ScanDetailTab) => void;
}) {
  // Use the shared classifier so the count tags agree with the leading dot: a
  // medium/low-only image is not "clean", it is its highest severity.
  const severityKey = getSeverityKey(summary);
  const clean = severityKey === 'CLEAN';
  return (
    <button
      type="button"
      onClick={() => onInspect(summary.scan_id, 'vulns')}
      className="flex min-h-11 w-full items-center gap-[11px] border-b border-hairline py-[11px] text-left last:border-b-0"
    >
      <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', SEVERITY_DOT_CLASSES[severityKey])} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px] text-stat-value">{summary.image_ref}</span>
        <span className="mt-px block font-mono text-[10px] text-stat-icon">scanned {formatTimeAgo(summary.scanned_at)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {summary.critical > 0 && <CountTag tone="destructive">{summary.critical}C</CountTag>}
        {summary.high > 0 && <CountTag tone="warning">{summary.high}H</CountTag>}
        {clean && <CountTag tone="success">clean</CountTag>}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0 text-stat-icon" strokeWidth={1.5} aria-hidden />
    </button>
  );
}

export interface ImageFilterChip {
  value: ImageFilterValue;
  label: string;
}

/** The Images severity filter is the shared mobile chip row. */
export function ImageFilterChips({ chips, active, onSelect }: {
  chips: ImageFilterChip[];
  active: ImageFilterValue;
  onSelect: (value: ImageFilterValue) => void;
}) {
  return <MobileChipRow chips={chips} active={active} onSelect={onSelect} />;
}
