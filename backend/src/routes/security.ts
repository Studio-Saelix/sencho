import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requirePaid } from '../middleware/tierGates';
import { trivyInstallLimiter } from '../middleware/rateLimiters';
import TrivyService, { SbomFormat } from '../services/TrivyService';
import TrivyInstaller from '../services/TrivyInstaller';
import { DatabaseService, parsePolicyEvaluation, type VulnerabilityScan, type VulnSeverity } from '../services/DatabaseService';
import { ComposeService } from '../services/ComposeService';
import { isValidStackName } from '../utils/validation';
import { FleetSyncService } from '../services/FleetSyncService';
import { LicenseService } from '../services/LicenseService';
import { validateImageRef } from '../utils/image-ref';
import { applySuppressions, isTriageStatus, isTriageJustification } from '../utils/suppression-filter';
import { applyMisconfigAcknowledgements } from '../utils/misconfig-ack-filter';
import { generateSarif } from '../services/SarifExporter';
import { generateOpenVex } from '../services/OpenVexExporter';
import { deriveSecurityPosture, derivePostureReasons, HIGH_EPSS_THRESHOLD, type SecurityPostureFacts, type SecurityPostureState, type PostureReason, type PostureAction } from '../services/securityPosture';
import { buildExposedImageMap } from '../services/preflight/exposure';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { blockIfReplica } from '../middleware/fleetSyncGuards';
import { validateStackPatternForRedos } from './fleet';
import { FINDING_SEVERITIES, POLICY_SEVERITIES } from '../utils/severity';
import { isNoOpBlockingPolicy } from '../utils/policy-risk';
import { DEFAULT_POLICY_PACKS } from '../services/policy-packs';
import { getTerminalWs, DEPLOY_SESSION_HEADER } from '../websocket/generic';

const CVE_ID_RE = /^(CVE-\d{4}-\d{4,}|GHSA-[\w-]{14,})$/;
// Trivy emits misconfig rule ids in two shapes that Sencho persists verbatim:
// short alpha-numeric codes (e.g. "DS002") and the AVD-prefixed long form
// (e.g. "AVD-DS-0002"). Allow either, plus underscores for forward-compat.
const MISCONFIG_RULE_RE = /^[A-Z0-9][A-Z0-9_-]{0,199}$/i;

// Strip control characters and cap length so an operator-supplied pkg or image
// pattern cannot inject a fake audit row by smuggling a newline plus a forged
// `cve_suppression.delete:` prefix. Validators on the route reject overlength
// pkg/image strings but do not constrain the charset.
function sanitiseScopeFragment(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return stripped.length > max ? stripped.slice(0, max) + '…' : stripped;
}

// Summarise a suppression for the audit log without leaking the reason text.
// Reason is free-form and could carry incident-tracker IDs or vendor secrets;
// scope (CVE id, pkg, image) is non-sensitive. The fields list emitted on
// update operations does name `reason` when it changed, which lets an audit
// reader see *when* a reason was rotated even though the contents stay private.
function describeSuppressionScope(s: { cve_id: string; pkg_name: string | null; image_pattern: string | null }): string {
  const pinned: string[] = [];
  if (s.pkg_name) pinned.push(`pkg=${sanitiseScopeFragment(s.pkg_name, 200)}`);
  if (s.image_pattern) pinned.push(`image=${sanitiseScopeFragment(s.image_pattern, 300)}`);
  return pinned.length > 0 ? `${s.cve_id} (${pinned.join(', ')})` : s.cve_id;
}

// Misconfig ack scope summary mirrors the suppression variant. Reason is
// elided on purpose; rule_id and stack_pattern are non-sensitive.
function describeAckScope(a: { rule_id: string; stack_pattern: string | null }): string {
  const pinned: string[] = [];
  if (a.stack_pattern) pinned.push(`stack=${sanitiseScopeFragment(a.stack_pattern, 300)}`);
  return pinned.length > 0 ? `${a.rule_id} (${pinned.join(', ')})` : a.rule_id;
}

function recordSecurityAudit(
  req: Request,
  res: Response,
  prefix: 'cve_suppression' | 'misconfig_ack',
  action: 'create' | 'update' | 'delete',
  summary: string,
): void {
  try {
    DatabaseService.getInstance().insertAuditLog({
      timestamp: Date.now(),
      username: req.user?.username ?? 'unknown',
      method: req.method,
      path: req.originalUrl,
      status_code: res.statusCode,
      node_id: null,
      ip_address: req.ip || 'unknown',
      summary: `${prefix}.${action}: ${summary}`,
    });
  } catch (err) {
    console.warn('[Security] Audit log write failed:', getErrorMessage(err, 'unknown'));
  }
}

function recordSuppressionAudit(
  req: Request,
  res: Response,
  action: 'create' | 'update' | 'delete',
  summary: string,
): void {
  recordSecurityAudit(req, res, 'cve_suppression', action, summary);
}

function recordAckAudit(
  req: Request,
  res: Response,
  action: 'create' | 'update' | 'delete',
  summary: string,
): void {
  recordSecurityAudit(req, res, 'misconfig_ack', action, summary);
}

function parseScannersInput(raw: unknown): readonly ('vuln' | 'secret')[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Set<'vuln' | 'secret'>();
  for (const item of raw) {
    if (item !== 'vuln' && item !== 'secret') return null;
    out.add(item);
  }
  return Array.from(out) as readonly ('vuln' | 'secret')[];
}

function shapeScanForResponse(scan: VulnerabilityScan): Omit<VulnerabilityScan, 'policy_evaluation'> & {
  policy_evaluation: ReturnType<typeof parsePolicyEvaluation>;
} {
  const { policy_evaluation, ...rest } = scan;
  return { ...rest, policy_evaluation: parsePolicyEvaluation(policy_evaluation) };
}

// A completed scan whose latest run is older than this is considered "stale" in
// the Security overview. Named so the route and its tests share one value.
export const STALE_SCAN_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Shape of the /overview response. Mirrors the frontend `SecurityOverview` type
// (frontend/src/types/security.ts); annotating the response below makes a
// renamed or dropped field a compile error here instead of an undefined read in
// the UI. Keep the two in sync.
interface SecurityOverviewResponse {
  scannedImages: number;
  critical: number;
  high: number;
  fixable: number;
  secrets: number;
  misconfigs: number;
  staleScans: number;
  failedScans: number;
  lastSuccessfulScanAt: number | null;
  scanner: { available: boolean; version: string | null; source: 'managed' | 'host' | 'none'; autoUpdate: boolean };
  deployEnforcement: { honorSuppressionsOnDeploy: boolean; eligibleBlockPolicies: number };
  // Posture facts. Counts are facts; the verb (`posture`) is derived in one
  // place (`deriveSecurityPosture`). `critical`/`high` above stay for back-compat
  // and are relabeled "scanner detections" in the UI; `rawCritical`/`rawHigh`
  // are their posture-named aliases. `knownExploited` and `publiclyExposed` come
  // online with the CVE-intel and Compose-exposure phases (0 until then).
  rawCritical: number;
  rawHigh: number;
  fixableCriticalHigh: number;
  knownExploited: number;
  publiclyExposed: number;
  dangerousCompose: number;
  needsReview: number;
  accepted: number;
  notAffected: number;
  /** Total actionable items, for the "N actions" affordance. */
  actionable: number;
  posture: SecurityPostureState;
  /** True when the bounded posture pass hit its row cap on this node. */
  posturePartial: boolean;
  /** Structured reasons explaining the posture (blockers, review, info). */
  postureReasons: PostureReason[];
  /** Highest-priority action for the masthead CTA, or null when no blockers. */
  primaryAction: PostureAction | null;
}

export const securityRouter = Router();

