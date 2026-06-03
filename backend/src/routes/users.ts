import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { DatabaseService, type UserRole, type ResourceType } from '../services/DatabaseService';
import { LicenseService } from '../services/LicenseService';
import { authMiddleware } from '../middleware/auth';
import { requirePaid, requireAdmin, requireAdmiral } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { BCRYPT_SALT_ROUNDS, MIN_PASSWORD_LENGTH } from '../helpers/constants';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage, isSqliteUniqueViolation } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';
import { validateUsername } from '../helpers/validateUsername';

const USERS_SCOPE_MESSAGE = 'API tokens cannot access user management.';
const VALID_USER_ROLES: UserRole[] = ['admin', 'viewer', 'deployer', 'node-admin', 'auditor'];
const VALID_ASSIGNMENT_ROLES: UserRole[] = ['admin', 'viewer', 'deployer', 'node-admin'];
const VALID_RESOURCE_TYPES: ResourceType[] = ['stack', 'node'];

// Roles that require an Admiral license. Viewer and admin are available on
// all paid tiers; the rest need variant=admiral for per-resource scoping to
// be meaningful.
function roleRequiresAdmiral(role: UserRole): boolean {
  return role === 'deployer' || role === 'node-admin' || role === 'auditor';
}

// Returns a seat-limit error message if adding an account of `role` would
// exceed the current license seat caps, or null when within limits. Counts are
// read at call time so the check reflects live state. Used by both user
// creation and admin promotion so the cap cannot be bypassed via role change.
// Seat caps gate new seat acquisition only (creation, and promotion to admin);
// reducing privilege by demoting an admin is never blocked on the viewer cap.
function seatLimitError(role: UserRole, db: DatabaseService): string | null {
  const seatLimits = LicenseService.getInstance().getSeatLimits();
  if (role === 'admin') {
    if (seatLimits.maxAdmins !== null && db.getAdminCount() >= seatLimits.maxAdmins) {
      return `Your license allows a maximum of ${seatLimits.maxAdmins} admin account${seatLimits.maxAdmins === 1 ? '' : 's'}. Upgrade to Admiral for unlimited accounts.`;
    }
  } else if (seatLimits.maxViewers !== null && db.getNonAdminCount() >= seatLimits.maxViewers) {
    return `Your license allows a maximum of ${seatLimits.maxViewers} viewer account${seatLimits.maxViewers === 1 ? '' : 's'}. Upgrade to Admiral for unlimited accounts.`;
  }
  return null;
}

export const usersRouter = Router();

usersRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const db = DatabaseService.getInstance();
    const users = db.getUsers();
    const mfaUserIds = db.getUsersWithMfaEnabled();
    const enriched = users.map((u) => ({
      ...u,
      mfaEnabled: mfaUserIds.has(u.id),
    }));
    res.json(enriched);
  } catch (error) {
    console.error('[Users] List error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

usersRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      res.status(400).json({ error: 'Username, password, and role are required' });
      return;
    }
    const usernameError = validateUsername(username);
    if (usernameError) {
      res.status(400).json({ error: usernameError });
      return;
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (!VALID_USER_ROLES.includes(role)) {
      res.status(400).json({ error: 'Role must be "admin", "viewer", "deployer", "node-admin", or "auditor"' });
      return;
    }
    if (roleRequiresAdmiral(role) && !requireAdmiral(req, res)) return;

    const db = DatabaseService.getInstance();
    const existing = db.getUserByUsername(username);
    if (existing) {
      res.status(409).json({ error: 'A user with this username already exists' });
      return;
    }

    // Enforce seat limits based on license variant.
    const seatError = seatLimitError(role, db);
    if (seatError) {
      res.status(403).json({ error: seatError });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const id = db.addUser({ username, password_hash: passwordHash, role });
    console.log('[Users] Created:', sanitizeForLog(username), 'role:', sanitizeForLog(role), 'by:', sanitizeForLog(req.user!.username));
    res.status(201).json({ id, username, role });
  } catch (error) {
    console.error('[Users] Create error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT/DELETE intentionally do NOT enforce requirePaid. Admins must be able
// to manage existing users even if their license lapses.
usersRouter.put('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseInt(req.params.id as string, 10);
    const db = DatabaseService.getInstance();
    const user = db.getUser(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { username, password, role } = req.body;
    const updates: Partial<{ username: string; password_hash: string; role: string }> = {};

    if (username !== undefined) {
      const usernameError = validateUsername(username);
      if (usernameError) {
        res.status(400).json({ error: usernameError });
        return;
      }
      const existing = db.getUserByUsername(username);
      if (existing && existing.id !== id) {
        res.status(409).json({ error: 'A user with this username already exists' });
        return;
      }
      updates.username = username;
    }

    if (role !== undefined) {
      if (!VALID_USER_ROLES.includes(role)) {
        res.status(400).json({ error: 'Role must be "admin", "viewer", "deployer", "node-admin", or "auditor"' });
        return;
      }
      if (roleRequiresAdmiral(role) && !requireAdmiral(req, res)) return;
      if (user.username === req.user!.username && role !== user.role) {
        res.status(400).json({ error: 'Cannot change your own role' });
        return;
      }
      // Promoting a non-admin to admin consumes an admin seat; enforce the cap
      // here the same way user creation does, so a role change cannot exceed it.
      if (role === 'admin' && user.role !== 'admin') {
        const seatError = seatLimitError('admin', db);
        if (isDebugEnabled()) {
          console.log('[Users:diag] admin-promotion id=', id, 'blocked=', seatError !== null, 'actor=', sanitizeForLog(req.user!.username));
        }
        if (seatError) {
          res.status(403).json({ error: seatError });
          return;
        }
      }
      updates.role = role;
    }

    if (password !== undefined) {
      // Prevent setting passwords on SSO-provisioned users (would enable a
      // local-login bypass).
      if (user.auth_provider !== 'local') {
        res.status(400).json({ error: 'Cannot set a password on an SSO-provisioned user.' });
        return;
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        return;
      }
      updates.password_hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    }

    // updateUserIfNotLastAdmin returns false only when this update would demote
    // the last remaining admin; map that single case to the guard message.
    const applied = db.updateUserIfNotLastAdmin(id, updates);
    if (!applied) {
      res.status(400).json({ error: 'Cannot demote the only admin user' });
      return;
    }
    // Invalidate the user's active sessions when their role or password changes.
    if (updates.role || updates.password_hash) {
      db.bumpTokenVersion(id);
    }
    console.log('[Users] Updated user', id, 'fields:', Object.keys(updates).join(', '), 'by:', req.user!.username);
    res.json({ success: true });
  } catch (error) {
    console.error('[Users] Update error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

usersRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseInt(req.params.id as string, 10);
    const db = DatabaseService.getInstance();
    const user = db.getUser(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (user.username === req.user!.username) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const deleted = db.deleteUserIfNotLastAdmin(id);
    if (!deleted) {
      res.status(400).json({ error: 'Cannot delete the only admin user' });
      return;
    }
    console.log('[Users] Deleted:', user.username, '(id:', id, ') by:', req.user!.username);
    res.json({ success: true });
  } catch (error) {
    console.error('[Users] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * Admin reset: clear a target user's MFA enrolment and force re-auth. Used
 * when a user has lost their authenticator AND exhausted their backup codes,
 * and another admin is available. For total lockout (including sole admin),
 * see the CLI `reset-mfa` command.
 */
usersRouter.post('/:id/mfa/reset', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'user id');
    if (id === null) return;
    const db = DatabaseService.getInstance();
    const target = db.getUser(id);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    db.deleteUserMfa(id);
    db.bumpTokenVersion(id);
    // The audit-log middleware records this POST automatically (summary
    // "Reset two-factor authentication: <id>", keyed on the target user id);
    // no explicit write is needed here.
    console.log('[MFA] Admin reset: target=', target.username, 'by=', req.user!.username);
    if (isDebugEnabled()) {
      console.log('[MFA:diag] admin-reset target=', target.username, 'actor=', req.user!.username);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[MFA] Admin reset error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to reset two-factor authentication' });
  }
});

// --- Scoped Role Assignments (Admiral) ---

usersRouter.get('/:id/roles', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  if (!requireAdmiral(req, res)) return;
  try {
    const userId = parseInt(req.params.id as string, 10);
    const db = DatabaseService.getInstance();
    if (!db.getUser(userId)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const assignments = db.getAllRoleAssignments(userId);
    res.json(assignments);
  } catch (error) {
    console.error('[Roles] List error:', error);
    res.status(500).json({ error: 'Failed to fetch role assignments' });
  }
});

usersRouter.post('/:id/roles', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  if (!requireAdmiral(req, res)) return;
  try {
    const userId = parseInt(req.params.id as string, 10);
    const { role, resource_type, resource_id } = req.body;

    if (!VALID_ASSIGNMENT_ROLES.includes(role)) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    if (!VALID_RESOURCE_TYPES.includes(resource_type)) {
      res.status(400).json({ error: 'Invalid resource type' });
      return;
    }
    if (!resource_id || typeof resource_id !== 'string') {
      res.status(400).json({ error: 'resource_id is required' });
      return;
    }

    const db = DatabaseService.getInstance();
    if (!db.getUser(userId)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    try {
      const id = db.addRoleAssignment({ user_id: userId, role, resource_type, resource_id });
      console.log('[Roles] Assigned', sanitizeForLog(role), 'on', sanitizeForLog(resource_type), sanitizeForLog(resource_id), 'to user', userId, 'by:', sanitizeForLog(req.user!.username));
      res.status(201).json({ id, user_id: userId, role, resource_type, resource_id });
    } catch (err: unknown) {
      if (isSqliteUniqueViolation(err)) {
        res.status(409).json({ error: 'This role assignment already exists' });
        return;
      }
      throw err;
    }
  } catch (error) {
    console.error('[Roles] Create error:', error);
    res.status(500).json({ error: 'Failed to add role assignment' });
  }
});

usersRouter.delete('/:id/roles/:assignId', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, USERS_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  if (!requireAdmiral(req, res)) return;
  try {
    const userId = parseInt(req.params.id as string, 10);
    const assignId = parseInt(req.params.assignId as string, 10);
    const db = DatabaseService.getInstance();

    const assignment = db.getRoleAssignmentById(assignId);
    if (!assignment || assignment.user_id !== userId) {
      res.status(404).json({ error: 'Role assignment not found' });
      return;
    }

    db.deleteRoleAssignment(assignId);
    console.log('[Roles] Removed assignment', assignId, 'from user', userId, 'by:', req.user!.username);
    res.json({ success: true });
  } catch (error) {
    console.error('[Roles] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete role assignment' });
  }
});
