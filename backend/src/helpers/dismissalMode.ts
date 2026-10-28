import type { Response } from 'express';
import { DISMISSAL_MODES, isDismissalMode, type DismissalTiming } from '../services/findingDismissals/types';

export const MAX_TARGET_COUNT = 10_000_000;
const MAX_DAYS = 365;
const DAY_MS = 86_400_000;

/** The mode and expiry a dismissal request asks for, or null after answering 400. */
export function readDismissalMode(record: Record<string, unknown>, res: Response): DismissalTiming | null {
  const mode = record.mode;
  if (!isDismissalMode(mode)) {
    res.status(400).json({ error: `mode must be one of: ${DISMISSAL_MODES.join(', ')}` });
    return null;
  }
  if (mode !== 'days') return { mode, expiresAt: null };
  const days = record.days ?? 7;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    res.status(400).json({ error: `days must be a whole number from 1 to ${MAX_DAYS}` });
    return null;
  }
  return { mode: 'days', expiresAt: Date.now() + days * DAY_MS };
}