securityRouter.get('/trivy-status', authMiddleware, (_req: Request, res: Response) => {
  const svc = TrivyService.getInstance();
  const installer = TrivyInstaller.getInstance();
  const settings = DatabaseService.getInstance().getGlobalSettings();
  res.json({
    available: svc.isTrivyAvailable(),
    version: svc.getVersion(),
    source: svc.getSource(),
    autoUpdate: settings.trivy_auto_update === '1',
    honorSuppressionsOnDeploy: settings.deploy_block_honor_suppressions === '1',
    preDeployScanAdvisory: settings.pre_deploy_scan_advisory === '1',
    cveIntelEnabled: settings.cve_intel_enabled !== '0',
    busy: installer.isBusy(),
  });
});

securityRouter.post('/trivy-install', trivyInstallLimiter, authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (svc.getSource() === 'host') {
    res.status(409).json({ error: 'Trivy is already installed on the host PATH. Remove the host binary before managing it from Sencho.' });
    return;
  }
  if (svc.getSource() === 'managed') {
    res.status(409).json({ error: 'Trivy is already installed. Use the update endpoint instead.' });
    return;
  }
  try {
    const { version } = await TrivyInstaller.getInstance().install();
    await svc.detectTrivy();
    res.json({ version, source: svc.getSource(), available: svc.isTrivyAvailable() });
  } catch (err) {
    const msg = getErrorMessage(err, 'Install failed');
    console.error('[Security] Trivy install failed:', msg);
    res.status(500).json({ error: msg });
  }
});

securityRouter.delete('/trivy-install', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (svc.getSource() !== 'managed') {
    res.status(409).json({ error: 'No managed Trivy install to remove' });
    return;
  }
  try {
    await TrivyInstaller.getInstance().uninstall();
    await svc.detectTrivy();
    res.json({ available: svc.isTrivyAvailable(), source: svc.getSource() });
  } catch (err) {
    const msg = getErrorMessage(err, 'Uninstall failed');
    console.error('[Security] Trivy uninstall failed:', msg);
    res.status(500).json({ error: msg });
  }
});

securityRouter.get('/trivy-update-check', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const svc = TrivyService.getInstance();
  if (svc.getSource() !== 'managed') {
    res.status(409).json({ error: 'Update checks only apply to managed installs' });
    return;
  }
  try {
    const result = await TrivyInstaller.getInstance().checkForUpdate(svc.getVersion(), svc.getSource());
    res.json(result);
  } catch (err) {
    const msg = getErrorMessage(err, 'Update check failed');
    console.error('[Security] Trivy update check failed:', msg);
    res.status(502).json({ error: msg });
  }
});

securityRouter.post('/trivy-update', trivyInstallLimiter, authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (svc.getSource() !== 'managed') {
    res.status(409).json({ error: 'Update only applies to managed installs' });
    return;
  }
  try {
    const { version } = await TrivyInstaller.getInstance().update();
    await svc.detectTrivy();
    res.json({ version, source: svc.getSource(), available: svc.isTrivyAvailable() });
  } catch (err) {
    const msg = getErrorMessage(err, 'Update failed');
    console.error('[Security] Trivy update failed:', msg);
    res.status(500).json({ error: msg });
  }
});

