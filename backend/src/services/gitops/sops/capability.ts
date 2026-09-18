import type { ComposeInputEntry } from '../../../types/gitProjectManifest';
import type {
  EncryptedSourcePolicy,
  InputEncryptionKind,
  SecretCapability,
  SopsFailureClass,
} from './types';
import { detectSopsContent, isComposePrimaryPath } from './detect';
import { SopsIdentityStore } from './identityStore';
import { GitOpsStore } from '../store';
import { promises as fsPromises } from 'fs';
import path from 'path';

export function parseSecretCapabilityFromJson(raw: string | null): SecretCapability | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SecretCapability;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!Array.isArray(parsed.inputs) || typeof parsed.ready !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function requiredRecipientsFromCapability(cap: SecretCapability | null): string[] {
  if (!cap) return [];
  return cap.requiredRecipients ?? [];
}

export function classifyInputEncryption(
  fileContent: string,
  role: string,
): { encryption: InputEncryptionKind; sopsRecipients: string[]; refusalReason?: string } {
  if (isComposePrimaryPath(role)) {
    const detection = detectSopsContent(fileContent);
    if (detection.kind === 'sops-age' || detection.kind === 'sops-unsupported') {
      return {
        encryption: 'sops-unsupported',
        sopsRecipients: [],
        refusalReason: 'Encrypted compose files are not supported; use file-backed secrets, env files, or configs',
      };
    }
    return { encryption: 'none', sopsRecipients: [] };
  }

  const detection = detectSopsContent(fileContent);
  if (detection.kind === 'none') {
    return { encryption: 'none', sopsRecipients: [] };
  }
  if (detection.kind === 'sops-unsupported') {
    return { encryption: 'sops-unsupported', sopsRecipients: [], refusalReason: detection.reason };
  }
  return { encryption: 'sops-age', sopsRecipients: detection.recipients };
}

export async function classifyInventoryEncryption(
  cloneDir: string,
  inputs: ComposeInputEntry[],
): Promise<{ inputs: ComposeInputEntry[]; composeRefusals: Array<{ reason: string }> }> {
  const composeRefusals: Array<{ reason: string }> = [];
  const classified: ComposeInputEntry[] = [];

  for (const input of inputs) {
    const base = {
      ...input,
      encryption: (input.encryption ?? 'none') as InputEncryptionKind,
      sopsRecipients: input.sopsRecipients ?? [],
    };
    if (
      input.ownership !== 'managed'
      || input.state !== 'present'
      || !input.sourcePath
      || input.dependencyKind === 'build-context'
      || input.dependencyKind === 'build-additional-context'
    ) {
      classified.push(base);
      continue;
    }
    const abs = path.join(cloneDir, input.sourcePath.replace(/\\/g, '/'));
    let content: string;
    try {
      content = await fsPromises.readFile(abs, 'utf8');
    } catch {
      classified.push(base);
      continue;
    }
    const result = classifyInputEncryption(content, input.role);
    if (result.encryption === 'sops-unsupported' && isComposePrimaryPath(input.role)) {
      composeRefusals.push({ reason: result.refusalReason ?? 'Encrypted compose files are not supported' });
    }
    classified.push({
      ...input,
      encryption: result.encryption,
      sopsRecipients: result.sopsRecipients,
      note: result.refusalReason ?? input.note,
    });
  }

  return { inputs: classified, composeRefusals };
}

export function buildSecretCapability(args: {
  policy: EncryptedSourcePolicy;
  inputs: ComposeInputEntry[];
  applicationId: string;
  stackName: string;
}): { capability: SecretCapability; refusal?: { reason: string; failureClass: SopsFailureClass } } {
  const secretInputs: SecretCapability['inputs'] = [];
  const requiredRecipients = new Set<string>();

  for (const input of args.inputs) {
    if (input.sensitivity !== 'high' && input.encryption === 'none') continue;
    const encryption = input.encryption ?? 'none';
    const recipients = input.sopsRecipients ?? [];
    if (encryption === 'sops-age') {
      for (const r of recipients) requiredRecipients.add(r);
    }
    secretInputs.push({
      role: input.role,
      encryption,
      recipientIds: recipients,
      sourcePath: input.sourcePath,
    });
  }

  for (const input of args.inputs) {
    if (input.encryption === 'sops-unsupported') {
      return {
        capability: {
          policy: args.policy,
          inputs: secretInputs,
          ready: false,
          failureClass: 'unsupported_backend',
          requiredRecipients: [...requiredRecipients],
        },
        refusal: { reason: 'Unsupported SOPS backend or encrypted compose file', failureClass: 'unsupported_backend' },
      };
    }
    if (args.policy === 'require_encrypted' && input.sensitivity === 'high' && input.encryption === 'none') {
      return {
        capability: {
          policy: args.policy,
          inputs: secretInputs,
          ready: false,
          failureClass: 'invalid_ciphertext',
          requiredRecipients: [...requiredRecipients],
        },
        refusal: { reason: 'Encrypted source policy requires SOPS-encrypted secret inputs', failureClass: 'invalid_ciphertext' },
      };
    }
  }

  const readiness = SopsIdentityStore.getInstance().computeReadiness({
    applicationId: args.applicationId,
    stackName: args.stackName,
    policy: args.policy,
    requiredRecipients: [...requiredRecipients],
  });

  const capability: SecretCapability = {
    policy: args.policy,
    inputs: secretInputs,
    ready: requiredRecipients.size === 0 ? true : readiness.ready,
    failureClass: readiness.failureClass,
    requiredRecipients: [...requiredRecipients],
  };

  if (!capability.ready && requiredRecipients.size > 0) {
    return {
      capability,
      refusal: {
        reason: 'Required age identity is not available on this node',
        failureClass: readiness.failureClass ?? 'missing_key',
      },
    };
  }

  return { capability };
}

export function lkgBlockedByMissingRecipients(
  secretCapabilityJson: string | null,
  identityRecipients: Set<string>,
): boolean {
  const cap = parseSecretCapabilityFromJson(secretCapabilityJson);
  if (!cap) return false;
  const required = cap.requiredRecipients ?? [];
  if (required.length === 0) return false;
  return required.some((r) => !identityRecipients.has(r));
}

/** Union of required age recipients for the generation in scope on this node. */
export function resolveActiveRequiredRecipients(args: {
  stackName: string;
  nodeId: number;
  gitopsGenerationId?: string | null;
}): string[] {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveDirectApplication(args.stackName);
  if (!app) return [];

  const generationId = args.gitopsGenerationId
    ?? store.getTarget(app.id, args.nodeId)?.deployed_generation_id
    ?? app.accepted_generation_id
    ?? app.candidate_generation_id;
  if (!generationId) return [];

  const cap = parseSecretCapabilityFromJson(store.getGeneration(generationId)?.secret_capability_json ?? null);
  return cap?.requiredRecipients ?? [];
}
