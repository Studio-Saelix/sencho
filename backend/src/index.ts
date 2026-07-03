import express, { Request, Response } from 'express';
import './types/express';
import { authGate, auditLog } from './middleware/authGate';
import { enforceApiTokenScope } from './middleware/apiTokenScope';
import { hubOnlyGuard } from './middleware/hubOnlyGuard';
import { errorHandler } from './middleware/errorHandler';
import { createApp } from './app';
import { createRemoteProxyMiddleware } from './proxy/remoteNodeProxy';
import { createServer } from './server';
import { attachUpgrade } from './websocket/upgradeHandler';
import { startServer } from './bootstrap/startup';
import { installShutdownHandlers } from './bootstrap/shutdown';
import { metaRouter } from './routes/meta';
import { blueprintsRouter } from './routes/blueprints';
import { nodeLabelsRouter } from './routes/nodeLabels';
import { authRouter } from './routes/auth';
import { mfaRouter } from './routes/mfa';
import { ssoRouter } from './routes/sso';
import { licenseRouter, systemUpdateRouter } from './routes/license';
import { webhooksRouter } from './routes/webhooks';
import { usersRouter } from './routes/users';
import { gitSourcesRouter, stackGitSourceRouter } from './routes/gitSources';
import { fleetRouter } from './routes/fleet';
import { fleetActionsRouter } from './routes/fleetActions';
import { cloudBackupRouter } from './routes/cloudBackup';
import { permissionsRouter } from './routes/permissions';
import { convertRouter } from './routes/convert';
import { alertsRouter } from './routes/alerts';
import { labelsRouter, stackLabelsRouter } from './routes/labels';
import { apiTokensRouter } from './routes/apiTokens';
import { auditLogRouter } from './routes/auditLog';
import { settingsRouter } from './routes/settings';
import { scheduledTasksRouter } from './routes/scheduledTasks';
import { meshRouter } from './routes/mesh';
import { agentsRouter } from './routes/agents';
import { metricsRouter } from './routes/metrics';
import { imageUpdatesRouter, autoUpdateRouter } from './routes/imageUpdates';
import { autoHealRouter } from './routes/autoHeal';
import { notificationsRouter, notificationRoutesRouter, notificationSuppressionRouter } from './routes/notifications';
import { consoleRouter } from './routes/console';
import { ssoConfigRouter } from './routes/ssoConfig';
import { registriesRouter } from './routes/registries';
import { systemMaintenanceRouter } from './routes/systemMaintenance';
import { volumesRouter } from './routes/volumes';
import { templatesRouter } from './routes/templates';
import { securityRouter } from './routes/security';
import { dashboardRouter } from './routes/dashboard';
import { containersRouter, portsRouter } from './routes/containers';
import { nodesRouter } from './routes/nodes';
import { stacksRouter } from './routes/stacks';
import { stackActivityRouter } from './routes/stackActivity';
import { stackMetricsRouter } from './routes/stackMetrics';
import { fileExplorerMetricsRouter } from './routes/fileExplorerMetrics';
import { stackActivityMetricsRouter } from './routes/stackActivityMetrics';
import { secretsRouter } from './routes/secrets';
import { diagnosticsRouter } from './routes/diagnostics';
import { dependencyMapRouter } from './routes/dependencyMap';
import { networkingRouter } from './routes/networking';

// Suppress [DEP0060] DeprecationWarning emitted by http-proxy@1.18.1 which calls
// util._extend internally. The warning fires at runtime when createProxyServer() is
// first invoked (NOT at import time), so intercepting process.emitWarning here -
// before the proxy instances are created below - fully prevents it.
// http-proxy has no compatible update; this suppression is intentional and safe.
const _origEmitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: any, ...args: any[]) => {
  const code = typeof args[0] === 'object' ? args[0]?.code : args[1];
  if (code === 'DEP0060') return;
  _origEmitWarning(warning, ...args);
};

const app = createApp();

// Public /api/health and /api/meta (no auth). Mounted before authGate.
app.use('/api', metaRouter);

// Auth / MFA / SSO routers. Mounted before authGate because some paths are
// public (login, setup, SSO callbacks); handlers that need auth use
// authMiddleware directly.
app.use('/api/auth', authRouter);
app.use('/api/auth', mfaRouter);
app.use('/api/auth/sso', ssoRouter);