securityRouter.put('/trivy-auto-update', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const enabled = req.body?.enabled === true;
  try {
    DatabaseService.getInstance().updateGlobalSetting('trivy_auto_update', enabled ? '1' : '0');
    res.json({ autoUpdate: enabled });
  } catch (err) {
    const msg = getErrorMessage(err, 'Failed to update setting');
    console.error('[Security] Trivy auto-update toggle failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// Outbound CVE exploit-intel (KEV + EPSS) fetch toggle. Per-instance: the
// background CveIntelService on each node reads its own local setting, so this
// configures whichever node is active. Default on; off suits air-gapped hosts.
securityRouter.put('/cve-intel-enabled', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const enabled = req.body?.enabled === true;
  try {
    DatabaseService.getInstance().updateGlobalSetting('cve_intel_enabled', enabled ? '1' : '0');
    res.json({ cveIntelEnabled: enabled });
  } catch (err) {
    const msg = getErrorMessage(err, 'Failed to update setting');
    console.error('[Security] CVE intel toggle failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// When enabled, the pre-deploy block policy re-derives image severity from
// suppression-filtered findings, so an accepted CVE no longer blocks a deploy.
// Per-instance setting (not fleet-replicated): the gate runs on the node that
// deploys, against that node's own replicated suppression copy. Default off.
securityRouter.put('/deploy-block-honor-suppressions', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  // Require an explicit boolean so a stringy `"1"` cannot silently disable the
  // gate (this toggle weakens a deploy block, so intent must be unambiguous).
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  const enabled = req.body.enabled;
  try {
    DatabaseService.getInstance().updateGlobalSetting('deploy_block_honor_suppressions', enabled ? '1' : '0');
    res.json({ honorSuppressionsOnDeploy: enabled });
  } catch (err) {
    const msg = getErrorMessage(err, 'Failed to update setting');
    console.error('[Security] Deploy-block honor-suppressions toggle failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// Pre-deploy scan advisory toggle. When on, a manual stack deploy first shows
// the latest cached scan severity for each image so the operator can review it
// before deploying. Visibility only: it never blocks (that is the paid
// deploy-block policy). Per-instance, admin-only, all tiers. Default off.
securityRouter.put('/pre-deploy-scan-advisory', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  const enabled = req.body.enabled;
  try {
    DatabaseService.getInstance().updateGlobalSetting('pre_deploy_scan_advisory', enabled ? '1' : '0');
    res.json({ preDeployScanAdvisory: enabled });
  } catch (err) {
    const msg = getErrorMessage(err, 'Failed to update setting');
    console.error('[Security] Pre-deploy scan advisory toggle failed:', msg);
    res.status(500).json({ error: msg });
  }
});

interface PreDeployImageSummary {
  imageRef: string;
  scan: {
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    highestSeverity: VulnSeverity | null;
    scannedAt: number;
  } | null;
}

// Read-only advisory data for the pre-deploy dialog: the latest cached,
// node-scoped, vulnerability-bearing scan for each image declared in the stack's
// compose file. Cache-only by design (never triggers a scan) so it stays fast
// and side-effect-free on the deploy path, and short-circuits when the advisory
// is off so the common path does no compose/digest work. No tier gate
// (visibility is free); matches the auth model of the other /scans read routes.
securityRouter.get('/stacks/:stackName/pre-deploy-summary', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const settings = DatabaseService.getInstance().getGlobalSettings();
  if (settings.pre_deploy_scan_advisory !== '1') {
    res.json({ enabled: false });
    return;
  }
  const stackName = String(req.params.stackName);
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  const nodeId = req.nodeId;
  try {
    const db = DatabaseService.getInstance();
    const trivy = TrivyService.getInstance();
    const imageRefs = await ComposeService.getInstance(nodeId).listStackImages(stackName);
    const images: PreDeployImageSummary[] = [];
    for (const imageRef of imageRefs) {
      const digest = await trivy.getImageDigest(imageRef, nodeId);
      const scan = digest ? db.getLatestVulnScanByDigestForNode(digest, nodeId) : null;
      images.push({
        imageRef,
        scan: scan
          ? {
              criticalCount: scan.critical_count,
              highCount: scan.high_count,
              mediumCount: scan.medium_count,
              lowCount: scan.low_count,
              highestSeverity: scan.highest_severity,
              scannedAt: scan.scanned_at,
            }
          : null,
      });
    }
    res.json({ enabled: true, images });
  } catch (err) {
    const msg = getErrorMessage(err, 'Failed to build pre-deploy summary');
    console.error('[Security] Pre-deploy summary failed for %s:', sanitizeForLog(stackName), sanitizeForLog(msg));
    // Keep the detail in the server log only: this path runs docker compose and
    // image inspect, whose error text can carry filesystem or daemon detail.
    res.status(500).json({ error: 'Failed to build pre-deploy summary' });
  }
});

securityRouter.post('/scan', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (!svc.isTrivyAvailable()) {
    res.status(503).json({ error: 'Trivy is not available on this host' });
    return;
  }
  const rawImageRef = typeof req.body?.imageRef === 'string' ? req.body.imageRef.trim() : '';
  if (!rawImageRef) {
    res.status(400).json({ error: 'imageRef is required' });
    return;
  }
  if (!validateImageRef(rawImageRef)) {
    res.status(400).json({ error: 'Invalid imageRef format' });
    return;
  }
  const imageRef = rawImageRef;
  const stackContext = typeof req.body?.stackName === 'string' ? req.body.stackName : null;
  const force = req.body?.force === true;
  const scanners = parseScannersInput(req.body?.scanners);
  if (scanners === null) {
    res.status(400).json({ error: 'scanners must be an array of "vuln" or "secret"' });
    return;
  }
  const nodeId = req.nodeId;
  if (svc.isScanning(nodeId, imageRef)) {
    res.status(409).json({ error: 'Already scanning this image' });
    return;
  }
  const scanId = svc.beginScan(imageRef, nodeId, 'manual', stackContext, scanners);
  res.status(202).json({ scanId });

  svc.finishScan(scanId, imageRef, nodeId, { useCache: !force, scanners }).catch((err) => {
    console.error('[Security] Scan failed for %s:', sanitizeForLog(imageRef), sanitizeForLog((err as Error).message));
  });
});

securityRouter.post('/scan/stack', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (!svc.isTrivyAvailable()) {
    res.status(503).json({ error: 'Trivy is not available on this host' }); return;
  }
  const stackName = typeof req.body?.stackName === 'string' ? req.body.stackName.trim() : '';
  if (!stackName || !/^[a-zA-Z0-9_-]+$/.test(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' }); return;
  }
  if (svc.isScanningStack(req.nodeId, stackName)) {
    res.status(409).json({ error: 'Already scanning this stack' }); return;
  }
  try {
    const scan = await svc.scanComposeStack(req.nodeId, stackName, 'manual');
    res.status(201).json(scan);
  } catch (error) {
    const message = (error as Error).message || '';
    if (message === 'Invalid stack path' || message.startsWith('No compose file found')) {
      res.status(404).json({ error: message }); return;
    }
    if (message === 'Already scanning this stack') {
      res.status(409).json({ error: message }); return;
    }
    console.error('[Security] Stack config scan failed:', error);
    res.status(500).json({ error: message || 'Failed to scan stack' });
  }
});

// On-demand node-wide scan: images for the selected scanners (vuln/secret) and,
// when requested, every stack's compose config for misconfigurations. Streams
// sanitized progress to the deploy-feedback terminal when the client opened one.
securityRouter.post('/scan-node', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (!svc.isTrivyAvailable()) {
    res.status(503).json({ error: 'Trivy is not available on this host' });
    return;
  }
  const body = req.body ?? {};
  if (![body.vulns, body.secrets, body.misconfig].every((v) => v === undefined || typeof v === 'boolean')) {
    res.status(400).json({ error: 'vulns, secrets and misconfig must be booleans' });
    return;
  }
  const vulns = body.vulns === true;
  const secrets = body.secrets === true;
  const misconfig = body.misconfig === true;
  if (!vulns && !secrets && !misconfig) {
    res.status(400).json({ error: 'Select at least one scan type' });
    return;
  }
  const nodeId = req.nodeId;

  // Stream progress to the deploy-feedback terminal only when the client supplied
  // a session id: a bare getTerminalWs(undefined) falls back to the most recent
  // terminal and could cross-stream this scan into an unrelated deploy. scanNode
  // emits only counts and rule ids, never raw secret values; the wrapper here
  // additionally strips CR/LF and caps line length before sending.
  const sessionId = req.get(DEPLOY_SESSION_HEADER);
  const ws = sessionId ? getTerminalWs(sessionId) : undefined;
  const onProgress = ws
    ? (line: string): void => {
        try { ws.send(line.replace(/[\r\n]+/g, ' ').slice(0, 2000) + '\r\n'); }
        catch { /* socket closed mid-scan; the scan still runs to completion */ }
      }
    : undefined;

  try {
    DatabaseService.getInstance().insertAuditLog({
      timestamp: Date.now(),
      username: req.user?.username ?? 'unknown',
      method: req.method,
      path: req.originalUrl || req.url,
      status_code: 200,
      node_id: nodeId,
      ip_address: req.ip ?? '',
      summary: `node-wide scan triggered (vulns=${vulns} secrets=${secrets} misconfig=${misconfig})`,
    });
  } catch (auditErr) {
    console.warn('[Security] failed to record node-scan audit log:', getErrorMessage(auditErr, 'unknown'));
  }

  try {
    const result = await svc.scanNode(nodeId, { vulns, secrets, misconfig }, 'manual', onProgress);
    res.status(200).json(result);
  } catch (err) {
    const message = getErrorMessage(err, 'Failed to run node scan');
    if (message === 'Already scanning this node') {
      res.status(409).json({ error: message });
      return;
    }
    console.error('[Security] node-wide scan failed:', sanitizeForLog(message));
    res.status(500).json({ error: 'Failed to run node scan' });
  }
});

securityRouter.get('/scans', authMiddleware, (req: Request, res: Response) => {
  try {
    const imageRef = typeof req.query.imageRef === 'string' ? req.query.imageRef : undefined;
    const imageRefLike =
      typeof req.query.imageRefLike === 'string' && req.query.imageRefLike.trim()
        ? req.query.imageRefLike.trim()
        : undefined;
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status =
      statusParam === 'completed' || statusParam === 'in_progress' || statusParam === 'failed'
        ? statusParam
        : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const result = DatabaseService.getInstance().getVulnerabilityScans(req.nodeId, {
      imageRef,
      imageRefLike,
      status,
      limit,
      offset,
    });
    res.json({ ...result, items: result.items.map(shapeScanForResponse) });
  } catch (error) {
    console.error('[Security] Failed to list scans:', error);
    res.status(500).json({ error: 'Failed to list scans' });
  }
});

securityRouter.get('/scans/:scanId', authMiddleware, (req: Request, res: Response): void => {
  const scanId = Number(req.params.scanId);
  if (!Number.isFinite(scanId)) {
    res.status(400).json({ error: 'Invalid scan id' }); return;
  }
  const db = DatabaseService.getInstance();
  const scan = db.getVulnerabilityScan(scanId);
  if (!scan || scan.node_id !== req.nodeId) {
    res.status(404).json({ error: 'Scan not found' }); return;
  }
  // Attach the exposure status for the scan sheet badge (tri-state:
  // true = public, false = internal, absent = no descriptor cached).
  const exposures = db.getStackExposures(req.nodeId);
  const exposedMap = buildExposedImageMap(
    exposures.map((r) => {
      try { return JSON.parse(r.descriptor); } catch { return null; }
    }).filter(Boolean),
  );
  const publiclyExposed = exposedMap.get(scan.image_ref) ?? null;
  res.json({ ...shapeScanForResponse(scan), publicly_exposed: publiclyExposed });
});

securityRouter.get(
  '/scans/:scanId/vulnerabilities',
  authMiddleware,
  (req: Request, res: Response): void => {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId)) {
      res.status(400).json({ error: 'Invalid scan id' }); return;
    }
    const db = DatabaseService.getInstance();
    const scan = db.getVulnerabilityScan(scanId);
    if (!scan || scan.node_id !== req.nodeId) {
      res.status(404).json({ error: 'Scan not found' }); return;
    }
    const severity = typeof req.query.severity === 'string'
      ? (req.query.severity.toUpperCase() as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN')
      : undefined;
    if (severity && !FINDING_SEVERITIES.has(severity)) {
      res.status(400).json({ error: 'Invalid severity filter' }); return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const result = db.getVulnerabilityDetails(scanId, { severity, limit, offset });
    const suppressions = db.getCveSuppressions();
    const enriched = applySuppressions(result.items, scan.image_ref, suppressions);
    // Join time-varying exploit intel at read time (KEV/EPSS), keyed by CVE id;
    // never frozen onto the row, so a CVE entering KEV later surfaces on this scan.
    const intel = db.getCveIntel(enriched.map((v) => v.vulnerability_id));
    const withIntel = enriched.map((v) => {
      const i = intel.get(v.vulnerability_id);
      return {
        ...v,
        kev: i?.kev ?? false,
        epss_score: i?.epssScore ?? null,
        epss_percentile: i?.epssPercentile ?? null,
      };
    });
    res.json({ ...result, items: withIntel });
  },
);

securityRouter.get(
  '/scans/:scanId/secrets',
  authMiddleware,
  (req: Request, res: Response): void => {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId)) {
      res.status(400).json({ error: 'Invalid scan id' }); return;
    }
    const db = DatabaseService.getInstance();
    const scan = db.getVulnerabilityScan(scanId);
    if (!scan || scan.node_id !== req.nodeId) {
      res.status(404).json({ error: 'Scan not found' }); return;
    }
    const severity = typeof req.query.severity === 'string'
      ? (req.query.severity.toUpperCase() as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN')
      : undefined;
    if (severity && !FINDING_SEVERITIES.has(severity)) {
      res.status(400).json({ error: 'Invalid severity filter' }); return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    res.json(db.getSecretFindings(scanId, { severity, limit, offset }));
  },
);

securityRouter.get(
  '/scans/:scanId/misconfigs',
  authMiddleware,
  (req: Request, res: Response): void => {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId)) {
      res.status(400).json({ error: 'Invalid scan id' }); return;
    }
    const db = DatabaseService.getInstance();
    const scan = db.getVulnerabilityScan(scanId);
    if (!scan || scan.node_id !== req.nodeId) {
      res.status(404).json({ error: 'Scan not found' }); return;
    }
    const severity = typeof req.query.severity === 'string'
      ? (req.query.severity.toUpperCase() as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN')
      : undefined;
    if (severity && !FINDING_SEVERITIES.has(severity)) {
      res.status(400).json({ error: 'Invalid severity filter' }); return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const result = db.getMisconfigFindings(scanId, { severity, limit, offset });
    const acks = db.getMisconfigAcknowledgements();
    const enriched = applyMisconfigAcknowledgements(result.items, scan.stack_context, acks);
    res.json({ ...result, items: enriched });
  },
);

securityRouter.get('/image-summaries', authMiddleware, (req: Request, res: Response) => {
  try {
    const summaries = DatabaseService.getInstance().getImageScanSummaries(req.nodeId);
    res.json(summaries);
  } catch (error) {
    console.error('[Security] Failed to fetch image summaries:', error);
    res.status(500).json({ error: 'Failed to fetch image summaries' });
  }
});

// Node-scoped security posture rollup for the Security page Overview. Read-only,
// auth-only (Community). Counts derive from the latest-completed-scan-per-image
// summaries plus two precise helpers; the deploy-enforcement block is this
// node's read-only posture, not policy management.
securityRouter.get('/overview', authMiddleware, (req: Request, res: Response): void => {
  try {
    const db = DatabaseService.getInstance();
    const summaries = Object.values(db.getImageScanSummaries(req.nodeId));
    const settings = db.getGlobalSettings();
    const svc = TrivyService.getInstance();

    const now = Date.now();
    let scannedImages = 0;
    let critical = 0;
    let high = 0;
    let fixable = 0;
    let secrets = 0;
    let misconfigs = 0;
    let staleScans = 0;
    let lastSuccessfulScanAt: number | null = null;

    for (const s of summaries) {
      // Severity, secret, and misconfig totals are summed across every summary
      // (real images and stack/config scans alike). Only scannedImages excludes
      // the stack/config rows (stored under a "stack:" image_ref), since those
      // are stacks, not images.
      if (!s.image_ref.startsWith('stack:')) scannedImages += 1;
      critical += s.critical;
      high += s.high;
      fixable += s.fixable;
      secrets += s.secret_count;
      misconfigs += s.misconfig_count;
      if (now - s.scanned_at > STALE_SCAN_THRESHOLD_MS) staleScans += 1;
      if (lastSuccessfulScanAt === null || s.scanned_at > lastSuccessfulScanAt) {
        lastSuccessfulScanAt = s.scanned_at;
      }
    }

    // Posture facts that depend on suppressions/acks (which change without a
    // rescan) are computed at read time over a bounded set of Critical/High
    // findings, grouped per image so the existing read-time filters apply
    // unchanged. The pass is capped; `posturePartial` flags a truncated node.
    const cveSuppressions = db.getCveSuppressions();
    const critHigh = db.getLatestCritHighVulnFindingsForNode(req.nodeId);
    // Exploit intel is joined at read time by CVE id (never frozen onto the row).
    const intel = db.getCveIntel(critHigh.items.map((f) => f.vulnerability_id));
    const critHighByImage = new Map<string, Array<{ vulnerability_id: string; pkg_name: string; fixed_version: string | null }>>();
    for (const f of critHigh.items) {
      const group = critHighByImage.get(f.image_ref);
      if (group) group.push(f);
      else critHighByImage.set(f.image_ref, [f]);
    }
    let fixableCriticalHigh = 0;
    let accepted = 0;
    let notAffected = 0;
    let needsReview = 0;
    let knownExploited = 0;
    for (const [imageRef, group] of critHighByImage) {
      for (const e of applySuppressions(group, imageRef, cveSuppressions)) {
        if (e.triage_status === 'needs_review') needsReview += 1;
        if (e.suppressed) {
          // A dismissing decision: not_affected is its own fact, the rest are "accepted".
          if (e.triage_status === 'not_affected') notAffected += 1;
          else accepted += 1;
          continue;
        }
        // Not dismissed (no decision, needs_review, or affected): still actionable.
        if (e.fixed_version) fixableCriticalHigh += 1;
        if (intel.get(e.vulnerability_id)?.kev) knownExploited += 1;
      }
    }

    const acks = db.getMisconfigAcknowledgements();
    const highMisconfigs = db.getLatestHighMisconfigFindingsForNode(req.nodeId);
    const misconfigByStack = new Map<string | null, Array<{ rule_id: string }>>();
    for (const f of highMisconfigs.items) {
      const group = misconfigByStack.get(f.stack_context);
      if (group) group.push(f);
      else misconfigByStack.set(f.stack_context, [f]);
    }
    let dangerousCompose = 0;
    for (const [stackContext, group] of misconfigByStack) {
      for (const e of applyMisconfigAcknowledgements(group, stackContext, acks)) {
        if (!e.acknowledged) dangerousCompose += 1;
      }
    }

    // Count distinct images that are publicly exposed AND have at least one
    // non-suppressed Critical/High finding. The exposure descriptor is cached
    // at deploy/update time, so this is O(stacks) + O(images), zero subprocess.
    const exposures = db.getStackExposures(req.nodeId);
    const exposedMap = buildExposedImageMap(
      exposures.map((r) => {
        try { return JSON.parse(r.descriptor); } catch { return null; }
      }).filter(Boolean),
    );
    let publiclyExposed = 0;
    let exposedBlocker = 0;
    let exposedReview = 0;
    for (const [imageRef, group] of critHighByImage) {
      if (exposedMap.get(imageRef) !== true) continue;
      publiclyExposed += 1;
      let hasUnsuppressedFinding = false;
      let hasKevOrFixOrHighEpss = false;
      for (const e of applySuppressions(group, imageRef, cveSuppressions)) {
        if (e.suppressed) continue;
        hasUnsuppressedFinding = true;
        if (
          e.fixed_version
          || intel.get(e.vulnerability_id)?.kev
          || (intel.get(e.vulnerability_id)?.epssScore ?? 0) >= HIGH_EPSS_THRESHOLD
        ) {
          hasKevOrFixOrHighEpss = true;
          break;
        }
      }
      if (!hasUnsuppressedFinding) continue; // fully dismissed
      if (hasKevOrFixOrHighEpss) exposedBlocker += 1;
      else exposedReview += 1;
    }

    const failedScans = db.countScansByStatus(req.nodeId, 'failed');

    const postureFacts: SecurityPostureFacts = {
      scannerAvailable: svc.isTrivyAvailable(),
      hasCompletedScan: lastSuccessfulScanAt !== null,
      fixableCriticalHigh,
      secrets,
      dangerousCompose,
      knownExploited,
      publiclyExposed,
      exposedBlocker,
      exposedReview,
      rawCritical: critical,
      rawHigh: high,
      staleScans,
      failedScans,
      needsReview,
    };
    const posture = deriveSecurityPosture(postureFacts);
    const { reasons: postureReasons, primaryAction } = derivePostureReasons(postureFacts);
    const actionable = fixableCriticalHigh + secrets + dangerousCompose + knownExploited + publiclyExposed;

    const overview: SecurityOverviewResponse = {
      scannedImages,
      critical,
      high,
      fixable,
      secrets,
      misconfigs,
      staleScans,
      failedScans,
      lastSuccessfulScanAt,
      scanner: {
        available: svc.isTrivyAvailable(),
        version: svc.getVersion(),
        source: svc.getSource(),
        autoUpdate: settings.trivy_auto_update === '1',
      },
      deployEnforcement: {
        honorSuppressionsOnDeploy: settings.deploy_block_honor_suppressions === '1',
        eligibleBlockPolicies: db.countEligibleBlockPolicies(
          req.nodeId,
          FleetSyncService.getRole(),
          FleetSyncService.getSelfIdentity(),
        ),
      },
      rawCritical: critical,
      rawHigh: high,
      fixableCriticalHigh,
      knownExploited,
      publiclyExposed,
      dangerousCompose,
      needsReview,
      accepted,
      notAffected,
      actionable,
      posture,
      posturePartial: critHigh.truncated || highMisconfigs.truncated,
      postureReasons,
      primaryAction,
    };
    res.json(overview);
  } catch (error) {
    console.error('[Security] Failed to build overview:', error);
    res.status(500).json({ error: 'Failed to build security overview' });
  }
});

// Daily Critical/High risk trend for the Security overview chart. Auth-only
// (Community), node-scoped. ?days clamps to 1..365 in the DB layer.
securityRouter.get('/overview/trend', authMiddleware, (req: Request, res: Response): void => {
  try {
    const days = req.query.days ? Number(req.query.days) : 30;
    const trend = DatabaseService.getInstance().getDailyRiskTrend(
      req.nodeId,
      Number.isFinite(days) ? days : 30,
    );
    res.json(trend);
  } catch (error) {
    console.error('[Security] Failed to build risk trend:', error);
    res.status(500).json({ error: 'Failed to build risk trend' });
  }
});

// One actionable Critical/High finding for the overview exploit-intel charts.
interface ExploitIntelFinding {
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

// Node-scoped, auth-only (Community). Returns the latest-scan Critical/High
// findings that are still actionable (dismissed triage decisions filtered out),
// enriched at read time with KEV/EPSS intel. Powers the Top exploit-risk list
// and the CVSS-by-EPSS quadrant on the Security overview. Bounded; `truncated`
// flags a capped node.
securityRouter.get('/overview/exploit-intel', authMiddleware, (req: Request, res: Response): void => {
  try {
    const db = DatabaseService.getInstance();
    const found = db.getLatestCritHighFindingsWithCvssForNode(req.nodeId);
    const suppressions = db.getCveSuppressions();
    const intel = db.getCveIntel(found.items.map((f) => f.vulnerability_id));
    const byImage = new Map<string, typeof found.items>();
    for (const f of found.items) {
      const group = byImage.get(f.image_ref);
      if (group) group.push(f);
      else byImage.set(f.image_ref, [f]);
    }
    const items: ExploitIntelFinding[] = [];
    for (const [imageRef, group] of byImage) {
      for (const e of applySuppressions(group, imageRef, suppressions)) {
        if (e.suppressed) continue; // decided findings are not part of the act-first view
        const i = intel.get(e.vulnerability_id);
        items.push({
          vulnerability_id: e.vulnerability_id,
          image_ref: imageRef,
          scan_id: e.scan_id,
          severity: e.severity,
          cvss_score: e.cvss_score,
          epss_score: i?.epssScore ?? null,
          epss_percentile: i?.epssPercentile ?? null,
          kev: i?.kev ?? false,
          fixed_version: e.fixed_version,
        });
      }
    }
    res.json({ items, truncated: found.truncated });
  } catch (error) {
    console.error('[Security] Failed to build exploit-intel overview:', error);
    res.status(500).json({ error: 'Failed to build exploit-intel overview' });
  }
});

// Static, read-only policy-pack catalog. Auth-only (Community), no DB, no
// enforcement. The frontend fetches this with localOnly so the global catalog
// is available regardless of which node is active.
securityRouter.get('/policy-packs', authMiddleware, (_req: Request, res: Response): void => {
  res.json(DEFAULT_POLICY_PACKS);
});

securityRouter.post('/sbom', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const svc = TrivyService.getInstance();
  if (!svc.isTrivyAvailable()) {
    res.status(503).json({ error: 'Trivy is not available on this host' }); return;
  }
  const imageRef = typeof req.body?.imageRef === 'string' ? req.body.imageRef.trim() : '';
  const formatRaw = typeof req.body?.format === 'string' ? req.body.format : 'spdx-json';
  if (!imageRef) {
    res.status(400).json({ error: 'imageRef is required' }); return;
  }
  if (!validateImageRef(imageRef)) {
    res.status(400).json({ error: 'Invalid imageRef format' }); return;
  }
  if (formatRaw !== 'spdx-json' && formatRaw !== 'cyclonedx') {
    res.status(400).json({ error: 'format must be spdx-json or cyclonedx' }); return;
  }
  try {
    const sbom = await svc.generateSBOM(imageRef, formatRaw as SbomFormat);
    const safeName = imageRef.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = formatRaw === 'spdx-json' ? 'spdx.json' : 'cdx.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    res.send(sbom);
  } catch (error) {
    console.error('[Security] SBOM generation failed:', error);
    res.status(500).json({ error: (error as Error).message || 'Failed to generate SBOM' });
  }
});

securityRouter.get(
  '/scans/:scanId/sarif',
  authMiddleware,
  (req: Request, res: Response): void => {
    if (!requireAdmin(req, res)) return;
    if (!requirePaid(req, res)) return;
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId)) {
      res.status(400).json({ error: 'Invalid scan id' }); return;
    }
    const db = DatabaseService.getInstance();
    const scan = db.getVulnerabilityScan(scanId);
    if (!scan || scan.node_id !== req.nodeId) {
      res.status(404).json({ error: 'Scan not found' }); return;
    }
    if (scan.status !== 'completed') {
      res.status(409).json({ error: 'Scan not complete' }); return;
    }
    try {
      // Hard cap to bound memory and serialization on pathological scans.
      // 5000 findings per type comfortably covers realistic scans; if any
      // type trips the cap we surface `truncated` in the SARIF metadata so
      // tooling can flag the export as partial.
      const SARIF_ROW_LIMIT = 5000;
      const detailsPage = db.getVulnerabilityDetails(scanId, { limit: SARIF_ROW_LIMIT });
      const secretsPage = db.getSecretFindings(scanId, { limit: SARIF_ROW_LIMIT });
      const misconfigsPage = db.getMisconfigFindings(scanId, { limit: SARIF_ROW_LIMIT });
      const truncated =
        detailsPage.total > SARIF_ROW_LIMIT
        || secretsPage.total > SARIF_ROW_LIMIT
        || misconfigsPage.total > SARIF_ROW_LIMIT;
      if (truncated) {
        console.warn(
          `[Security] SARIF export truncated for scanId=${scanId}: `
          + `vulns=${detailsPage.total}, secrets=${secretsPage.total}, misconfigs=${misconfigsPage.total}, cap=${SARIF_ROW_LIMIT}`,
        );
      }
      const suppressed = applySuppressions(detailsPage.items, scan.image_ref, db.getCveSuppressions());
      const acknowledged = applyMisconfigAcknowledgements(
        misconfigsPage.items,
        scan.stack_context,
        db.getMisconfigAcknowledgements(),
      );
      const sarif = generateSarif(scan, suppressed, secretsPage.items, acknowledged);
      if (truncated) {
        sarif.runs[0].properties = {
          truncated: true,
          row_limit: SARIF_ROW_LIMIT,
          totals: {
            vulnerabilities: detailsPage.total,
            secrets: secretsPage.total,
            misconfigs: misconfigsPage.total,
          },
        };
      }
      const safeName = scan.image_ref.replace(/[^a-zA-Z0-9._-]/g, '_') || `scan-${scanId}`;
      res.setHeader('Content-Type', 'application/sarif+json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.sarif.json"`);
      res.send(JSON.stringify(sarif));
    } catch (error) {
      console.error('[Security] SARIF export failed:', error);
      res.status(500).json({ error: (error as Error).message || 'Failed to generate SARIF' });
    }
  },
);

// Export the instance's CVE triage decisions as an OpenVEX document. Authoring
// fleet VEX is a governance feature, so it is Admiral (paid) + admin, mirroring
// the SARIF export gate.
securityRouter.get('/vex/export', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const suppressions = DatabaseService.getInstance().getCveSuppressions();
    const doc = generateOpenVex(suppressions, req.user?.username || 'sencho', new Date().toISOString());
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="sencho-fleet.openvex.json"');
    res.send(JSON.stringify(doc));
  } catch (error) {
    console.error('[Security] OpenVEX export failed:', error);
    res.status(500).json({ error: (error as Error).message || 'Failed to generate OpenVEX' });
  }
});

securityRouter.get('/policies', authMiddleware, (req: Request, res: Response): void => {
  if (!requirePaid(req, res)) return;
  // Replicas see only policies that apply to themselves: local-only rows plus
  // fleet-wide and self-identity-matched replicated rows. Identity-scoped
  // rows targeting other replicas are filtered out at the SQL boundary.
  const policies = DatabaseService.getInstance()
    .getScanPoliciesForUi(FleetSyncService.getRole(), FleetSyncService.getSelfIdentity());
  res.json(policies);
});

securityRouter.post('/policies', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  if (blockIfReplica(res, 'security policies')) return;
  const { name, node_id, stack_pattern, max_severity, block_on_deploy, enabled, block_on_severity, block_on_kev, block_on_fixable } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Policy name is required' }); return;
  }
  if (!POLICY_SEVERITIES.has(max_severity)) {
    res.status(400).json({ error: 'max_severity must be CRITICAL, HIGH, MEDIUM, or LOW' }); return;
  }
  const normalizedPattern = stack_pattern ? String(stack_pattern) : null;
  if (normalizedPattern !== null) {
    const patternError = validateStackPatternForRedos(normalizedPattern);
    if (patternError) {
      res.status(400).json({ error: patternError }); return;
    }
  }
  // Risk-first defaults when a field is omitted (KEV + fixable on, severity off),
  // so an API-created policy matches the UI default rather than the severity-only
  // migration default that exists only to preserve older rows.
  const blockOnDeploy = block_on_deploy ? 1 : 0;
  const blockOnSeverity = block_on_severity === undefined ? 0 : (block_on_severity ? 1 : 0);
  const blockOnKev = block_on_kev === undefined ? 1 : (block_on_kev ? 1 : 0);
  const blockOnFixable = block_on_fixable === undefined ? 1 : (block_on_fixable ? 1 : 0);
  if (isNoOpBlockingPolicy(blockOnDeploy, blockOnSeverity, blockOnKev, blockOnFixable)) {
    res.status(400).json({ error: 'A blocking policy must enable at least one of: severity threshold, KEV, or fixable.' }); return;
  }
  try {
    const resolvedNodeId = node_id != null ? Number(node_id) : null;
    const policy = DatabaseService.getInstance().createScanPolicy({
      name: name.trim(),
      node_id: resolvedNodeId,
      node_identity: FleetSyncService.resolveIdentityForNodeId(resolvedNodeId),
      stack_pattern: normalizedPattern,
      max_severity,
      block_on_deploy: blockOnDeploy,
      enabled: enabled === false ? 0 : 1,
      block_on_severity: blockOnSeverity,
      block_on_kev: blockOnKev,
      block_on_fixable: blockOnFixable,
      replicated_from_control: 0,
    });
    FleetSyncService.getInstance().pushResourceAsync('scan_policies');
    res.status(201).json(policy);
  } catch (error) {
    console.error('[Security] Failed to create policy:', error);
    res.status(500).json({ error: 'Failed to create policy' });
  }
});

