import { Router, type Request, type Response } from 'express';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { authMiddleware } from '../middleware/auth';
import { effectiveTier, requireAdmin } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { templateService } from '../services/TemplateService';
import { FileSystemService } from '../services/FileSystemService';
import { ComposeService } from '../services/ComposeService';
import { DatabaseService } from '../services/DatabaseService';
import { ErrorParser } from '../utils/ErrorParser';
import { isValidStackName, isPathWithinBase } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { runPolicyGate, triggerPostDeployScan } from '../helpers/policyGate';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { getTerminalWs, DEPLOY_SESSION_HEADER } from '../websocket/generic';

export const templatesRouter = Router();

templatesRouter.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const templates = await templateService.getTemplates();

    const imageRefs = templates.map(t => t.image).filter((i): i is string => !!i);
    const scanSummary = DatabaseService.getInstance().getLatestScanSummaryByImageRefs(req.nodeId, imageRefs);

    const topCandidates = templates
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => (t.stars ?? 0) > 0)
      .sort((a, b) => (b.t.stars ?? 0) - (a.t.stars ?? 0))
      .slice(0, 5);
    const weekIndex = Math.floor(Date.now() / (7 * 86_400_000));
    const featuredIndex = topCandidates.length > 0
      ? topCandidates[weekIndex % topCandidates.length].i
      : -1;

    const enriched = templates.map((t, i) => {
      const summary = t.image ? scanSummary.get(t.image) : undefined;
      const scan_status: 'clean' | 'vulnerable' | 'unscanned' = summary
        ? (summary.total === 0 ? 'clean' : 'vulnerable')
        : 'unscanned';
      return {
        ...t,
        scan_status,
        scan_cve_count: summary?.total ?? 0,
        scan_critical_count: summary?.critical ?? 0,
        scan_high_count: summary?.high ?? 0,
        featured: i === featuredIndex,
      };
    });

    res.json(enriched);
  } catch (error) {
    console.error('[Templates] Failed to fetch:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to fetch templates') });
  }
});

templatesRouter.post('/refresh-cache', authMiddleware, (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  templateService.clearCache();
  console.log('[Templates] Cache cleared by', req.user?.username || 'unknown');
  res.json({ success: true });
});

templatesRouter.post('/deploy', authMiddleware, async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:create')) return;
  try {
    const { stackName, template, envVars, skip_scan } = req.body;

    if (!stackName || !template) {
      return res.status(400).json({ error: 'stackName and template are required' });
    }

    if (!isValidStackName(stackName)) {
      return res.status(400).json({ error: 'Stack name can only contain alphanumeric characters, hyphens, and underscores' });
    }

    const fsService = FileSystemService.getInstance(req.nodeId);
    const baseDir = fsService.getBaseDir();
    const stackPath = path.join(baseDir, stackName);
    if (!isPathWithinBase(stackPath, baseDir)) {
      return res.status(400).json({ error: 'Invalid stack path' });
    }

    try {
      await fsPromises.access(stackPath);

      if (await fsService.hasComposeFile(stackPath)) {
        return res.status(409).json({
          error: `A stack directory named '${stackName}' already exists. Please choose a different Stack Name.`,
          rolledBack: false
        });
      }

      console.log(`[Templates] Cleaned up orphaned stack directory: ${stackName}`);
      await fsService.deleteStack(stackName);
    } catch {
      // Directory does not exist; proceed with deploy
    }

    const debug = isDebugEnabled();
    const deployStartedAt = Date.now();
    console.log(`[Templates] Deploy started: ${stackName}`);
    if (debug) console.debug('[Templates:debug] Deploy payload', {
      stackName,
      // title/source are registry/client-supplied; bound the title so a long
      // value cannot bloat the log line. No env values or YAML are logged.
      templateTitle: String(template.title ?? '').slice(0, 80),
      source: String(template.source ?? '').slice(0, 40),
      portCount: Array.isArray(template.ports) ? template.ports.length : 0,
      volumeCount: Array.isArray(template.volumes) ? template.volumes.length : 0,
      envVarCount: envVars ? Object.keys(envVars).length : 0,
    });

    await fsService.createStack(stackName);

    const composeYaml = templateService.generateComposeFromTemplate(template, stackName);
    await fsService.saveStackContent(stackName, composeYaml);

    if (envVars && Object.keys(envVars).length > 0) {
      const envString = templateService.generateEnvString(envVars);
      const defaultEnvPath = path.join(stackPath, '.env');
      await fsPromises.writeFile(defaultEnvPath, envString, 'utf-8');
    }

    try {
      if (!(await runPolicyGate(req, res, stackName, req.nodeId))) {
        try {
          await fsService.deleteStack(stackName);
        } catch (cleanupErr) {
          console.error(`[Templates] Cleanup after policy block failed for ${stackName}:`, cleanupErr);
        }
        return;
      }
      const atomic = effectiveTier(req) === 'paid';
      await ComposeService.getInstance(req.nodeId).deployStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), atomic);
      invalidateNodeCaches(req.nodeId);
      console.log(`[Templates] Deploy completed: ${stackName}`);
      if (debug) console.debug(`[Templates:debug] Deploy timing: ${stackName} took ${Date.now() - deployStartedAt}ms`);
      res.json({ success: true, message: 'Template deployed successfully' });
      if (!skip_scan) {
        triggerPostDeployScan(stackName, req.nodeId).catch(err =>
          console.error(`[Security] Post-deploy scan failed for ${stackName}:`, err),
        );
      }
    } catch (deployError: unknown) {
      const rawError = getErrorMessage(deployError, String(deployError));
      console.error(`[Templates] Deploy failed: ${stackName} -`, rawError);
      const parsed = ErrorParser.parse(rawError);

      const shouldRollback = parsed.rule ? parsed.rule.canSilentlyRollback : true;
      let rolledBack = false;

      if (shouldRollback) {
        let dockerDownCompleted = true;
        let fileDeleteCompleted = true;
        try {
          await ComposeService.getInstance(req.nodeId).downStack(stackName);
        } catch (downErr) {
          dockerDownCompleted = false;
          console.error("[Templates] Rollback Stage 1 (Docker down) failed:", downErr);
        }

        try {
          await fsService.deleteStack(stackName);
        } catch (fsErr) {
          fileDeleteCompleted = false;
          console.error("[Templates] Rollback Stage 2 (File deletion) failed:", fsErr);
        }
        rolledBack = dockerDownCompleted && fileDeleteCompleted;
      }

      invalidateNodeCaches(req.nodeId);
      res.status(500).json({
        error: parsed.message,
        rolledBack,
        ruleId: parsed.rule?.id || 'UNKNOWN'
      });
    }
  } catch (error: unknown) {
    const message = getErrorMessage(error, 'Failed to deploy template');
    console.error('[Templates] Deploy error:', message);
    res.status(500).json({ error: message });
  }
});
