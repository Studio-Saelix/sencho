import type { Request, Response } from 'express';
import SelfIdentityService from '../services/SelfIdentityService';

export const SELF_STACK_PROTECTED_CODE = 'self_stack_protected';

export const SELF_STACK_PROTECTED_MESSAGE =
  'This stack is the running Sencho instance. Use Fleet -> Node Update to update Sencho. ' +
  'To manage it as a normal stack, move Sencho\'s compose project outside COMPOSE_DIR.';

/** Compose project name of the running Sencho container, or null when not in Docker. */
export async function getSelfStackProjectName(): Promise<string | null> {
  try {
    const self = SelfIdentityService.getInstance();
    await self.initialize();
    return self.getIdentity().composeProjectName;
  } catch {
    return null;
  }
}

/** True when the stack directory name matches Sencho's own compose project. */
export async function isSelfStack(stackName: string): Promise<boolean> {
  try {
    const project = await getSelfStackProjectName();
    if (!project) return false;
    return project === stackName;
  } catch {
    return false;
  }
}

export interface SelfStackProtectedResult {
  stackName: string;
  ok: false;
  error: string;
  code: typeof SELF_STACK_PROTECTED_CODE;
}

export function selfStackProtectedBulkResult(stackName: string): SelfStackProtectedResult {
  return {
    stackName,
    ok: false,
    error: SELF_STACK_PROTECTED_MESSAGE,
    code: SELF_STACK_PROTECTED_CODE,
  };
}

/** When the stack is Sencho itself, respond 409 and return true (caller should return). */
export async function refuseIfSelfStack(
  _req: Request,
  res: Response,
  stackName: string,
): Promise<boolean> {
  if (!(await isSelfStack(stackName))) return false;
  res.status(409).json({ error: SELF_STACK_PROTECTED_MESSAGE, code: SELF_STACK_PROTECTED_CODE });
  return true;
}