securityRouter.put('/policies/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  if (blockIfReplica(res, 'security policies')) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid policy id' }); return;
  }
  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.node_id !== undefined) {
    const resolvedNodeId = body.node_id != null ? Number(body.node_id) : null;
    updates.node_id = resolvedNodeId;
    updates.node_identity = FleetSyncService.resolveIdentityForNodeId(resolvedNodeId);
  }
  if (body.stack_pattern !== undefined) {
    const normalizedPattern = body.stack_pattern ? String(body.stack_pattern) : null;
    if (normalizedPattern !== null) {
      const patternError = validateStackPatternForRedos(normalizedPattern);
      if (patternError) {
        res.status(400).json({ error: patternError }); return;
      }
    }
    updates.stack_pattern = normalizedPattern;
  }
  if (body.max_severity !== undefined) {
    if (!POLICY_SEVERITIES.has(body.max_severity)) {
      res.status(400).json({ error: 'max_severity must be CRITICAL, HIGH, MEDIUM, or LOW' }); return;
    }
    updates.max_severity = body.max_severity;
  }
  if (body.block_on_deploy !== undefined) updates.block_on_deploy = body.block_on_deploy ? 1 : 0;
  if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
  if (body.block_on_severity !== undefined) updates.block_on_severity = body.block_on_severity ? 1 : 0;
  if (body.block_on_kev !== undefined) updates.block_on_kev = body.block_on_kev ? 1 : 0;
  if (body.block_on_fixable !== undefined) updates.block_on_fixable = body.block_on_fixable ? 1 : 0;
  const db = DatabaseService.getInstance();
  const existing = db.getScanPolicy(id);
  if (!existing) {
    res.status(404).json({ error: 'Policy not found' }); return;
  }
  // Validate the post-update state: a policy that ends up blocking must still
  // have at least one active input. Merge the patch over the existing row.
  const mergedBlockOnDeploy = (updates.block_on_deploy as number | undefined) ?? existing.block_on_deploy;
  const mergedSeverity = (updates.block_on_severity as number | undefined) ?? existing.block_on_severity;
  const mergedKev = (updates.block_on_kev as number | undefined) ?? existing.block_on_kev;
  const mergedFixable = (updates.block_on_fixable as number | undefined) ?? existing.block_on_fixable;
  if (isNoOpBlockingPolicy(mergedBlockOnDeploy, mergedSeverity, mergedKev, mergedFixable)) {
    res.status(400).json({ error: 'A blocking policy must enable at least one of: severity threshold, KEV, or fixable.' }); return;
  }
  const policy = db.updateScanPolicy(id, updates);
  if (!policy) {
    res.status(404).json({ error: 'Policy not found' }); return;
  }
  FleetSyncService.getInstance().pushResourceAsync('scan_policies');
  res.json(policy);
});

