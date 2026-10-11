import type { Response } from 'express';
import { DISMISSAL_MODES, type DismissalMode } from '../services/findingDismissals/types';

const MAX_DAYS = 365;
const DAY_MS = 86_400_000;

export interface ParsedDismissalMode {
  mode: DismissalMode;
  expiresAt: number | null;
}

/** The mode and expiry a dismissal request asks for, or null after answering 400. */
export function readDismissalMode(record: Record<string, unknown>, res: Response): ParsedDismissalMode | null {
  const mode = record.mode;
  if (typeof mode !== 'string' || !(DISMISSAL_MODES as readonly string[]).includes(mode)) {
    res.status(400).json({ error: `mode must be one of: ${DISMISSAL_MODES.join(', ')}` });
    return null;
  }
  if (mode !== 'days') return { mode: mode as DismissalMode, expiresAt: null };
  const days = record.days ?? 7;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    res.status(400).json({ error: `days must be a whole number from 1 to ${MAX_DAYS}` });
    return null;
  }
  return { mode: 'days', expiresAt: Date.now() + days * DAY_MS };
}
