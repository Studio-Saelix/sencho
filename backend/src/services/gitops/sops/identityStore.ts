import crypto from 'crypto';
import { DatabaseService } from '../../DatabaseService';
import { CryptoService } from '../../CryptoService';
import type { EncryptedSourcePolicy, PublicSopsIdentity, SopsIdentityImpact, SopsIdentityReadiness } from './types';
import { parseSecretCapabilityFromJson } from './capability';

export type SopsIdentityRow = {
  id: string;
  application_id: string;
  stack_name: string;
  recipient: string;
  encrypted_identity: string;
  label: string | null;
  created_at: number;
  rotated_at: number | null;
};

export class SopsIdentityStore {
  private static instance: SopsIdentityStore | null = null;

  static getInstance(): SopsIdentityStore {
    if (!this.instance) this.instance = new SopsIdentityStore();
    return this.instance;
  }

  static resetForTests(): void {
    SopsIdentityStore.instance = null;
  }

  private db() {
    return DatabaseService.getInstance().getDb();
  }

  listPublic(_applicationId: string, stackName: string): PublicSopsIdentity[] {
    const rows = this.db().prepare(
      `SELECT id, recipient, label, created_at, rotated_at
       FROM gitops_sops_identities
       WHERE stack_name = ?
       ORDER BY created_at ASC`,
    ).all(stackName) as Array<Pick<SopsIdentityRow, 'id' | 'recipient' | 'label' | 'created_at' | 'rotated_at'>>;
    return rows.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      label: row.label,
      createdAt: row.created_at,
      rotatedAt: row.rotated_at,
    }));
  }

  getIdentityMap(_applicationId: string, stackName: string): Map<string, string> {
    const rows = this.db().prepare(
      `SELECT recipient, encrypted_identity FROM gitops_sops_identities
       WHERE stack_name = ?`,
    ).all(stackName) as Array<Pick<SopsIdentityRow, 'recipient' | 'encrypted_identity'>>;
    const cryptoSvc = CryptoService.getInstance();
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.recipient, cryptoSvc.decrypt(row.encrypted_identity));
    }
    return map;
  }

  async generateIdentity(args: {
    applicationId: string;
    stackName: string;
    label?: string | null;
  }): Promise<PublicSopsIdentity> {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    return this.insertIdentity({
      applicationId: args.applicationId,
      stackName: args.stackName,
      identity,
      recipient,
      label: args.label ?? null,
    });
  }

  importIdentity(args: {
    applicationId: string;
    stackName: string;
    identity: string;
    label?: string | null;
  }): Promise<PublicSopsIdentity> {
    const trimmed = args.identity.trim();
    if (!trimmed.startsWith('AGE-SECRET-KEY-1')) {
      throw new Error('Invalid age identity format');
    }
    return import('age-encryption').then(async (age) => {
      const recipient = await age.identityToRecipient(trimmed);
      return this.insertIdentity({
        applicationId: args.applicationId,
        stackName: args.stackName,
        identity: trimmed,
        recipient,
        label: args.label ?? null,
      });
    });
  }

  private insertIdentity(args: {
    applicationId: string;
    stackName: string;
    identity: string;
    recipient: string;
    label: string | null;
  }): PublicSopsIdentity {
    const id = crypto.randomUUID();
    const now = Date.now();
    const encrypted = CryptoService.getInstance().encrypt(args.identity);
    this.db().prepare(
      `INSERT INTO gitops_sops_identities (
        id, application_id, stack_name, recipient, encrypted_identity, label, created_at, rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, args.applicationId, args.stackName, args.recipient, encrypted, args.label, now);
    return { id, recipient: args.recipient, label: args.label, createdAt: now, rotatedAt: null };
  }

  /** Rebind identities whose application_id is still the stack-name placeholder. */
  adoptStackScopedIdentities(applicationId: string, stackName: string): void {
    this.db().prepare(
      `UPDATE gitops_sops_identities SET application_id = ?
       WHERE stack_name = ? AND application_id = ?`,
    ).run(applicationId, stackName, stackName);
  }

  deleteIdentity(args: {
    id: string;
    applicationId: string;
    stackName: string;
    acknowledgeDestructive: boolean;
  }): { deleted: boolean; impact: SopsIdentityImpact[] } {
    const row = this.db().prepare(
      `SELECT id, recipient FROM gitops_sops_identities
       WHERE id = ? AND stack_name = ?`,
    ).get(args.id, args.stackName) as { id: string; recipient: string } | undefined;
    if (!row) throw new Error('Identity not found');

    const impact = this.impactForRecipient(args.applicationId, args.stackName, row.recipient);
    if (impact.length > 0 && !args.acknowledgeDestructive) {
      return { deleted: false, impact };
    }
    this.db().prepare('DELETE FROM gitops_sops_identities WHERE id = ?').run(args.id);
    return { deleted: true, impact };
  }

  async rotateIdentity(args: {
    id: string;
    applicationId: string;
    stackName: string;
    label?: string | null;
  }): Promise<{ previous: PublicSopsIdentity; next: PublicSopsIdentity; impact: SopsIdentityImpact[] }> {
    const row = this.db().prepare(
      `SELECT id, recipient FROM gitops_sops_identities
       WHERE id = ? AND stack_name = ?`,
    ).get(args.id, args.stackName) as { id: string; recipient: string } | undefined;
    if (!row) throw new Error('Identity not found');
    const impact = this.impactForRecipient(args.applicationId, args.stackName, row.recipient);
    const now = Date.now();
    this.db().prepare(
      'UPDATE gitops_sops_identities SET rotated_at = ? WHERE id = ?',
    ).run(now, args.id);
    const previous = this.listPublic(args.applicationId, args.stackName).find((i) => i.id === args.id);
    if (!previous) throw new Error('Identity not found after rotate mark');
    const next = await this.generateIdentity({
      applicationId: args.applicationId,
      stackName: args.stackName,
      label: args.label ?? null,
    });
    return { previous: { ...previous, rotatedAt: now }, next, impact };
  }

  impactForRecipient(applicationId: string, stackName: string, recipient: string): SopsIdentityImpact[] {
    const rows = this.db().prepare(
      `SELECT g.id, g.commit_sha, g.secret_capability_json
       FROM gitops_generations g
       JOIN gitops_applications a ON a.id = g.application_id
       WHERE a.stack_name = ? OR g.application_id = ?
       ORDER BY g.created_at DESC`,
    ).all(stackName, applicationId) as Array<{ id: string; commit_sha: string; secret_capability_json: string | null }>;

    const impacts: SopsIdentityImpact[] = [];
    for (const row of rows) {
      const cap = parseSecretCapabilityFromJson(row.secret_capability_json);
      if (!cap) continue;
      if (!cap.requiredRecipients.includes(recipient)) continue;
      impacts.push({
        generationId: row.id,
        commitSha: row.commit_sha,
        status: cap.ready ? 'ready' : (cap.failureClass ?? 'unknown'),
        requiredRecipients: cap.requiredRecipients,
      });
    }
    return impacts;
  }

  computeReadiness(args: {
    applicationId: string;
    stackName: string;
    policy: EncryptedSourcePolicy;
    requiredRecipients: string[];
  }): SopsIdentityReadiness {
    const identities = this.listPublic(args.applicationId, args.stackName);
    const known = new Set(identities.map((i) => i.recipient));
    const missing = args.requiredRecipients.filter((r) => !known.has(r));
    const ready = missing.length === 0;
    return {
      identities,
      requiredRecipients: args.requiredRecipients,
      ready,
      failureClass: missing.length > 0 ? 'missing_key' : undefined,
      policy: args.policy,
    };
  }
}

export function getEncryptedSourcePolicy(stackName: string): EncryptedSourcePolicy {
  const row = DatabaseService.getInstance().getDb().prepare(
    'SELECT encrypted_source_policy FROM stack_git_sources WHERE stack_name = ?',
  ).get(stackName) as { encrypted_source_policy: string | null } | undefined;
  if (row?.encrypted_source_policy === 'require_encrypted') return 'require_encrypted';
  return 'allow_plaintext';
}

export function setEncryptedSourcePolicy(stackName: string, policy: EncryptedSourcePolicy): void {
  DatabaseService.getInstance().getDb().prepare(
    'UPDATE stack_git_sources SET encrypted_source_policy = ?, updated_at = ? WHERE stack_name = ?',
  ).run(policy, Date.now(), stackName);
}