securityRouter.delete('/policies/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  if (blockIfReplica(res, 'security policies')) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid policy id' }); return;
  }
  DatabaseService.getInstance().deleteScanPolicy(id);
  FleetSyncService.getInstance().pushResourceAsync('scan_policies');
  res.json({ success: true });
});

securityRouter.get('/suppressions', authMiddleware, (req: Request, res: Response): void => {
  const now = Date.now();
  const rows = DatabaseService.getInstance().getCveSuppressions().map((s) => ({
    ...s,
    active: s.expires_at === null || s.expires_at > now,
  }));
  res.json(rows);
});

securityRouter.post('/suppressions', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (blockIfReplica(res, 'CVE suppressions')) return;
  const body = req.body ?? {};
  const cveId = typeof body.cve_id === 'string' ? body.cve_id.trim() : '';
  if (!CVE_ID_RE.test(cveId)) {
    res.status(400).json({ error: 'cve_id must look like CVE-YYYY-NNNN or GHSA-xxxx-xxxx-xxxx' });
    return;
  }
  const pkgName = body.pkg_name == null || body.pkg_name === '' ? null : String(body.pkg_name).trim();
  if (pkgName !== null && pkgName.length > 200) {
    res.status(400).json({ error: 'pkg_name is too long' }); return;
  }
  const imagePattern = body.image_pattern == null || body.image_pattern === '' ? null : String(body.image_pattern).trim();
  if (imagePattern !== null && imagePattern.length > 300) {
    res.status(400).json({ error: 'image_pattern is too long' }); return;
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    res.status(400).json({ error: 'reason is required' }); return;
  }
  if (reason.length > 2000) {
    res.status(400).json({ error: 'reason is too long' }); return;
  }
  const expiresAt = body.expires_at == null ? null : Number(body.expires_at);
  if (expiresAt !== null && !Number.isFinite(expiresAt)) {
    res.status(400).json({ error: 'expires_at must be a timestamp or null' }); return;
  }
  // Triage decision: default 'accepted' (a plain suppress = accepted risk).
  const status = body.status === undefined ? 'accepted' : body.status;
  if (!isTriageStatus(status)) {
    res.status(400).json({ error: 'invalid triage status' }); return;
  }
  const justification = body.justification == null || body.justification === '' ? null : body.justification;
  if (justification !== null && !isTriageJustification(justification)) {
    res.status(400).json({ error: 'invalid triage justification' }); return;
  }
  try {
    const suppression = DatabaseService.getInstance().createCveSuppression({
      cve_id: cveId,
      pkg_name: pkgName,
      image_pattern: imagePattern,
      reason,
      created_by: req.user?.username || 'unknown',
      created_at: Date.now(),
      expires_at: expiresAt,
      replicated_from_control: 0,
      status,
      justification,
    });
    FleetSyncService.getInstance().pushResourceAsync('cve_suppressions');
    res.status(201).json(suppression);
    recordSuppressionAudit(req, res, 'create', describeSuppressionScope(suppression));
  } catch (error) {
    const message = (error as Error).message || '';
    if (message.includes('UNIQUE')) {
      res.status(409).json({ error: 'A suppression already exists for this CVE, package, and image pattern.' });
      return;
    }
    console.error('[Security] Failed to create suppression:', error);
    res.status(500).json({ error: 'Failed to create suppression' });
  }
});

