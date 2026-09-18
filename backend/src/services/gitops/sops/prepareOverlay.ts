import path from 'path';
import type { ComposeInputEntry, GitProjectManifest } from '../../../types/gitProjectManifest';
import { GitOpsDecryptOverlay, newOverlayOperationId, scrubOverlayPaths } from './overlay';
import { SopsIdentityStore } from './identityStore';
import type { OverlayBinding, SecretCapability, SopsFailureClass } from './types';
import { SopsDecryptError } from './decode';
import { parseSecretCapabilityFromJson } from './capability';
import { GitOpsStore } from '../store';
import { NodeRegistry } from '../../NodeRegistry';

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
      throw new Error(scrubOverlayPaths(err.message, dataDir));
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
  if (!cap || cap.requiredRecipients.length === 0) return null;

  const identityMap = SopsIdentityStore.getInstance().getIdentityMap(app.id, args.stackName);
  const missing = cap.requiredRecipients.filter((recipient) => !identityMap.has(recipient));
  if (missing.length > 0) {
    return {
      error: `Rollback requires age recipient(s) that are not available on this node: ${missing.join(', ')}`,
      failureClass: 'missing_key',
    };
  }

  const inputsOrError = sopsInputsFromCapability(cap);
  if ('error' in inputsOrError) return inputsOrError;
  if (inputsOrError.length === 0) return null;

  const sourceRoot = path.join(NodeRegistry.getInstance().getComposeDir(args.nodeId), args.stackName);
  const overlay = await buildGitOpsDecryptOverlay({
    stackName: args.stackName,
    nodeId: args.nodeId,
    applicationId: app.id,
    generationId: args.gitopsGenerationId,
    commitSha: genRow.commit_sha,
    operationId: newOverlayOperationId(),
    sourceRoot,
    manifest: { inputs: inputsOrError },
  });
  return overlay;
}
