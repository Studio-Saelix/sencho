import type { Request, Response } from 'express';
import path from 'path';
import DockerController from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import SelfIdentityService from '../services/SelfIdentityService';

export const SELF_STACK_PROTECTED_CODE = 'self_stack_protected';

export const SELF_STACK_PROTECTED_MESSAGE =
  'This stack is the running Sencho instance. Use Fleet -> Node Update to update Sencho. ' +
  'To manage it as a normal stack, move Sencho\'s compose project outside COMPOSE_DIR.';

type ListedContainer = {
  Id?: string;
  Labels?: Record<string, string>;
};

const DEFAULT_COMPOSE_DIR = '/app/compose';

function isHexId(value: string): boolean {
  return /^[a-f0-9]{12,64}$/i.test(value);
}

function matchesContainerId(fullId: string, candidate: string): boolean {
  if (!fullId || !candidate) return false;
  if (fullId === candidate) return true;
  if (!isHexId(fullId) || !isHexId(candidate)) return false;
  return fullId.startsWith(candidate) || candidate.startsWith(fullId);
}

async function getRuntimeContainerIdCandidates(): Promise<string[]> {
  const candidates = new Set<string>();
  const hostname = process.env.HOSTNAME?.trim();
  if (hostname && isHexId(hostname)) candidates.add(hostname);
  const cgroupId = await SelfIdentityService.readContainerIdFromCgroup();
  if (cgroupId) candidates.add(cgroupId);
  return [...candidates];
}

function stackNameFromWorkingDir(workingDir: string | undefined, composeDir = process.env.COMPOSE_DIR || DEFAULT_COMPOSE_DIR): string | null {
  if (!workingDir) return null;
  const resolvedComposeDir = path.resolve(composeDir);
  const resolvedWorkingDir = path.resolve(workingDir);
  const underComposeDir = resolvedWorkingDir === resolvedComposeDir || resolvedWorkingDir.startsWith(resolvedComposeDir + path.sep);
  return underComposeDir ? path.basename(resolvedWorkingDir) : null;
}

function workingDirMatchesStack(workingDir: string | undefined, stackName: string, composeDir?: string): boolean {
  return stackNameFromWorkingDir(workingDir, composeDir) === stackName;
}

async function getRunningContainerLabels(): Promise<Record<string, string> | null> {
  try {
    const runtimeIds = await getRuntimeContainerIdCandidates();
    if (runtimeIds.length === 0) return null;

    const containers = await DockerController.getInstance().getDocker().listContainers({ all: true }) as ListedContainer[];
    const selfContainer = containers.find((container) => {
      const containerId = container.Id;
      return typeof containerId === 'string' && runtimeIds.some(id => matchesContainerId(containerId, id));
    });
    return selfContainer?.Labels ?? null;
  } catch {
    return null;
  }
}

async function runningContainerMatchesStack(stackName: string, composeDir?: string): Promise<boolean> {
  try {
    const labels = await getRunningContainerLabels();
    if (!labels) return false;
    if (labels['com.docker.compose.project'] === stackName) return true;
    return workingDirMatchesStack(labels['com.docker.compose.project.working_dir'], stackName, composeDir);
  } catch {
    return false;
  }
}

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

/** Directory name of the running Sencho compose project, when it is under COMPOSE_DIR. */
export async function getSelfStackDirectoryName(composeDir?: string): Promise<string | null> {
  const labels = await getRunningContainerLabels();
  const workingDirStack = stackNameFromWorkingDir(labels?.['com.docker.compose.project.working_dir'], composeDir);
  if (workingDirStack) return workingDirStack;
  return getSelfStackProjectName();
}

/** True when the stack appears to be the running Sencho compose project. */
export async function isSelfStack(stackName: string, composeDir?: string): Promise<boolean> {
  try {
    const project = await getSelfStackProjectName();
    if (project === stackName) return true;
    return runningContainerMatchesStack(stackName, composeDir);
  } catch {
    return false;
  }
}

/**
 * Identity sources for the self-stack check, resolved once and reused
 * across every stack in a request (the /statuses handler resolves it once
 * per request). The compose project name is a boot-cached property lookup;
 * the container labels fallback (which lists every container on the node)
 * is a single read shared by all stacks. Either source degrades
 * independently to null, so a failure in one never discards the other.
 */
export interface SelfStackIdentity {
  projectName: string | null;
  labels: Record<string, string> | null;
}

/**
 * Resolves both identity sources. Each failure degrades only its own
 * source to null, matching the old per-stack behavior where a labels
 * failure never discarded the resolved project name.
 */
export async function resolveSelfStackIdentity(): Promise<SelfStackIdentity> {
  const projectName = await getSelfStackProjectName().catch((error) => {
    console.error('Failed to resolve self-stack project name; self-stack check degraded:', error);
    return null;
  });
  const labels = await getRunningContainerLabels().catch((error) => {
    console.error('Failed to resolve self-stack container labels; self-stack check degraded:', error);
    return null;
  });
  return { projectName, labels };
}

/** isSelf semantics identical to isSelfStack() when the identity resolves successfully. */
export function isSelfStackByIdentity(identity: SelfStackIdentity, stackName: string, composeDir?: string): boolean {
  if (identity.projectName === stackName) return true;
  const labels = identity.labels;
  if (!labels) return false;
  if (labels['com.docker.compose.project'] === stackName) return true;
  return workingDirMatchesStack(labels['com.docker.compose.project.working_dir'], stackName, composeDir);
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
  req: Request,
  res: Response,
  stackName: string,
): Promise<boolean> {
  const composeDir = FileSystemService.getInstance(req.nodeId).getBaseDir();
  if (!(await isSelfStack(stackName, composeDir))) return false;
  res.status(409).json({ error: SELF_STACK_PROTECTED_MESSAGE, code: SELF_STACK_PROTECTED_CODE });
  return true;
}