securityRouter.put('/suppressions/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (blockIfReplica(res, 'CVE suppressions')) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid suppression id' }); return;
  }
  const body = req.body ?? {};
  const updates: Partial<{ reason: string; image_pattern: string | null; expires_at: number | null; status: string; justification: string | null }> = {};
  if (body.reason !== undefined) {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) { res.status(400).json({ error: 'reason is required' }); return; }
    if (reason.length > 2000) { res.status(400).json({ error: 'reason is too long' }); return; }
    updates.reason = reason;
  }
  if (body.status !== undefined) {
    if (!isTriageStatus(body.status)) { res.status(400).json({ error: 'invalid triage status' }); return; }
    updates.status = body.status;
  }
  if (body.justification !== undefined) {
    const justification = body.justification == null || body.justification === '' ? null : body.justification;
    if (justification !== null && !isTriageJustification(justification)) {
      res.status(400).json({ error: 'invalid triage justification' }); return;
    }
    updates.justification = justification;
  }
  if (body.image_pattern !== undefined) {
    const pattern = body.image_pattern == null || body.image_pattern === '' ? null : String(body.image_pattern).trim();
    if (pattern !== null && pattern.length > 300) {
      res.status(400).json({ error: 'image_pattern is too long' }); return;
    }
    updates.image_pattern = pattern;
  }
  if (body.expires_at !== undefined) {
    const expiresAt = body.expires_at == null ? null : Number(body.expires_at);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      res.status(400).json({ error: 'expires_at must be a timestamp or null' }); return;
    }
    updates.expires_at = expiresAt;
  }
  const suppression = DatabaseService.getInstance().updateCveSuppression(id, updates);
  if (!suppression) {
    res.status(404).json({ error: 'Suppression not found' }); return;
  }
  FleetSyncService.getInstance().pushResourceAsync('cve_suppressions');
  res.json(suppression);
  const changed = Object.keys(updates);
  recordSuppressionAudit(
    req,
    res,
    'update',
    `id=${id} ${describeSuppressionScope(suppression)} fields=[${changed.join(',')}]`,
  );
});

