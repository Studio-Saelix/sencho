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
import { createHash } from 'crypto';
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

function capabilityInputKey(input: SecretCapability['inputs'][number]): string {
  return input.materializedPath ?? input.sourcePath ?? '';
}

/**
 * True when the computed capability names encrypted inputs or recipients
 * the stored generation does not. A null stored capability understates
 * only when the current inputs are encrypted; a plaintext generation with
 * no stored capability is not stale.
 */
export function capabilityUnderstatesEncryption(
  stored: SecretCapability | null,
  computed: SecretCapability,
): boolean {
  const computedEncrypted = computed.inputs.filter((input) => input.encryption !== 'none');
  if (computedEncrypted.length === 0 && computed.requiredRecipients.length === 0) return false;
  if (!stored) return true;

  const storedByKey = new Map<string, SecretCapability['inputs'][number]>();
  for (const input of stored.inputs) {
    const key = capabilityInputKey(input);
    if (key) storedByKey.set(key, input);
  }

  for (const input of computedEncrypted) {
    const prior = storedByKey.get(capabilityInputKey(input));
    if (!prior || prior.encryption !== input.encryption) return true;
    const priorRecipients = new Set(prior.recipientIds);
    for (const recipient of input.recipientIds) {
      if (!priorRecipients.has(recipient)) return true;
    }
  }

  const storedRecipients = new Set(stored.requiredRecipients ?? []);
  for (const recipient of computed.requiredRecipients) {
    if (!storedRecipients.has(recipient)) return true;
  }
  return false;
}

/**
 * True when one input names recipients and no identity on this node opens it.
 * A file encrypted to several recipients is decryptable by any one of them, so
 * readiness is per input, not per recipient.
 */
function inputIsUndecryptable(
  input: SecretCapability['inputs'][number],
  available: Set<string>,
): boolean {
  const recipients = input.recipientIds ?? [];
  return input.encryption === 'sops-age'
    && recipients.length > 0
    && !recipients.some((recipient) => available.has(recipient));
}

/** Inputs from this capability that no identity on this node opens, in declared order. */
export function undecryptableInputs(
  cap: SecretCapability,
  available: Set<string>,
): SecretCapability['inputs'] {
  return cap.inputs.filter((input) => inputIsUndecryptable(input, available));
}

/**
 * Recipients named by inputs no available identity can decrypt, in first-seen
 * order. The same per-file rule, for a caller that holds inputs rather than a
 * whole capability (inputs discovered from the files a rollback restored).
 */
export function missingRecipientsForInputs(
  inputs: SecretCapability['inputs'],
  available: Set<string>,
): string[] {
  const missing = new Set<string>();
  for (const input of inputs) {
    if (!inputIsUndecryptable(input, available)) continue;
    for (const recipient of input.recipientIds ?? []) missing.add(recipient);
  }
  return [...missing];
}

/** Recipients named by inputs that no available identity can decrypt. */
export function missingRecipientsForCapability(
  cap: SecretCapability,
  available: Set<string>,
): string[] {
  return missingRecipientsForInputs(cap.inputs, available);
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

export function syncEnvInputEntry(envContent: string): ComposeInputEntry {
  const classified = classifyInputEncryption(envContent, 'env');
  return {
    sourcePath: null,
    materializedPath: '.env',
    role: 'env',
    dependencyKind: 'sync-env',
    ownership: 'managed',
    provenance: 'fetch',
    sensitivity: 'high',
    contentSha256: createHash('sha256').update(envContent).digest('hex'),
    sizeBytes: Buffer.byteLength(envContent, 'utf8'),
    state: 'present',
    deletionAuthority: 'sencho',
    note: classified.refusalReason ?? null,
    encryption: classified.encryption,
    sopsRecipients: classified.sopsRecipients,
  };
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
    if (input.sensitivity !== 'high' && (input.encryption ?? 'none') === 'none') continue;
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
      materializedPath: input.materializedPath,
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
    if (
      args.policy === 'require_encrypted'
      && input.ownership === 'managed'
      && input.sensitivity === 'high'
      && (input.encryption ?? 'none') === 'none'
    ) {
      // The policy governs managed repository content. Unmanaged entries are
      // not materialized by Sencho, so an absent project env file cannot make
      // every stack fail the policy.
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
    inputs: secretInputs,
  });

  const capability: SecretCapability = {
    policy: args.policy,
    inputs: secretInputs,
    ready: readiness.ready,
    failureClass: readiness.failureClass,
    requiredRecipients: readiness.requiredRecipients,
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
  if (cap.inputs.length === 0) {
    // Legacy capability shape without per-input recipients.
    const required = cap.requiredRecipients ?? [];
    return required.some((recipient) => !identityRecipients.has(recipient));
  }
  return undecryptableInputs(cap, identityRecipients).length > 0;
}

/**
 * Secret capability recorded for one generation on this node.
 *
 * `deployed` (the default) starts at `deployed_generation_id`. `applied`
 * starts at `applied_generation_id`, then `deployed_generation_id` when
 * nothing has been applied. Both then fall back to the accepted generation,
 * then the candidate. An explicit `gitopsGenerationId` wins over that chain.
 * Direct mutation passes `applied`, so a generation that is applied but not
 * yet deployed still supplies its recipient list.
 */
export function resolveActiveCapability(args: {
  stackName: string;
  nodeId: number;
  gitopsGenerationId?: string | null;
  basis?: 'applied' | 'deployed';
}): SecretCapability | null {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveDirectApplication(args.stackName);
  if (!app) return null;

  const target = store.getTarget(app.id, args.nodeId);
  const recorded = args.basis === 'applied'
    ? target?.applied_generation_id ?? target?.deployed_generation_id
    : target?.deployed_generation_id;
  const generationId = args.gitopsGenerationId
    ?? recorded
    ?? app.accepted_generation_id
    ?? app.candidate_generation_id;
  if (!generationId) return null;

  return parseSecretCapabilityFromJson(store.getGeneration(generationId)?.secret_capability_json ?? null);
}

/** Union of required age recipients for the generation in scope on this node. */
export function resolveActiveRequiredRecipients(args: {
  stackName: string;
  nodeId: number;
  gitopsGenerationId?: string | null;
  basis?: 'applied' | 'deployed';
}): string[] {
  return resolveActiveCapability(args)?.requiredRecipients ?? [];
}
