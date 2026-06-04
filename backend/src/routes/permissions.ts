import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { ROLE_PERMISSIONS, type PermissionAction } from '../middleware/permissions';

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
    const assignments = db.getAllRoleAssignments(req.user.userId);

    const scopedPermissions: Record<string, PermissionAction[]> = {};
    for (const a of assignments) {
      const key = `${a.resource_type}:${a.resource_id}`;
      const perms = ROLE_PERMISSIONS[a.role] || [];
      const existing = scopedPermissions[key] || [];
      scopedPermissions[key] = [...new Set([...existing, ...perms])];
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
