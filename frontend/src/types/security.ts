import type { SecurityTab } from '@/lib/events';

export type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type VulnScanStatus = 'in_progress' | 'completed' | 'failed';
export type VulnScanTrigger = 'manual' | 'scheduled' | 'deploy' | 'deploy-preflight';

export type PolicyBlockReason = 'severity' | 'kev' | 'fixable';

export interface ScanPolicyEvaluation {
  policyId: number;
  policyName: string;
  maxSeverity: VulnSeverity;
  // Inputs that matched (severity / kev / fixable). Empty for evaluations
  // persisted before reason tracking; the banner falls back to a plain
  // violation notice in that case.
  reasons: PolicyBlockReason[];
  violated: boolean;
}

export type TrivySource = 'managed' | 'host' | 'none';

export interface TrivyStatus {
  available: boolean;
  version: string | null;
  source: TrivySource;
  autoUpdate: boolean;
  honorSuppressionsOnDeploy: boolean;
  preDeployScanAdvisory: boolean;
  /** Outbound CVE exploit-intel (KEV + EPSS) fetch is enabled for this node. */
  cveIntelEnabled: boolean;
  busy: boolean;
}

/** One image's latest cached scan, shown in the pre-deploy advisory dialog. */
export interface PreDeployScanImageScan {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  highestSeverity: VulnSeverity | null;
  scannedAt: number;
}

export interface PreDeployScanImage {
  imageRef: string;
  scan: PreDeployScanImageScan | null;
}

export interface TrivyUpdateCheck {
  current: string | null;
  latest: string;
  updateAvailable: boolean;
  source: TrivySource;
}

export interface VulnerabilityScan {
  id: number;
  node_id: number;
  image_ref: string;
  image_digest: string | null;
  scanned_at: number;
  total_vulnerabilities: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  unknown_count: number;
  fixable_count: number;
  secret_count: number;
  misconfig_count: number;
  scanners_used: string;
  highest_severity: VulnSeverity | null;
  os_info: string | null;
  trivy_version: string | null;
  scan_duration_ms: number | null;
  triggered_by: VulnScanTrigger;
  status: VulnScanStatus;
  error: string | null;
  stack_context: string | null;
  policy_evaluation?: ScanPolicyEvaluation | null;
  /** Tri-state Compose exposure for the scan-sheet badge: true = publicly
   *  exposed, false = internal only, null/absent = no descriptor cached. */
  publicly_exposed?: boolean | null;
}

export interface SecretFinding {
  id: number;
  scan_id: number;
  rule_id: string;
  category: string | null;
  severity: VulnSeverity;
  title: string | null;
  target: string;
  start_line: number | null;
  end_line: number | null;
  match_excerpt: string | null;
}

export interface MisconfigFinding {
  id: number;
  scan_id: number;
  rule_id: string;
  check_id: string | null;
  severity: VulnSeverity;
  title: string | null;
  message: string | null;
  resolution: string | null;
  target: string;
  primary_url: string | null;
  acknowledged?: boolean;
  acknowledgement_id?: number;
  acknowledgement_reason?: string;
}

export interface MisconfigAcknowledgement {
  id: number;
  rule_id: string;
  stack_pattern: string | null;
  reason: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  replicated_from_control: number;
  active: boolean;
}

export interface VulnerabilityDetail {
  id: number;
  scan_id: number;
  vulnerability_id: string;
  pkg_name: string;
  installed_version: string;
  fixed_version: string | null;
  severity: VulnSeverity;
  title: string | null;
  description: string | null;
  primary_url: string | null;
  // Scan-intrinsic enrichment (nullable; absent on older scans). Drives the
  // CVSS chip and evidence tags. `status`: fixed / will_not_fix / end_of_life.
  status?: string | null;
  cvss_score?: number | null;
  cvss_vector?: string | null;
  cvss_source?: string | null;
  vendor_severity?: VulnSeverity | null;
  purl?: string | null;
  pkg_path?: string | null;
  layer_digest?: string | null;
  // Read-time exploit intel join (KEV / EPSS), attached by the vulnerabilities
  // endpoint. Optional: absent until the intel cache has populated.
  kev?: boolean;
  epss_score?: number | null;
  epss_percentile?: number | null;
  suppressed?: boolean;
  suppression_id?: number;
  suppression_reason?: string;
}

/** Triage decision states (mirrors the backend TriageStatus). */
export type TriageStatus =
  | 'needs_review' | 'affected' | 'not_affected' | 'accepted' | 'fixed' | 'false_positive' | 'ignored';

export interface CveSuppression {
  id: number;
  cve_id: string;
  pkg_name: string | null;
  image_pattern: string | null;
  reason: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  replicated_from_control: number;
  active: boolean;
  status?: TriageStatus;
  justification?: string | null;
}

export interface ScanSummary {
  image_ref: string;
  highest_severity: VulnSeverity | null;
  scanned_at: number;
  scan_id: number;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  fixable: number;
  secret_count: number;
  misconfig_count: number;
}

