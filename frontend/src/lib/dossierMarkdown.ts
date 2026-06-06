/**
 * Deterministic Markdown export for the Stack Dossier.
 *
 * Combines the generated stack anatomy (via the shared anatomy builder) with the
 * operator-authored notes into one document an operator can paste into Git,
 * Obsidian, BookStack, a README, or store alongside backups. Pure and
 * side-effect free: the same input always yields byte-identical output.
 *
 * Like the anatomy builder it reuses, this never receives `.env` values, so no
 * secret can leak into the exported text.
 */

import { buildStackAnatomyMarkdown, type AnatomyMarkdownInput } from './anatomyMarkdown';

/**
 * Operator-authored dossier fields. Mirrors the backend `StackDossierFields`
 * shape (the operator-authored subset of a persisted dossier row); this is the
 * single frontend source of truth shared by the editor form, the API calls, and
 * this Markdown builder.
 */
export interface StackDossierFields {
  purpose: string;
  owner: string;
  access_urls: string;
  static_ip: string;
  vlan: string;
  firewall_notes: string;
  reverse_proxy_notes: string;
  backup_notes: string;
  upgrade_notes: string;
  recovery_notes: string;
  custom_notes: string;
}

export const EMPTY_DOSSIER_FIELDS: StackDossierFields = {
  purpose: '',
  owner: '',
  access_urls: '',
  static_ip: '',
  vlan: '',
  firewall_notes: '',
  reverse_proxy_notes: '',
  backup_notes: '',
  upgrade_notes: '',
  recovery_notes: '',
  custom_notes: '',
};

// Single-line facts render as bullets; their values get any stray line breaks
// collapsed so a bullet can never spill into a broken list.
const SHORT_FIELDS: Array<[keyof StackDossierFields, string]> = [
  ['purpose', 'Purpose'],
  ['owner', 'Owner'],
  ['static_ip', 'Static IP'],
  ['vlan', 'VLAN'],
];

// Multi-line fields render as their own heading + body block, preserving the
// operator's line structure (e.g. one access URL per line).
const BLOCK_FIELDS: Array<[keyof StackDossierFields, string]> = [
  ['access_urls', 'Access URLs'],
  ['firewall_notes', 'Firewall'],
  ['reverse_proxy_notes', 'Reverse proxy'],
  ['backup_notes', 'Backup'],
  ['upgrade_notes', 'Upgrade'],
  ['recovery_notes', 'Recovery'],
  ['custom_notes', 'Notes'],
];

function operatorNotesSection(d: StackDossierFields): string | null {
  const bullets = SHORT_FIELDS
    .filter(([k]) => d[k].trim() !== '')
    .map(([k, label]) => `- **${label}:** ${d[k].trim().replace(/\s*\r?\n\s*/g, ' ')}`);
  const blocks = BLOCK_FIELDS
    .filter(([k]) => d[k].trim() !== '')
    .map(([k, label]) => `### ${label}\n${d[k].trim()}`);
  if (bullets.length === 0 && blocks.length === 0) return null;
  const parts = ['## Operator notes'];
  if (bullets.length > 0) parts.push(bullets.join('\n'));
  parts.push(...blocks);
  return parts.join('\n\n');
}

export function buildStackDossierMarkdown(
  anatomy: AnatomyMarkdownInput,
  dossier: StackDossierFields,
): string {
  const anatomyMarkdown = buildStackAnatomyMarkdown(anatomy);
  const notes = operatorNotesSection(dossier);
  return notes ? `${anatomyMarkdown}\n\n${notes}` : anatomyMarkdown;
}
