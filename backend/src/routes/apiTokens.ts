import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { DatabaseService, type ApiTokenScope } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { isDebugEnabled } from '../utils/debug';
import { parseIntParam } from '../utils/parseIntParam';
import { generateApiToken } from '../utils/apiTokenFormat';

const MAX_ACTIVE_TOKENS_PER_USER = 25;

const API_TOKEN_SCOPE_MESSAGE = 'API tokens cannot manage other API tokens.';

export const apiTokensRouter = Router();

apiTokensRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, API_TOKEN_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const { name, scope, expires_in } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Token name is required.' });
      return;
    }
    if (name.trim().length > 100) {
      res.status(400).json({ error: 'Token name must be 100 characters or fewer.' });
      return;
    }
    const validScopes = ['read-only', 'deploy-only', 'full-admin'];
    if (!scope || !validScopes.includes(scope)) {
      res.status(400).json({ error: `Scope must be one of: ${validScopes.join(', ')}` });
      return;
    }
    const validExpiry = [30, 60, 90, 365];
    if (expires_in !== undefined && expires_in !== null && !validExpiry.includes(expires_in)) {
      res.status(400).json({ error: `expires_in must be one of: ${validExpiry.join(', ')} (days), or null for no expiry.` });
      return;
    }
    const expiresAt = typeof expires_in === 'number' ? Date.now() + expires_in * 24 * 60 * 60 * 1000 : null;

    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(req.user!.username);
    if (!user) {
      res.status(500).json({ error: 'User not found.' });
      return;
    }

    const activeCount = db.getActiveApiTokenCountByUser(user.id);
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      res.status(400).json({ error: `Maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens per user.` });
      return;
    }

    if (db.getActiveApiTokenByNameAndUser(name.trim(), user.id)) {
      res.status(409).json({ error: 'An active token with this name already exists.' });
      return;
    }

    const rawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const id = db.addApiToken({
      token_hash: tokenHash,
      name: name.trim(),
      scope: scope as ApiTokenScope,
      user_id: user.id,
      created_at: Date.now(),
      expires_at: expiresAt,
    });

    if (isDebugEnabled()) console.log('[ApiTokens:diag] Token created:', { name: name.trim(), scope, expires_in, user: req.user!.username });
    res.status(201).json({ id, token: rawToken });
  } catch (error) {
    console.error('[ApiTokens] Create error:', error);
    res.status(500).json({ error: 'Failed to create API token' });
  }
});

apiTokensRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, API_TOKEN_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const user = DatabaseService.getInstance().getUserByUsername(req.user!.username);
    if (!user) { res.status(500).json({ error: 'User not found.' }); return; }
    const tokens = DatabaseService.getInstance().getApiTokensByUser(user.id);
    // Never expose token hashes to the client.
    const sanitized = tokens.map(({ token_hash: _hash, ...rest }) => rest);
    res.json(sanitized);
  } catch (error) {
    console.error('[ApiTokens] List error:', error);
    res.status(500).json({ error: 'Failed to list API tokens' });
  }
});

apiTokensRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, API_TOKEN_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'token ID');
    if (id === null) return;

    const apiToken = DatabaseService.getInstance().getApiTokenById(id);
    if (!apiToken) { res.status(404).json({ error: 'API token not found.' }); return; }

    const user = DatabaseService.getInstance().getUserByUsername(req.user!.username);
    if (!user || apiToken.user_id !== user.id) {
      res.status(403).json({ error: 'You can only revoke your own tokens.' });
      return;
    }

    DatabaseService.getInstance().revokeApiToken(id);
    if (isDebugEnabled()) console.log('[ApiTokens:diag] Token revoked:', { id, name: apiToken.name, user: req.user!.username });
    res.json({ success: true });
  } catch (error) {
    console.error('[ApiTokens] Revoke error:', error);
    res.status(500).json({ error: 'Failed to revoke API token' });
  }
});
