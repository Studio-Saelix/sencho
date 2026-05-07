import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireAdmiral, requirePaid } from '../middleware/tierGates';
import { trivyInstallLimiter } from '../middleware/rateLimiters';
import TrivyService, { SbomFormat } from '../services/TrivyService';
import TrivyInstaller from '../services/TrivyInstaller';
import { DatabaseService, parsePolicyEvaluation, type VulnerabilityScan } from '../services/DatabaseService';
import { FleetSyncService } from '../services/FleetSyncService';
import { LicenseService } from '../services/LicenseService';
import { validateImageRef } from '../utils/image-ref';
import { applySuppressions } from '../utils/suppression-filter';
import { generateSarif } from '../services/SarifExporter';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { blockIfReplica } from '../middleware/fleetSyncGuards';
import { validateStackPatternForRedos } from './fleet';
import { FINDING_SEVERITIES, POLICY_SEVERITIES } from '../utils/severity';

const CVE_ID_RE = /^(CVE-\d{4}-\d{4,}|GHSA-[\w-]{14,})$/;

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

function recordSuppressionAudit(
  req: Request,
  res: Response,
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
      summary: `cve_suppression.${action}: ${summary}`,
    });
  } catch (err) {
    console.warn('[Security] Suppression audit log write failed:', getErrorMessage(err, 'unknown'));
  }
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

function fetchAllPages<T>(
  q: (opts: { limit?: number; offset?: number }) => { items: T[]; total: number },
): T[] {
  const pageSize = 1000;
  const collected: T[] = [];
  let offset = 0;
  while (true) {
    const page = q({ limit: pageSize, offset });
    collected.push(...page.items);
    if (collected.length >= page.total || page.items.length === 0) break;
    offset += page.items.length;
  }
  return collected;
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
  if (!requireAdmiral(req, res)) return;
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
  const scan = DatabaseService.getInstance().getVulnerabilityScan(scanId);
  if (!scan || scan.node_id !== req.nodeId) {
    res.status(404).json({ error: 'Scan not found' }); return;
  }
  res.json(shapeScanForResponse(scan));
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
    res.json({ ...result, items: enriched });
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
    res.json(db.getMisconfigFindings(scanId, { severity, limit, offset }));
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

securityRouter.post('/sbom', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
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
      const details = fetchAllPages((opts) => db.getVulnerabilityDetails(scanId, opts));
      const secrets = fetchAllPages((opts) => db.getSecretFindings(scanId, opts));
      const misconfigs = fetchAllPages((opts) => db.getMisconfigFindings(scanId, opts));
      const suppressed = applySuppressions(details, scan.image_ref, db.getCveSuppressions());
      const sarif = generateSarif(scan, suppressed, secrets, misconfigs);
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
  const { name, node_id, stack_pattern, max_severity, block_on_deploy, enabled } = req.body ?? {};
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
  try {
    const resolvedNodeId = node_id != null ? Number(node_id) : null;
    const policy = DatabaseService.getInstance().createScanPolicy({
      name: name.trim(),
      node_id: resolvedNodeId,
      node_identity: FleetSyncService.resolveIdentityForNodeId(resolvedNodeId),
      stack_pattern: normalizedPattern,
      max_severity,
      block_on_deploy: block_on_deploy ? 1 : 0,
      enabled: enabled === false ? 0 : 1,
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
  const policy = DatabaseService.getInstance().updateScanPolicy(id, updates);
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
  const updates: Partial<{ reason: string; image_pattern: string | null; expires_at: number | null }> = {};
  if (body.reason !== undefined) {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) { res.status(400).json({ error: 'reason is required' }); return; }
    if (reason.length > 2000) { res.status(400).json({ error: 'reason is too long' }); return; }
    updates.reason = reason;
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
