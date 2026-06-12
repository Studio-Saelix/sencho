export type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type VulnScanStatus = 'in_progress' | 'completed' | 'failed';
export type VulnScanTrigger = 'manual' | 'scheduled' | 'deploy' | 'deploy-preflight';

export interface ScanPolicyEvaluation {
  policyId: number;
  policyName: string;
  maxSeverity: VulnSeverity;
  violated: boolean;
}

export type TrivySource = 'managed' | 'host' | 'none';

export interface TrivyStatus {
  available: boolean;
  version: string | null;
  source: TrivySource;
  autoUpdate: boolean;
  honorSuppressionsOnDeploy: boolean;
  busy: boolean;
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
  suppressed?: boolean;
  suppression_id?: number;
  suppression_reason?: string;
}

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

export type PolicyRuleEnforcement = 'warning' | 'enforceable';

export interface PolicyPackRule {
  id: string;
  name: string;
  severity: Exclude<VulnSeverity, 'UNKNOWN'>;
  whatItChecks: string;
  why: string;
  howToFix: string;
  enforcement: PolicyRuleEnforcement;
}

export interface PolicyPack {
  id: string;
  name: string;
  tagline: string;
  tierCopy: string;
  rules: PolicyPackRule[];
}
