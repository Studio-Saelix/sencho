import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { ROLE_PERMISSIONS, type PermissionAction } from '../middleware/permissions';
import { effectiveTier } from '../middleware/tierGates';

export const permissionsRouter = Router();

permissionsRouter.get('/me', authMiddleware, (req: Request, res: Response): void => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const db = DatabaseService.getInstance();
    const globalRole = req.user.role;
    const globalPermissions = ROLE_PERMISSIONS[globalRole] || [];

    // Scoped role assignments only take effect on the paid tier (mirrors
    // checkPermission in middleware/permissions.ts). Returning them to a
    // Community client would render per-resource affordances the API then 403s,
    // for example on an instance that held assignments before a downgrade.
    const scopedPermissions: Record<string, PermissionAction[]> = {};
    if (effectiveTier(req) === 'paid') {
      for (const a of db.getAllRoleAssignments(req.user.userId)) {
        const key = `${a.resource_type}:${a.resource_id}`;
        const perms = ROLE_PERMISSIONS[a.role] || [];
        const existing = scopedPermissions[key] || [];
        scopedPermissions[key] = [...new Set([...existing, ...perms])];
      }
    }

    res.json({
      globalRole,
      globalPermissions,
      scopedPermissions,
    });
  } catch (error) {
    console.error('[Permissions] Error:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});
