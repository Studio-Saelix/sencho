import path from 'path';
import { promises as fsPromises } from 'fs';
import type { ComposeInputEntry, GitProjectManifest } from '../../../types/gitProjectManifest';
import { GitOpsDecryptOverlay, newOverlayOperationId, scrubOverlayPaths } from './overlay';
import { SopsIdentityStore } from './identityStore';
import type { OverlayBinding, SecretCapability, SopsFailureClass } from './types';
import { SopsDecryptError } from './decode';
import { classifyInputEncryption, missingRecipientsForCapability, parseSecretCapabilityFromJson } from './capability';
import { isComposePrimaryPath } from './detect';
import { GitOpsStore } from '../store';
import { NodeRegistry } from '../../NodeRegistry';
import { DatabaseService } from '../../DatabaseService';
import { isValidRelativeStackPath } from '../../../utils/validation';

const GIT_OVERLAY_SOURCES = new Set([
  'from_git',
  'git_apply',
  'rollback',
]);

export const SOPS_DIRECT_MUTATION_MESSAGE =
  'This stack has SOPS-encrypted repository secrets. Deploy or update it through Git apply so Sencho can decrypt them in a controlled overlay.';

export function assertGitOverlaySource(source: string): void {
  if (!GIT_OVERLAY_SOURCES.has(source)) {
    throw new Error('Decrypt overlay is only allowed for Git-sourced Compose operations');
  }
}

export function manifestInputsNeedOverlay(manifest: Pick<GitProjectManifest, 'inputs'>): boolean {
  return manifest.inputs.some((input) => input.encryption === 'sops-age');
}

export function sopsInputsFromManifest(manifest: Pick<GitProjectManifest, 'inputs'>): ComposeInputEntry[] {
  return manifest.inputs.filter((input) => input.encryption === 'sops-age' && input.materializedPath);
}

function capabilityMismatch(error: string): { error: string; failureClass: SopsFailureClass } {
  return { error, failureClass: 'capability_mismatch' };
}

export function sopsInputsFromCapability(
  cap: SecretCapability,
): ComposeInputEntry[] | { error: string; failureClass: SopsFailureClass } {
  const encrypted = cap.inputs.filter((input) => input.encryption === 'sops-age');
  if (cap.requiredRecipients.length > 0 && encrypted.length === 0) {
    return capabilityMismatch(
      'Rollback cannot decrypt this generation because its secret capability does not record encrypted inputs.',
    );
  }
  const inputs: ComposeInputEntry[] = [];
  for (const input of encrypted) {
    if (!input.materializedPath) {
      return capabilityMismatch(
        'Rollback cannot decrypt this generation because its secret capability does not record encrypted file paths.',
      );
    }
    inputs.push({
      sourcePath: input.sourcePath ?? input.materializedPath,
      materializedPath: input.materializedPath,
      role: input.role as ComposeInputEntry['role'],
      dependencyKind: 'env_file',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'high',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
      encryption: 'sops-age',
      sopsRecipients: input.recipientIds,
    });
  }
  return inputs;
}

export async function buildGitOpsDecryptOverlay(args: {
  stackName: string;
  nodeId: number;
  applicationId: string;
  generationId: string;
  commitSha: string;
  operationId?: string;
  sourceRoot: string;
  manifest: Pick<GitProjectManifest, 'inputs'>;
}): Promise<{ overlayDir: string; binding: OverlayBinding; operationId: string } | null> {
  const inputs = sopsInputsFromManifest(args.manifest);
  if (inputs.length === 0) return null;

  const operationId = args.operationId ?? newOverlayOperationId();
  const binding: OverlayBinding = {
    applicationId: args.applicationId,
    commitSha: args.commitSha,
    generationId: args.generationId,
    operationId,
    stackName: args.stackName,
    nodeId: args.nodeId,
  };

  const identityByRecipient = SopsIdentityStore.getInstance().getIdentityMap(
    args.applicationId,
    args.stackName,
  );

  try {
    const overlayDir = await GitOpsDecryptOverlay.getInstance().buildFromTree({
      sourceRoot: args.sourceRoot,
      binding,
      inputs,
      identityByRecipient,
    });
    return { overlayDir, binding, operationId };
  } catch (err) {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    if (err instanceof SopsDecryptError) {
      throw new SopsDecryptError(err.code, scrubOverlayPaths(err.message, dataDir));
    }
    throw err;
  }
}

export async function destroyGitOpsOverlay(binding: OverlayBinding): Promise<void> {
  await GitOpsDecryptOverlay.getInstance().destroy(binding.nodeId, binding.stackName, binding.operationId);
}

