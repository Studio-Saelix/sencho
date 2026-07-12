import type {
  NetworkingFinding, NetworkingNetworkRow, NetworkingOverviewEnvelope,
  NetworkingRecommendedAction, NodeNetworkingOverview,
} from '@/types/networking';

export type NetworkFilter = 'all' | 'managed' | 'external' | 'system' | 'shared' | 'exposed' | 'drift';

export function isNetworkingActionVisible(
  action: NetworkingRecommendedAction,
  isAdmin: boolean,
  canEditStack: (stack: string) => boolean,
): boolean {
  if (action.kind === 'create-network') return isAdmin;
  if (action.kind === 'set-exposure-intent') return canEditStack(action.stack);
  return true;
}

function matchesNetworkFilter(row: NetworkingNetworkRow, filter: NetworkFilter): boolean {
  switch (filter) {
    case 'managed':
      return row.ownership === 'sencho-managed';
    case 'external':
      return row.isExternalDependency;
    case 'system':
      return row.ownership === 'system';
    case 'shared':
      return row.sharedStackCount >= 2;
    case 'exposed':
      return Boolean(row.exposureSummary?.broadExposureCount);
    case 'drift':
      return row.findingIds.length > 0;
    case 'all':
    default:
      return true;
  }
}

export function filterNetworkRows(
  rows: NetworkingNetworkRow[],
  filter: NetworkFilter,
  search: string,
): NetworkingNetworkRow[] {
  const query = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesNetworkFilter(row, filter)) return false;
    if (!query) return true;
    return [
      row.name,
      row.stack,
      row.composeProject,
      row.driver,
      ...row.declaredByStacks,
      ...row.declaredExternalByStacks,
    ].filter(Boolean).some((value) => value!.toLowerCase().includes(query));
  });
}

export function getNetworkingPosture(
  findings: NetworkingFinding[],
  runtimeAvailable: boolean,
  isLegacy: boolean,
): { label: string; tone: 'live' | 'warning' | 'critical' | 'neutral' } {
  if (isLegacy) return { label: 'Partial networking data', tone: 'neutral' };
  if (!runtimeAvailable) return { label: 'Runtime unavailable', tone: 'warning' };
  if (findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')) {
    return { label: 'Action needed', tone: 'critical' };
  }
  if (findings.some((finding) => finding.severity === 'medium')) {
    return { label: 'Review', tone: 'warning' };
  }
  return { label: 'Contained', tone: 'live' };
}

export function canUseNetworkName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

export function buildExternalNetworkSnippet(name: string): string | null {
  if (!canUseNetworkName(name)) return null;
  return `networks:\n  ${name}:\n    external: true`;
}

export function adaptNetworkingOverview(body: Partial<NetworkingOverviewEnvelope>): {
  isLegacy: boolean;
  runtimeAvailable: boolean;
  overview: NodeNetworkingOverview | null;
  networks: NetworkingNetworkRow[];
  findings: NetworkingFinding[];
  recentActivity: NetworkingOverviewEnvelope['recentActivity'];
} {
  const isLegacy = body.schemaVersion !== 2;
  return {
    isLegacy,
    runtimeAvailable: isLegacy ? false : body.runtimeAvailable === true,
    overview: body.overview ?? null,
    networks: body.networks ?? [],
    findings: isLegacy ? [] : body.findings ?? [],
    recentActivity: isLegacy ? [] : body.recentActivity ?? [],
  };
}