export interface ScanPolicy {
  id: number;
  name: string;
  node_id: number | null;
  node_identity: string;
  stack_pattern: string | null;
  max_severity: VulnSeverity;
  block_on_deploy: number;
  enabled: number;
  /** Block when an image's highest non-suppressed severity meets max_severity. */
  block_on_severity: number;
  /** Block when any non-suppressed CVE is in the CISA known-exploited (KEV) set. */
  block_on_kev: number;
  /** Block when any non-suppressed Critical/High finding has a fix available. */
  block_on_fixable: number;
  replicated_from_control: number;
  created_at: number;
  updated_at: number;
}

export type FleetRole = 'control' | 'replica';

export interface ScanCompareVulnerability {
  vulnerability_id: string;
  pkg_name: string;
  severity: VulnSeverity;
  installed_version?: string;
  fixed_version?: string | null;
  primary_url?: string | null;
  suppressed?: boolean;
  suppression_id?: number;
  suppression_reason?: string;
}

export interface ScanCompareResult {
  scanA: { id: number; scanned_at: number; image_ref: string; total_vulnerabilities?: number };
  scanB: { id: number; scanned_at: number; image_ref: string; total_vulnerabilities?: number };
  added: ScanCompareVulnerability[];
  removed: ScanCompareVulnerability[];
  unchanged: ScanCompareVulnerability[];
  truncated?: boolean;
  row_limit?: number;
}

/** The Security page's action posture (the masthead verdict). Mirrors the
 *  backend `SecurityPostureState`. */
export type SecurityPostureState = 'Action needed' | 'Monitoring' | 'Secure' | 'Unknown';

/** Kinds of posture reason the backend can report. */
export type PostureReasonKind =
  | 'fixable_cve'
  | 'known_exploited'
  | 'secret'
  | 'dangerous_compose'
  | 'public_exposure'
  | 'stale_scan'
  | 'failed_scan'
  | 'needs_review';

/** One structured reason explaining why the security posture is what it is. */
export interface PostureReason {
  kind: PostureReasonKind;
  count: number;
  severity: 'blocker' | 'review' | 'info';
  label: string;
  description: string;
  targetTab: SecurityTab;
}

/** Highest-priority action for the masthead CTA. */
export interface PostureAction {
  label: string;
  targetTab: SecurityTab;
  /** The reason kind behind this action, so the UI can target the affected
   *  items precisely (e.g. filter Images to fixable findings). */
  kind: PostureReasonKind;
}

/** Node-scoped security posture rollup for the Security page Overview. */
export interface SecurityOverview {
  scannedImages: number;
  critical: number;
  high: number;
  fixable: number;
  secrets: number;
  misconfigs: number;
  staleScans: number;
  failedScans: number;
  lastSuccessfulScanAt: number | null;
  scanner: {
    available: boolean;
    version: string | null;
    source: TrivySource;
    autoUpdate: boolean;
  };
  deployEnforcement: {
    honorSuppressionsOnDeploy: boolean;
    /** Approximate count of enabled block-on-deploy policies eligible for this node. */
    eligibleBlockPolicies: number;
  };
  // Posture facts. Optional because an older remote node (reached through the
  // proxy) may not report them; the masthead falls back to a local derivation.
  // Counts are facts; `posture` is the authoritative derived verb.
  rawCritical?: number;
  rawHigh?: number;
  fixableCriticalHigh?: number;
  knownExploited?: number;
  publiclyExposed?: number;
  dangerousCompose?: number;
  needsReview?: number;
  accepted?: number;
  notAffected?: number;
  /** Total actionable items, for the "N actions" affordance. */
  actionable?: number;
  posture?: SecurityPostureState;
  /** True when the bounded posture pass hit its row cap on this node. */
  posturePartial?: boolean;
  /** Structured reasons for the posture (blockers, review, info). Optional for
   *  older remote nodes that do not report them. */
  postureReasons?: PostureReason[];
  /** Highest-priority action for the masthead CTA, or null when no blockers. */
  primaryAction?: PostureAction | null;
}

/** Which detail tab the scan sheet opens on. Matches VulnerabilityScanSheet's tabs. */
export type ScanDetailTab = 'vulns' | 'secrets' | 'misconfigs';

/** Scanner kinds a scan request can run. Mirrors the backend's accepted set. */
export type ScannerKind = 'vuln' | 'secret';

/** One day's Critical/High totals for the Security overview risk-trend chart. */
export interface SecurityRiskTrendPoint {
  date: string;
  critical: number;
  high: number;
}

/** One actionable Critical/High finding for the overview exploit-intel charts
 *  (Top exploit-risk list + CVSS-by-EPSS quadrant). Intel fields are null until
 *  CveIntelService has fetched; cvss_score is null on pre-enrichment scans. */
export interface ExploitIntelFinding {
  vulnerability_id: string;
  image_ref: string;
  scan_id: number;
  severity: VulnSeverity;
  cvss_score: number | null;
  epss_score: number | null;
  epss_percentile: number | null;
  kev: boolean;
  fixed_version: string | null;
}

export interface ExploitIntelOverview {
  items: ExploitIntelFinding[];
  truncated: boolean;
}