securityRouter.delete('/suppressions/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (blockIfReplica(res, 'CVE suppressions')) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid suppression id' }); return;
  }
  const db = DatabaseService.getInstance();
  // Snapshot before delete so the audit summary names the CVE rather than the bare id.
  const existing = db.getCveSuppression(id);
  db.deleteCveSuppression(id);
  FleetSyncService.getInstance().pushResourceAsync('cve_suppressions');
  res.json({ success: true });
  recordSuppressionAudit(
    req,
    res,
    'delete',
    existing ? `id=${id} ${describeSuppressionScope(existing)}` : `id=${id} (not found)`,
  );
});

// --- Misconfig Acknowledgements ---

securityRouter.get('/misconfig-acks', authMiddleware, (req: Request, res: Response): void => {
  const now = Date.now();
  const rows = DatabaseService.getInstance().getMisconfigAcknowledgements().map((a) => ({
    ...a,
    active: a.expires_at === null || a.expires_at > now,
  }));
  res.json(rows);
});

securityRouter.post('/misconfig-acks', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (blockIfReplica(res, 'misconfig acknowledgements')) return;
  const body = req.body ?? {};
  const ruleId = typeof body.rule_id === 'string' ? body.rule_id.trim() : '';
  if (!MISCONFIG_RULE_RE.test(ruleId)) {
    res.status(400).json({ error: 'rule_id must be a non-empty alpha-numeric identifier (e.g. "DS002" or "AVD-DS-0002")' });
    return;
  }
  const stackPatternRaw = body.stack_pattern == null || body.stack_pattern === ''
    ? null
    : String(body.stack_pattern).trim();
  if (stackPatternRaw !== null) {
    if (stackPatternRaw.length > 300) {
      res.status(400).json({ error: 'stack_pattern is too long' }); return;
    }
    const patternError = validateStackPatternForRedos(stackPatternRaw);
    if (patternError) {
      res.status(400).json({ error: patternError }); return;
    }
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    res.status(400).json({ error: 'reason is required' }); return;
  }
  if (reason.length > 2000) {
    res.status(400).json({ error: 'reason is too long' }); return;
  }
  const expiresAt = body.expires_at == null ? null : Number(body.expires_at);
  if (expiresAt !== null && !Number.isFinite(expiresAt)) {
    res.status(400).json({ error: 'expires_at must be a timestamp or null' }); return;
  }
  try {
    const ack = DatabaseService.getInstance().createMisconfigAcknowledgement({
      rule_id: ruleId,
      stack_pattern: stackPatternRaw,
      reason,
      created_by: req.user?.username || 'unknown',
      created_at: Date.now(),
      expires_at: expiresAt,
      replicated_from_control: 0,
    });
    FleetSyncService.getInstance().pushResourceAsync('misconfig_acknowledgements');
    res.status(201).json(ack);
    recordAckAudit(req, res, 'create', describeAckScope(ack));
  } catch (error) {
    const message = (error as Error).message || '';
    if (message.includes('UNIQUE')) {
      res.status(409).json({ error: 'An acknowledgement already exists for this rule and stack pattern.' });
      return;
    }
    console.error('[Security] Failed to create misconfig acknowledgement:', error);
    res.status(500).json({ error: 'Failed to create acknowledgement' });
  }
});

