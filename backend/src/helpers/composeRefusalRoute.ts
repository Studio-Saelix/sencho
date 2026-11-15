import type { Response } from 'express';
import { ComposeExpansionRefusal } from './composeExpansionGuard';

/** The machine code a client switches on when Sencho refused to hand a stack's inputs to Compose. */
export const COMPOSE_INPUTS_REFUSED_CODE = 'compose_inputs_refused';

/**
 * Answers 409 with Sencho's own refusal text when `error` is the expansion
 * guard's refusal, and returns true (the caller returns). Any other error
 * returns false.
 *
 * Every operation that needs Compose to read a stack runs the guard first, so a
 * route over such an operation can reach this refusal and should say so instead
 * of reading as "no containers", a generic 500, or a success. The text names the
 * file and the reason and never a value from it, so it is safe to show.
 */
export function sendIfComposeInputsRefused(res: Response, error: unknown): boolean {
  if (!(error instanceof ComposeExpansionRefusal)) return false;
  if (!res.headersSent) {
    res.status(409).json({ error: error.message, code: COMPOSE_INPUTS_REFUSED_CODE });
  }
  return true;
}