// Auth gate on all /api/* routes (exempts /auth/* and webhook triggers).
app.use('/api', authGate);

// Audit-log every mutating /api/* action (POST/PUT/DELETE/PATCH).
app.use('/api', auditLog);

app.use('/api', enforceApiTokenScope);

// Hub-only guard: reject requests whose nodeId resolves to a remote node
// when the path is hub-only (e.g. /api/scheduled-tasks, /api/audit-log,
// /api/notification-routes). Without this, the proxy would forward the
// request and process it on the remote as a local call, crossing a
// node-authority boundary that the UI hides. See helpers/proxyExemptPaths.ts
// for the prefix list and middleware/hubOnlyGuard.ts for the rationale.
app.use('/api', hubOnlyGuard);

// Remote Node HTTP Proxy (see proxy/remoteNodeProxy.ts). Mounted BEFORE the
// per-group routers so a request targeting a remote node short-circuits into
// the proxy instead of hitting a local handler that would read local state.
// Gateway-level paths (auth, nodes, license, fleet, webhooks, meta) are listed
// in helpers/proxyExemptPaths.ts and bypass the proxy back to the local
// handlers below.
app.use('/api/', createRemoteProxyMiddleware());

app.use('/api/license', licenseRouter);
app.use('/api/system', systemUpdateRouter);
app.use('/api/permissions', permissionsRouter);
app.use('/api/convert', convertRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/labels', labelsRouter);
app.use('/api/stacks', stackLabelsRouter);
app.use('/api/secrets', secretsRouter);
app.use('/api/api-tokens', apiTokensRouter);
app.use('/api/audit-log', auditLogRouter);
app.use('/api/fleet', fleetRouter);
app.use('/api/fleet-actions', fleetActionsRouter);
app.use('/api/cloud-backup', cloudBackupRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/users', usersRouter);
app.use('/api/git-sources', gitSourcesRouter);
app.use('/api/stacks', stackGitSourceRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/scheduled-tasks', scheduledTasksRouter);
app.use('/api/mesh', meshRouter);
app.use('/api/blueprints', blueprintsRouter);
app.use('/api/node-labels', nodeLabelsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api', metricsRouter);
app.use('/api/image-updates', imageUpdatesRouter);
app.use('/api/auto-update', autoUpdateRouter);
app.use('/api/auto-heal', autoHealRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/notification-routes', notificationRoutesRouter);
app.use('/api/notification-suppression-rules', notificationSuppressionRouter);
app.use('/api/system', consoleRouter);
app.use('/api/sso/config', ssoConfigRouter);
app.use('/api/registries', registriesRouter);
app.use('/api/system', systemMaintenanceRouter);
app.use('/api/volumes', volumesRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/security', securityRouter);
app.use('/api/containers', containersRouter);
app.use('/api/ports', portsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/dependency-map', dependencyMapRouter);
app.use('/api/networking', networkingRouter);
app.use('/api/nodes', nodesRouter);
app.use('/api/stacks', stackActivityRouter);
app.use('/api/stacks', stacksRouter);
app.use('/api/stack-metrics', stackMetricsRouter);
app.use('/api/file-explorer-metrics', fileExplorerMetricsRouter);
app.use('/api/stack-activity-metrics', stackActivityMetricsRouter);

const { server, wss, pilotTunnelWss } = createServer(app);
attachUpgrade(server, { wss, pilotTunnelWss });

// Static / SPA fallback. Production serves the built frontend; dev returns a
// JSON 404 for unmatched /api paths to prevent fetch hangs.
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('public'));
  app.use((req: Request, res: Response) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile('index.html', { root: 'public' });
    } else {
      res.status(404).json({ error: 'API endpoint not found' });
    }
  });
} else {
  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api')) {
      res.status(404).json({ error: 'API endpoint not found' });
    }
  });
}

// Central error handler: must be registered after all routes and static.
app.use(errorHandler);

installShutdownHandlers(server);

if (require.main === module) {
  void startServer(server);
}

// Exports used by tests (supertest requires the http.Server instance).
export { app, server };
