/**
 * Storage portability summary for the Stack Dossier export, derived from the
 * /storage inventory. It carries only mount structure (type, source, target,
 * read-only) and the portability verdict; never a mount's content, so nothing
 * sensitive reaches the exported text. Pure and side-effect free.
 */

export type StoragePortabilityStatus = 'portable' | 'partially-portable' | 'node-bound' | 'unknown';

export interface StorageSummaryMount {
  service: string;
  type: 'bind' | 'named' | 'anonymous' | 'tmpfs';
  source?: string;
  target: string;
  readOnly: boolean;
}

export interface StorageSummary {
  status: StoragePortabilityStatus;
  reasons: string[];
  stateful: boolean;
  mounts: StorageSummaryMount[];
}

// Loose input shape: the builder reads the raw parsed /storage JSON, so it stays
// decoupled from the panel's local interfaces.
interface InventoryMountInput { service?: string; type?: string; source?: string; target?: string; readOnly?: boolean }
export interface StorageInventoryInput {
  renderable?: boolean;
  stateful?: boolean;
  mounts?: InventoryMountInput[];
  portability?: { status?: string; reasons?: string[] };
}

const STATUS_LABEL: Record<StoragePortabilityStatus, string> = {
  'portable': 'Portable',
  'partially-portable': 'Partially portable',
  'node-bound': 'Node-bound',
  'unknown': 'Unknown',
};

const MOUNT_TYPES = new Set(['bind', 'named', 'anonymous', 'tmpfs']);
const STATUSES = new Set<StoragePortabilityStatus>(['portable', 'partially-portable', 'node-bound', 'unknown']);

/** Assemble the summary, or null when there is no mount worth documenting. */
export function buildStorageSummary(inv: StorageInventoryInput | null): StorageSummary | null {
  if (!inv || inv.renderable === false) return null;
  const mounts: StorageSummaryMount[] = (inv.mounts ?? [])
    .filter((m): m is Required<Pick<InventoryMountInput, 'service' | 'type' | 'target'>> & InventoryMountInput =>
      typeof m.service === 'string' && typeof m.target === 'string' && MOUNT_TYPES.has(m.type ?? ''))
    .map(m => ({ service: m.service, type: m.type as StorageSummaryMount['type'], source: m.source, target: m.target, readOnly: m.readOnly === true }));
  if (mounts.length === 0) return null;
  const rawStatus = inv.portability?.status;
  const status: StoragePortabilityStatus = STATUSES.has(rawStatus as StoragePortabilityStatus) ? rawStatus as StoragePortabilityStatus : 'unknown';
  return { status, reasons: inv.portability?.reasons ?? [], stateful: inv.stateful === true, mounts };
}

/** Render the summary as a Markdown section, or null when there is nothing to show. */
export function storageSection(summary: StorageSummary | null): string | null {
  if (!summary) return null;
  const parts = [`## Storage portability`, `- **Status:** ${STATUS_LABEL[summary.status]}`];
  if (summary.reasons.length > 0) parts.push(summary.reasons.map(r => `- ${r}`).join('\n'));
  parts.push('### Mounts', summary.mounts.map(m => {
    const src = m.source ? `${m.source} → ` : '';
    const ro = m.readOnly ? ' (read-only)' : '';
    return `- **${m.service}** · ${m.type}: ${src}${m.target}${ro}`;
  }).join('\n'));
  parts.push('> Snapshots capture Compose and env files, not the data inside named volumes or bind mounts. Back up volume data separately before moving or restoring.');
  return parts.join('\n\n');
}
