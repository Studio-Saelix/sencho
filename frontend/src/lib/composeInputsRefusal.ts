/** The machine code the backend sends with a 409 when Sencho refused to hand a stack's compose inputs to Compose. */
export const COMPOSE_INPUTS_REFUSED_CODE = 'compose_inputs_refused';

/**
 * Reads Sencho's own refusal text from a failed response.
 *
 * A stack whose compose inputs Sencho refuses answers 409
 * `{ error, code: 'compose_inputs_refused' }` (directly, through a proxied
 * node, and through a Pilot tunnel); the message names the file and the reason.
 * The service list also answers its own 1 MiB byte-cap check before parsing,
 * with a filename-free 413 `{ error }`. The container list reaches the same cap
 * through the Compose guard, so it answers the guard's filename-naming 409
 * instead. Both are the same kind of actionable reason, so both readers show
 * the operator the text instead of a generic failure, and neither text carries
 * a value from the file. An older serving node that does not implement these
 * envelopes answers its previous generic error, which this reader returns null
 * for. Returns null for any other failure, so callers keep their generic
 * wording for those.
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
