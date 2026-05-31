import { Router, type Request, type Response } from 'express';
import { DatabaseService, AUDIT_ANOMALY_HISTORY_CAP } from '../services/DatabaseService';
import { annotateEntries, computeAuditStats, HISTORY_WINDOW_MS } from '../services/AuditAnomalyService';
import { requireAdmiral } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { isDebugEnabled } from '../utils/debug';
import { escapeCsvField } from '../utils/csv';
import { sanitizeForLog } from '../utils/safeLog';

export const auditLogRouter = Router();

auditLogRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmiral(req, res)) return;
  if (!requirePermission(req, res, 'system:audit')) return;

  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 200);
    const username = req.query.username as string | undefined;
    const method = req.query.method as string | undefined;
    const search = req.query.search as string | undefined;
    const from = req.query.from ? parseInt(req.query.from as string) : undefined;
    const to = req.query.to ? parseInt(req.query.to as string) : undefined;
    const withAnomalies = req.query.with_anomalies === '1';

    if (isDebugEnabled()) {
      console.log(`[Audit:diag] Query: page=${page} limit=${limit} username=${sanitizeForLog(username || '-')} method=${sanitizeForLog(method || '-')} search=${sanitizeForLog(search || '-')}`);
    }
    const db = DatabaseService.getInstance();
    const result = db.getAuditLogs({ page, limit, username, method, from, to, search });

    if (withAnomalies && result.entries.length > 0) {
      const now = Date.now();
      const historyFrom = now - HISTORY_WINDOW_MS;
      const oldestInPage = result.entries.reduce(
        (min, e) => Math.min(min, e.timestamp),
        result.entries[0].timestamp,
      );
      const history = db.getAuditLogsInRange(historyFrom, oldestInPage, AUDIT_ANOMALY_HISTORY_CAP);
      res.json({ ...result, entries: annotateEntries(result.entries, history, now) });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error('[AuditLog] Failed to fetch audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

auditLogRouter.get('/stats', async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmiral(req, res)) return;
  if (!requirePermission(req, res, 'system:audit')) return;

  try {
    if (isDebugEnabled()) {
      console.log('[Audit:diag] Stats requested');
    }
    const db = DatabaseService.getInstance();
    res.json(computeAuditStats(db.getAuditStatsInputs(Date.now())));
  } catch (error) {
    console.error('[AuditLog] Failed to compute audit stats:', error);
    res.status(500).json({ error: 'Failed to compute audit stats' });
  }
});

auditLogRouter.get('/export', async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmiral(req, res)) return;
  if (!requirePermission(req, res, 'system:audit')) return;

  try {
    const format = (req.query.format as string) === 'csv' ? 'csv' : 'json';
    const username = req.query.username as string | undefined;
    const method = req.query.method as string | undefined;
    const search = req.query.search as string | undefined;
    const from = req.query.from ? parseInt(req.query.from as string) : undefined;
    const to = req.query.to ? parseInt(req.query.to as string) : undefined;

    if (isDebugEnabled()) {
      console.log(`[Audit:diag] Export: format=${format} filters=${JSON.stringify({ username, method, search, from, to })}`);
    }
    const result = DatabaseService.getInstance().getAuditLogs({ page: 1, limit: 10000, username, method, from, to, search });
    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="audit-log-${timestamp}.json"`);
      res.json(result.entries);
    } else {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit-log-${timestamp}.csv"`);

      const headers = ['id', 'timestamp', 'username', 'method', 'path', 'status_code', 'node_id', 'ip_address', 'summary'];
      const rows = result.entries.map(e =>
        headers.map(h => escapeCsvField(e[h as keyof typeof e])).join(','),
      );
      res.send([headers.join(','), ...rows].join('\n'));
    }
  } catch (error) {
    console.error('[AuditLog] Export failed:', error);
    res.status(500).json({ error: 'Failed to export audit log' });
  }
});
