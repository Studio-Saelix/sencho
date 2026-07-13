import {
  isNetworkDriftFindingKind,
  type NetworkingFinding, type NetworkingNetworkRow, type NetworkingOverviewEnvelope,
  type NetworkingRecommendedAction, type NodeNetworkingOverview,
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

// findingIds on a row are opaque hash IDs; the drift filter needs each finding's
// kind, so the caller supplies a lookup built from the full findings list.
function matchesNetworkFilter(
  row: NetworkingNetworkRow,
  filter: NetworkFilter,
  findingKindById: Map<string, string>,
): boolean {
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
      return row.findingIds.some((id) => {
        const kind = findingKindById.get(id);
        return kind !== undefined && isNetworkDriftFindingKind(kind);
      });
    case 'all':
    default:
      return true;
  }
}

export function filterNetworkRows(
  rows: NetworkingNetworkRow[],
  filter: NetworkFilter,
  search: string,
  findingKindById: Map<string, string> = new Map(),
): NetworkingNetworkRow[] {
  const query = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesNetworkFilter(row, filter, findingKindById)) return false;
    if (!query) return true;
    return [
      row.name,
      row.stack,
      row.composeProject,
      row.driver,
      ...row.declaredByStacks,
      ...row.declaredExternalByStacks,
      ...row.serviceNames,
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

/** Normalizes a network row from a schema-2 remote (no serviceNames) so the UI
 *  never crashes on a missing array. */
function adaptNetworkRow(row: Partial<NetworkingNetworkRow>): NetworkingNetworkRow {
  return {
    id: row.id ?? '',
    name: row.name ?? '',
    driver: row.driver ?? 'bridge',
    scope: row.scope ?? 'local',
    isSystem: row.isSystem === true,
    ingress: row.ingress === true,
    enableIPv6: row.enableIPv6,
    composeProject: row.composeProject ?? null,
    stack: row.stack ?? null,
    connectedCount: row.connectedCount ?? 0,
    isSencho: row.isSencho === true,
    ownership: row.ownership ?? 'unmanaged',
    declaredByStacks: row.declaredByStacks ?? [],
    declaredExternalByStacks: row.declaredExternalByStacks ?? [],
    isExternalDependency: row.isExternalDependency === true,
    sharedStackCount: row.sharedStackCount ?? 0,
    exposureSummary: row.exposureSummary ?? null,
    findingIds: row.findingIds ?? [],
    serviceNames: row.serviceNames ?? [],
  };
}

/** Normalizes a finding from a schema-2 remote (no sources/doctorFindings). */
function adaptFinding(f: Partial<NetworkingFinding>): NetworkingFinding {
  return {
    id: f.id ?? '',
    kind: (f.kind ?? 'runtime-unavailable') as NetworkingFinding['kind'],
    severity: f.severity ?? 'info',
    title: f.title ?? '',
    message: f.message ?? '',
    stack: f.stack,
    network: f.network,
    service: f.service,
    evidence: f.evidence ?? [],
    recommendedActions: f.recommendedActions ?? [],
    sources: f.sources ?? ['live'],
    doctorFindings: f.doctorFindings ?? [],
  };
}

/** Derives ownership counts from network rows when the overview envelope itself
 *  omits them (schema 2), instead of showing incorrect zeroes. */
function deriveOwnershipCounts(networks: NetworkingNetworkRow[]): {
  senchoManagedNetworkCount: number;
  composeManagedNetworkCount: number;
  unmanagedNetworkCount: number;
  externalDependencyNetworkCount: number;
} {
  return {
    senchoManagedNetworkCount: networks.filter((n) => n.ownership === 'sencho-managed').length,
    composeManagedNetworkCount: networks.filter((n) => n.ownership === 'compose-managed').length,
    unmanagedNetworkCount: networks.filter((n) => n.ownership === 'unmanaged').length,
    externalDependencyNetworkCount: networks.filter((n) => n.isExternalDependency).length,
  };
}

export function adaptNetworkingOverview(body: Partial<NetworkingOverviewEnvelope>): {
  isLegacy: boolean;
  runtimeAvailable: boolean;
  overview: NodeNetworkingOverview | null;
  networks: NetworkingNetworkRow[];
  findings: NetworkingFinding[];
  recentActivity: NetworkingOverviewEnvelope['recentActivity'];
} {
  // A remote node's actual schemaVersion may be older than the type literal this
  // build declares (3); widen it to a plain number for the compatibility checks.
  const schemaVersion = body.schemaVersion as unknown as number | undefined;

  // Schema 1 / absent: fully legacy, no usable shape at all.
  const isLegacy = schemaVersion === undefined || schemaVersion < 2;
  if (isLegacy) {
    return {
      isLegacy: true,
      runtimeAvailable: false,
      overview: null,
      networks: [],
      findings: [],
      recentActivity: [],
    };
  }

  const networks = (body.networks ?? []).map(adaptNetworkRow);
  const findings = (body.findings ?? []).map(adaptFinding);
  const isSchema2 = schemaVersion === 2;
  const overview = body.overview
    ? {
      ...body.overview,
      ...(isSchema2 ? deriveOwnershipCounts(networks) : {}),
    }
    : null;

  return {
    isLegacy: false,
    runtimeAvailable: body.runtimeAvailable === true,
    overview,
    networks,
    findings,
    recentActivity: body.recentActivity ?? [],
  };
}