export async function prepareRecoveryComposeOverlay(args: {
  stackName: string;
  nodeId: number;
  gitopsGenerationId: string;
}): Promise<{ overlayDir: string; binding: OverlayBinding } | { error: string; failureClass: SopsFailureClass } | null> {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveDirectApplication(args.stackName);
  if (!app) return null;
  const genRow = store.getGeneration(args.gitopsGenerationId);
  if (!genRow) return null;
  const cap = parseSecretCapabilityFromJson(genRow.secret_capability_json);
  const identityMap = SopsIdentityStore.getInstance().getIdentityMap(app.id, args.stackName);

  let inputs: ComposeInputEntry[];
  if (cap && cap.requiredRecipients.length > 0) {
    const missing = missingRecipientsForCapability(cap, new Set(identityMap.keys()));
    if (missing.length > 0) {
      return {
        error: `Rollback requires age recipient(s) that are not available on this node: ${missing.join(', ')}`,
        failureClass: 'missing_key',
      };
    }
    const inputsOrError = sopsInputsFromCapability(cap);
    if ('error' in inputsOrError) return inputsOrError;
    inputs = inputsOrError;
  } else {
    // A generation stored before the synced sibling .env was classified records
    // no recipients for it, and a zero-length recipient list does not make the
    // restored file plaintext. The restored bytes are the authority instead: an
    // age document carries its own recipients, so a decryptable input is built
    // from it and an input that no identity can decrypt refuses the rollback
    // rather than letting Compose launch the ciphertext.
    const verified = await restoredEncryptedEnvInputs({
      stackName: args.stackName,
      nodeId: args.nodeId,
      capability: cap,
      available: new Set(identityMap.keys()),
    });
    if (verified.inputs.length === 0) return null;
    if (verified.missingRecipients.length > 0) {
      return {
        error: `Rollback requires age recipient(s) that are not available on this node: ${verified.missingRecipients.join(', ')}`,
        failureClass: 'missing_key',
      };
    }
    inputs = verified.inputs;
  }
  if (inputs.length === 0) return null;

  const sourceRoot = path.join(NodeRegistry.getInstance().getComposeDir(args.nodeId), args.stackName);
  const overlay = await buildGitOpsDecryptOverlay({
    stackName: args.stackName,
    nodeId: args.nodeId,
    applicationId: app.id,
    generationId: args.gitopsGenerationId,
    commitSha: genRow.commit_sha,
    operationId: newOverlayOperationId(),
    sourceRoot,
    manifest: { inputs },
  });
  return overlay;
}

/**
 * Env inputs at the stack root whose restored bytes are still age ciphertext.
 *
 * Read for a generation whose stored capability names no recipient, where the
 * capability cannot say what the restored files are. `.env` and the configured
 * project env files are the same set the direct-mutation guard reads, so a
 * synced sibling `.env` is covered even though the generation never recorded
 * it, and the generation's own recorded paths are added so a secret stored
 * below the stack root is covered too, under the role the generation gave it,
 * so a dotenv secret keeps the output form that role selects. A file that is
 * not an age document is skipped, which is what keeps a genuinely plaintext
 * generation on the plain path. The recipients come from the file itself.
 */
async function restoredEncryptedEnvInputs(args: {
  stackName: string;
  nodeId: number;
  capability: SecretCapability | null;
  available: Set<string>;
}): Promise<{ inputs: ComposeInputEntry[]; missingRecipients: string[] }> {
  const stackDir = path.resolve(
    NodeRegistry.getInstance().getComposeDir(args.nodeId),
    args.stackName,
  );
  const candidates = new Map<string, string>([['.env', 'env']]);
  for (const input of args.capability?.inputs ?? []) {
    // A compose file is refused as an encrypted input everywhere else, and it
    // is not read here either.
    if (isComposePrimaryPath(input.role)) continue;
    const rel = input.materializedPath ?? input.sourcePath;
    if (rel && isValidRelativeStackPath(rel) && rel !== '') candidates.set(rel, input.role);
  }
  for (const name of DatabaseService.getInstance().getStackProjectEnvFiles(args.nodeId, args.stackName)) {
    if (name && isValidRelativeStackPath(name) && name !== '') candidates.set(name, 'env');
  }

  const inputs: ComposeInputEntry[] = [];
  const missingRecipients = new Set<string>();
  for (const [rel, role] of candidates) {
    const target = path.resolve(stackDir, rel);
    if (!target.startsWith(stackDir + path.sep)) continue;
    let content: string;
    try {
      content = await fsPromises.readFile(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `Rollback could not read "${rel}" for stack "${args.stackName}" to verify whether it is encrypted`,
      );
    }
    const classified = classifyInputEncryption(content, role);
    if (classified.encryption !== 'sops-age') continue;
    for (const recipient of classified.sopsRecipients) {
      if (!args.available.has(recipient)) missingRecipients.add(recipient);
    }
    inputs.push({
      sourcePath: rel,
      materializedPath: rel,
      role: role as ComposeInputEntry['role'],
      dependencyKind: 'env_file',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'high',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
      encryption: 'sops-age',
      sopsRecipients: classified.sopsRecipients,
    });
  }
  return { inputs, missingRecipients: [...missingRecipients] };
}
