/** Fallback when opening a stack fails and the body is not a short 409 error string. */
export function stackOpenConnectionMessage(filename: string): string {
  const name = filename.replace(/\.(ya?ml)$/, '');
  return `Could not open "${name}". Check your connection and try again.`;
}

/**
 * The server's 409 reason, when the body is JSON with a string error of 1 to
 * 240 characters. Returns null otherwise, and the caller uses the connection message.
 */
export function stackOpenRefusalMessage(filename: string, status: number, body: string): string | null {
  if (status !== 409) return null;
  let error: unknown;
  try {
    error = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return null;
  }
  if (typeof error !== 'string') return null;
  const reason = error.trim();
  if (reason.length === 0 || reason.length > 240) return null;
  const name = filename.replace(/\.(ya?ml)$/, '');
  return `Could not open "${name}". ${reason}`;
}

export class StackOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackOpenError';
  }
}
