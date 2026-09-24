import type { FindingSeverity, FindingVerdict, ReadinessDomainKey, ReadinessFinding } from '@/types/readiness';
import { codeCopy } from '../readinessMeta';

export const ALL = 'all';

/**
 * Verdict presets. The rollback preset is the "which stacks could not be rolled
 * back cleanly" question; the update preset is "which updates should not go out
 * unattended".
 */
const VERDICT_PRESET_KEYS = ['rollback-weak', 'update-not-ready'] as const;

export type VerdictFilter = typeof ALL | (typeof VERDICT_PRESET_KEYS)[number];

export interface FindingsFilter {
  query: string;
  domain: typeof ALL | ReadinessDomainKey;
  severity: typeof ALL | FindingSeverity;
  verdict: VerdictFilter;
  nodeId: typeof ALL | number;
}

export const EMPTY_FINDINGS_FILTER: FindingsFilter = {
  query: '',
  domain: ALL,
  severity: ALL,
  verdict: ALL,
  nodeId: ALL,
};

const VERDICT_PRESETS: Record<Exclude<VerdictFilter, typeof ALL>, {
  label: string;
  matches: (verdict: FindingVerdict) => boolean;
}> = {
  'rollback-weak': {
    label: 'Rollback partial or not ready',
    matches: verdict => verdict.kind === 'rollback' && (verdict.value === 'partial' || verdict.value === 'not_ready'),
  },
  'update-not-ready': {
    label: 'Update blocked or needs review',
    matches: verdict => verdict.kind === 'update' && (verdict.value === 'blocked' || verdict.value === 'review_required'),
  },
};

export const VERDICT_OPTIONS: Array<{ value: VerdictFilter; label: string }> = [
  { value: ALL, label: 'Any verdict' },
  ...VERDICT_PRESET_KEYS.map(value => ({ value, label: VERDICT_PRESETS[value].label })),
];

function matchesVerdict(verdict: FindingVerdict | null, filter: VerdictFilter): boolean {
  if (filter === ALL) return true;
  return verdict !== null && VERDICT_PRESETS[filter].matches(verdict);
}

export function filterFindings(
  findings: readonly ReadinessFinding[],
  filter: FindingsFilter,
  nodeNames: ReadonlyMap<number, string>,
): ReadinessFinding[] {
  const query = filter.query.trim().toLowerCase();
  return findings.filter(finding => {
    if (filter.domain !== ALL && finding.domain !== filter.domain) return false;
    if (filter.severity !== ALL && finding.severity !== filter.severity) return false;
    if (filter.nodeId !== ALL && finding.nodeId !== filter.nodeId) return false;
    if (!matchesVerdict(finding.verdict, filter.verdict)) return false;
    if (query === '') return true;
    const haystack = [codeCopy(finding.code), finding.detail, finding.stack, nodeNames.get(finding.nodeId)]
      .filter((part): part is string => Boolean(part))
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

