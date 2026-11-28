/** The machine code the backend sends with a 409 when Sencho refused to hand a stack's compose inputs to Compose. */
export const COMPOSE_INPUTS_REFUSED_CODE = 'compose_inputs_refused';

/**
 * Reads Sencho's own refusal text from a failed response.
 *
 * A stack whose compose inputs Sencho refuses answers 409
 * `{ error, code: 'compose_inputs_refused' }` (directly, through a proxied
 * node, and through a Pilot tunnel). A file over the size cap answers 413 with
 * a plain `{ error }`, which is the same kind of actionable reason. Container
 * lists and service lists use the same envelopes, so both readers show the
 * operator the file and the reason instead of a generic failure. The text names
 * the file and the reason and never a value from it, so it is safe to show.
 * Returns null for any other failure, so callers keep their generic wording for
 * those.
 */
export async function readComposeInputsRefusal(res: Response): Promise<string | null> {
  if (res.status !== 409 && res.status !== 413) return null;
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const { error, code } = body as { error?: unknown; code?: unknown };
    if (res.status === 409 && code !== COMPOSE_INPUTS_REFUSED_CODE) return null;
    return typeof error === 'string' && error.trim() !== '' ? error : null;
  } catch {
    return null;
  }
}
