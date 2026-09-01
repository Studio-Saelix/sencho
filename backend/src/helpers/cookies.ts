import type { Request } from 'express';

/** True when the request arrived over HTTPS, either directly or via a trusted TLS-terminating proxy. */
export const isSecureRequest = (req: Request): boolean => {
  return req.secure;
};

/**
 * Cookie options derived from the current request (secure flag follows the
 * connection). Lifetime is deliberately not included: each caller sets its own
 * `maxAge` (session cookies vary between the default and "stay signed in", the
 * MFA-pending cookie is minutes long), so a shared default here would only ever
 * be overridden or misread.
 */
export const getCookieOptions = (req: Request) => ({
  httpOnly: true,
  secure: isSecureRequest(req),
  sameSite: 'strict' as const,
});