securityRouter.put('/misconfig-acks/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (blockIfReplica(res, 'misconfig acknowledgements')) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid acknowledgement id' }); return;
  }
  const body = req.body ?? {};
  const updates: Partial<{ reason: string; stack_pattern: string | null; expires_at: number | null }> = {};
  if (body.reason !== undefined) {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) { res.status(400).json({ error: 'reason is required' }); return; }
    if (reason.length > 2000) { res.status(400).json({ error: 'reason is too long' }); return; }
    updates.reason = reason;
  }
  if (body.stack_pattern !== undefined) {
    const pattern = body.stack_pattern == null || body.stack_pattern === ''
      ? null
      : String(body.stack_pattern).trim();
    if (pattern !== null) {
      if (pattern.length > 300) {
        res.status(400).json({ error: 'stack_pattern is too long' }); return;
      }
      const patternError = validateStackPatternForRedos(pattern);
      if (patternError) {
        res.status(400).json({ error: patternError }); return;
      }
    }
    updates.stack_pattern = pattern;
  }
  if (body.expires_at !== undefined) {
    const expiresAt = body.expires_at == null ? null : Number(body.expires_at);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      res.status(400).json({ error: 'expires_at must be a timestamp or null' }); return;
    }
    updates.expires_at = expiresAt;
  }
  const ack = DatabaseService.getInstance().updateMisconfigAcknowledgement(id, updates);
  if (!ack) {
    res.status(404).json({ error: 'Acknowledgement not found' }); return;
  }
  FleetSyncService.getInstance().pushResourceAsync('misconfig_acknowledgements');
  res.json(ack);
  const changed = Object.keys(updates);
  recordAckAudit(
    req,
    res,
    'update',
    `id=${id} ${describeAckScope(ack)} fields=[${changed.join(',')}]`,
  );
});

securityRouter.delete('/misconfig-acks/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (blockIfReplica(res, 'misconfig acknowledgements')) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid acknowledgement id' }); return;
  }
  const db = DatabaseService.getInstance();
  // Snapshot before delete so the audit summary names the rule rather than the bare id.
  const existing = db.getMisconfigAcknowledgement(id);
  db.deleteMisconfigAcknowledgement(id);
  FleetSyncService.getInstance().pushResourceAsync('misconfig_acknowledgements');
  res.json({ success: true });
  recordAckAudit(
    req,
    res,
    'delete',
    existing ? `id=${id} ${describeAckScope(existing)}` : `id=${id} (not found)`,
  );
});

securityRouter.get('/compare', authMiddleware, (req: Request, res: Response): void => {
  const scanId1 = Number(req.query.scanId1);
  const scanId2 = Number(req.query.scanId2);
  if (!Number.isFinite(scanId1) || !Number.isFinite(scanId2)) {
    res.status(400).json({ error: 'scanId1 and scanId2 are required' }); return;
  }
  const db = DatabaseService.getInstance();
  const a = db.getVulnerabilityScan(scanId1);
  const b = db.getVulnerabilityScan(scanId2);
  if (!a || !b || a.node_id !== req.nodeId || b.node_id !== req.nodeId) {
    res.status(404).json({ error: 'One or both scans not found' }); return;
  }
  const COMPARE_ROW_LIMIT = 1000;
  const aVulns = db.getVulnerabilityDetails(scanId1, { limit: COMPARE_ROW_LIMIT }).items;
  const bVulns = db.getVulnerabilityDetails(scanId2, { limit: COMPARE_ROW_LIMIT }).items;
  const truncated =
    a.total_vulnerabilities > COMPARE_ROW_LIMIT || b.total_vulnerabilities > COMPARE_ROW_LIMIT;
  if (truncated) {
    console.warn(
      `[Compare] scan(s) exceed ${COMPARE_ROW_LIMIT}-row cap: scanA=${a.id}(${a.total_vulnerabilities}) scanB=${b.id}(${b.total_vulnerabilities})`,
    );
  }
  const keyOf = (v: { vulnerability_id: string; pkg_name: string }) =>
    `${v.vulnerability_id}::${v.pkg_name}`;
  const aMap = new Map(aVulns.map((v) => [keyOf(v), v]));
  const bMap = new Map(bVulns.map((v) => [keyOf(v), v]));
  const addedRaw = bVulns.filter((v) => !aMap.has(keyOf(v)));
  const removedRaw = aVulns.filter((v) => !bMap.has(keyOf(v)));
  const unchangedRaw = aVulns.filter((v) => bMap.has(keyOf(v)));
  const suppressions = db.getCveSuppressions();
  const added = applySuppressions(addedRaw, b.image_ref, suppressions);
  const removed = applySuppressions(removedRaw, a.image_ref, suppressions);
  const unchanged = applySuppressions(unchangedRaw, b.image_ref, suppressions);
  if (isDebugEnabled()) {
    console.log('[Compare:diag]', {
      scanId1,
      scanId2,
      reqNodeId: req.nodeId,
      tier: req.proxyTier ?? LicenseService.getInstance().getTier(),
      aVulns: aVulns.length,
      bVulns: bVulns.length,
      added: added.length,
      removed: removed.length,
      unchanged: unchanged.length,
      suppressions: suppressions.length,
      truncated,
    });
  }
  res.json({
    scanA: {
      id: a.id,
      scanned_at: a.scanned_at,
      image_ref: a.image_ref,
      total_vulnerabilities: a.total_vulnerabilities,
    },
    scanB: {
      id: b.id,
      scanned_at: b.scanned_at,
      image_ref: b.image_ref,
      total_vulnerabilities: b.total_vulnerabilities,
    },
    added,
    removed,
    unchanged,
    truncated,
    row_limit: COMPARE_ROW_LIMIT,
  });
});
