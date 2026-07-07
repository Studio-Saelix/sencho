import type { Request, Response } from 'express';
import semver from 'semver';
import { isValidVersion } from '../services/CapabilityRegistry';

/** The semver compare target when valid, otherwise undefined (legacy pull-current). */
export function pickCompareTarget(compareVersion: string | null, compareValid: boolean): string | undefined {
  if (!compareValid || !isValidVersion(compareVersion)) return undefined;
  return compareVersion;
}

/**
 * Parse an optional `targetVersion` from a self-update request body.
 *
 * - Omitted or null -> returns undefined (the caller chooses the default).
 * - Present and a valid semver -> returns the normalized version.
 * - Present but not a valid semver -> writes a 400 and returns null so the
 *   caller early-returns. We never silently fall back on a supplied-but-bad
 *   value, because that would hide a client bug and update to the wrong target.
 */
export function parseRequestedTargetVersion(req: Request, res: Response): string | null | undefined {
  const raw = (req.body ?? {})?.targetVersion;
  if (raw === undefined || raw === null) return undefined;
  const normalized = typeof raw === 'string' ? semver.valid(raw) : null;
  if (!normalized || !isValidVersion(normalized) || raw.length > 64) {
    res.status(400).json({ error: 'Invalid target version' });
    return null;
  }
  return normalized;
}
