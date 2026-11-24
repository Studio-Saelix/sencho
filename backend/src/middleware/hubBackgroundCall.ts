import type { Request, Response } from 'express';

/** The machine code a hub-background-only route answers to any other caller. */
export const HUB_BACKGROUND_REQUIRED_CODE = 'HUB_BACKGROUND_REQUIRED';

/**
 * Whether this request is the hub's own background call: a `node_proxy` or
 * `pilot_tunnel` bearer that carries no forwarded role header. A cookie
 * session, an API token and a user request the hub proxied (the gateway always
 * sets the role header) all fail. Answers 403 and returns false when not.
 */
export function requireHubBackgroundCall(req: Request, res: Response): boolean {
  const machine = req.machineAuthScope === 'node_proxy' || req.machineAuthScope === 'pilot_tunnel';
  if (machine && req.hubBackgroundCall === true) return true;
  res.status(403).json({
    error: 'Only the control instance can call this endpoint.',
    code: HUB_BACKGROUND_REQUIRED_CODE,
  });
  return false;
}
