import type { Request } from 'express';
import type { LabelInventoryOptions } from '../services/LabelInventoryService';
import { requireAdmin } from '../middleware/tierGates';

/** Parse ?reveal=1; full values only when the caller is an admin. */
export function labelInventoryOptionsFromRequest(req: Request): LabelInventoryOptions {
  const wantsReveal = req.query.reveal === '1' || req.query.reveal === 'true';
  if (!wantsReveal) return { revealSecrets: false };
  // requireAdmin is synchronous guard; routes call it before building inventory when reveal is requested.
  return { revealSecrets: true };
}

/** Returns false and sends 403 when reveal was requested but caller is not admin. */
export function requireRevealAdmin(req: Request, res: import('express').Response): boolean {
  const wantsReveal = req.query.reveal === '1' || req.query.reveal === 'true';
  if (!wantsReveal) return true;
  return requireAdmin(req, res);
}
