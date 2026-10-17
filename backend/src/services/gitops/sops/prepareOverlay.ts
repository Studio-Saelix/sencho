import path from 'path';
import { promises as fsPromises } from 'fs';
import type { ComposeInputEntry, GitProjectManifest } from '../../../types/gitProjectManifest';
import { GitOpsDecryptOverlay, newOverlayOperationId, scrubOverlayPaths } from './overlay';
import { SopsIdentityStore } from './identityStore';
import type { OverlayBinding, SecretCapability, SopsFailureClass } from './types';
import { SopsDecryptError } from './decode';
import { classifyInputEncryption, missingRecipientsForCapability, missingRecipientsForInputs, parseSecretCapabilityFromJson } from './capability';
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

/** The capability view of one restored input, for the per-file readiness rule. */
function capabilityInputOf(input: ComposeInputEntry): SecretCapability['inputs'][number] {
  return {
    role: input.role,
    encryption: input.encryption ?? 'none',
    recipientIds: input.sopsRecipients ?? [],
    sourcePath: input.sourcePath,
    materializedPath: input.materializedPath,
  };
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
  const available = new Set(identityMap.keys());

  // The recorded inputs come first, and the key a generation names is the
  // refusal an operator can act on, so it is reported before the files the
  // generation never classified are read.
  let recorded: ComposeInputEntry[] = [];
  if (cap && cap.requiredRecipients.length > 0) {
    const missing = missingRecipientsForCapability(cap, available);
    if (missing.length > 0) {
      return {
        error: `Rollback requires age recipient(s) that are not available on this node: ${missing.join(', ')}`,
        failureClass: 'missing_key',
      };
    }
    const inputsOrError = sopsInputsFromCapability(cap);
    if ('error' in inputsOrError) return inputsOrError;
    recorded = inputsOrError;
  }

  // The restored bytes are the authority for a file the generation did not
  // classify as encrypted, whatever its capability recorded for other files. A
  // generation can hold recipients for a recognized encrypted `env_file` while
  // its synced sibling `.env` was classified as plaintext, and Compose would
  // interpolate that ciphertext. Each restored file that is an age document is
  // verified against the identities on this node: decryptable when any one of
  // its recipients is available, refused before Compose when none is. A file
  // both sets name keeps the role and path the generation recorded.
  const restored = await restoredEncryptedEnvInputs({
    stackName: args.stackName,
    nodeId: args.nodeId,
    capability: cap,
  });
  const recordedPaths = new Set(recorded.map((input) => input.materializedPath ?? ''));
  const discovered = restored.filter((input) => !recordedPaths.has(input.materializedPath ?? ''));
  const missingRestored = missingRecipientsForInputs(discovered.map(capabilityInputOf), available);
  if (missingRestored.length > 0) {
    return {
      error: `Rollback requires age recipient(s) that are not available on this node: ${missingRestored.join(', ')}`,
      failureClass: 'missing_key',
    };
  }
  const inputs = [...recorded, ...discovered];
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
 * Read for every recovery, not only a generation whose capability names no
 * recipient: the stored capability says what the generation recorded, while the
 * restored bytes say what is on disk now, and only the second covers a synced
 * sibling `.env` an older generation classified as plaintext. `.env` and the
 * configured project env files are the same set the direct-mutation guard
 * reads, and the generation's own recorded paths are added so a secret stored
 * below the stack root is covered too, under the role the generation gave it,
 * so a dotenv secret keeps the output form that role selects. A file that is
 * not an age document is skipped, which is what keeps a genuinely plaintext
 * generation on the plain path. The recipients come from the file itself.
 */
async function restoredEncryptedEnvInputs(args: {
  stackName: string;
  nodeId: number;
  capability: SecretCapability | null;
}): Promise<ComposeInputEntry[]> {
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
  return inputs;
}
