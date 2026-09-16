/**
 * Shared registry-delivery source selection.
 *
 * Both the delivery service (hub-side attestation signing) and the seam
 * (target-side verification) resolve which compose files, env files, and env
 * vars a delivery is discovered and hashed against. Both arms call this same
 * resolver with the same prepared entry or live project directory, so their
 * attested hashes cannot disagree.
 *
 * Env vars come from the on-disk `.env` of `rootDir` (the prepared payload for
 * prepared kinds, the live project dir for live-project). Request-supplied env
 * vars are already materialized into that `.env` during preparation, so both
 * arms derive the identical map without carrying request state across the
 * seam.
 */
import fs from 'fs';
import path from 'path';
import { NodeRegistry } from '../services/NodeRegistry';
import { DatabaseService } from '../services/DatabaseService';
import { buildCandidateComposeInvocation } from '../utils/candidateComposeInvocation';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs } from '../utils/authoredComposeArgs';
import { readGitCandidatePreparedMeta } from './registryDeliveryGitCandidate';
import { resolveComposeEnvForDiscovery } from './registryDeliveryComposeEnv';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';
import { isValidStackName, isPathWithinBase } from '../utils/validation';

export type RegistryDeliverySelectionKind =
  | 'request-generated'
  | 'git-candidate'
  | 'restore-candidate'
  | 'live-project';

/** Selection basis captured at preparation time for a recovery-restore candidate. */
export interface RegistryDeliveryCapturedBasis {
  kind: 'recovery';
  composeFiles?: string[];
  envFiles: string[];
}

/**
 * The single selection both delivery arms resolve. `composeFiles` undefined
 * means discovery falls back to the default root compose names; `envFiles` are
 * the env files that participate in the live-project source hash.
 */
export interface RegistryDeliverySelection {
  composeFiles?: string[];
  envFiles: string[];
  envVars: Record<string, string>;
}

export interface RegistryDeliverySelectionInput {
  kind: string;
  stackName: string;
  nodeId: number;
  /** Prepared payload path for prepared kinds; the live project dir for live-project. */
  rootDir: string;
  capturedBasis?: RegistryDeliveryCapturedBasis;
}

/** Narrow a raw source kind string to the closed selection kind set. */
export function toSelectionKind(kind: string): RegistryDeliverySelectionKind {
  if (
    kind === 'request-generated'
    || kind === 'git-candidate'
    || kind === 'restore-candidate'
    || kind === 'live-project'
  ) {
    return kind;
  }
  throw new Error(`Unsupported registry delivery source kind: ${kind}`);
}

/** Absolute stack directory for a node, guarded for valid name and containment. */
export function liveStackDirForNode(nodeId: number, stackName: string): string {
  if (!isValidStackName(stackName)) {
    throw new Error('Invalid stack name');
  }
  const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
  const stackDir = path.resolve(baseResolved, stackName);
  if (!isPathWithinBase(stackDir, baseResolved)) {
    throw new Error('Invalid stack path');
  }
  return stackDir;
}

function extractFlagArgs(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

/**
 * Rebuild the selection basis a recovery generation captured at invocation
 * time. `explicitComposeFiles` are stack-relative and resolve against the
 * prepared payload root; the `--env-file` values are realpathed stack-root
 * names, so only their basename participates (the sole consumer, the source
 * hash, maps env paths to basenames).
 */
export function invocationBasisFromRecord(
  invocation: RollbackInvocationRecord,
): RegistryDeliveryCapturedBasis {
  const composeFiles =
    invocation.explicitComposeFiles.length > 0
      ? [...invocation.explicitComposeFiles]
      : undefined;
  const envFiles = extractFlagArgs(invocation.composeArgsPrefix, '--env-file').map(p =>
    path.basename(p),
  );
  return { kind: 'recovery', composeFiles, envFiles };
}

// The stack dir comes from a caller-supplied name, confined by isValidStackName (no
// separators, no dots) and isPathWithinBase inside liveStackDirForNode, so the path
// below cannot traverse. A containment check on the resolved stack dir repeats the
// guard in the shape CodeQL's query recognizes, so the filesystem sink is in-bounds.
async function gitCandidateSelection(
  input: RegistryDeliverySelectionInput,
  envVars: Record<string, string>,
): Promise<RegistryDeliverySelection> {
  const meta = await readGitCandidatePreparedMeta(input.rootDir);
  const stackDir = liveStackDirForNode(input.nodeId, input.stackName);
  const stackBaseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(input.nodeId));
  const stackDirResolved = path.resolve(stackDir);
  if (!stackDirResolved.startsWith(stackBaseResolved + path.sep)) {
    throw new Error('Invalid stack path');
  }
  const projectEnvFiles = DatabaseService.getInstance().getStackProjectEnvFiles(
    input.nodeId,
    input.stackName,
  );
  const args = buildCandidateComposeInvocation({
    stackName: input.stackName,
    composePaths: meta.composeFiles.map(f => f.path),
    contextDir: meta.contextDir ?? null,
    stackDir,
    syncEnv: meta.syncEnv ?? false,
    envContentPresent: meta.envContent !== null,
    projectEnvFiles,
    rootEnvFilePresent: fs.existsSync(path.join(stackDirResolved, '.env')),
  });
  const composeFiles = extractFlagArgs(args, '-f');
  const envFiles = extractFlagArgs(args, '--env-file');
  return {
    composeFiles: composeFiles.length > 0 ? composeFiles : undefined,
    envFiles,
    envVars,
  };
}

async function restoreCandidateSelection(
  input: RegistryDeliverySelectionInput,
  envVars: Record<string, string>,
): Promise<RegistryDeliverySelection> {
  if (input.capturedBasis && input.capturedBasis.kind === 'recovery') {
    return {
      composeFiles: input.capturedBasis.composeFiles,
      envFiles: input.capturedBasis.envFiles,
      envVars,
    };
  }
  // Backup restore materializes the flat backup slot: the default root compose
  // names apply, matching both arms scanning the same payload dir.
  return { composeFiles: undefined, envFiles: [], envVars };
}

async function liveProjectSelection(
  input: RegistryDeliverySelectionInput,
  envVars: Record<string, string>,
): Promise<RegistryDeliverySelection> {
  const fileArgs = authoredComposeFileArgs(input.stackName, input.nodeId);
  const envArgs = await authoredComposeEnvFileArgs(input.stackName, input.nodeId);
  const composeFiles = extractFlagArgs(fileArgs, '-f');
  const envFiles = extractFlagArgs(envArgs, '--env-file');
  return {
    composeFiles: composeFiles.length > 0 ? composeFiles : undefined,
    envFiles,
    envVars,
  };
}

export async function resolveRegistryDeliverySelection(
  input: RegistryDeliverySelectionInput,
): Promise<RegistryDeliverySelection> {
  const kind = toSelectionKind(input.kind);
  const envVars = resolveComposeEnvForDiscovery(input.rootDir);
  switch (kind) {
    case 'request-generated':
      return { composeFiles: undefined, envFiles: [], envVars };
    case 'git-candidate':
      return gitCandidateSelection(input, envVars);
    case 'restore-candidate':
      return restoreCandidateSelection(input, envVars);
    case 'live-project':
      return liveProjectSelection(input, envVars);
  }
}
