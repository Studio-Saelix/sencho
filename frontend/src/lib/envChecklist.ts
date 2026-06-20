/**
 * Env inventory types (mirrors the backend payload; the frontend never imports
 * backend) and the "copy env checklist" Markdown builder. The checklist carries
 * variable NAMES, status, and source only. A value is never present in the
 * inventory payload and never written here.
 */

export type EnvSource = 'compose-inline' | 'env-file' | 'dotenv' | 'process-env' | 'compose-ref';
export type EnvItemStatus = 'present' | 'missing' | 'unused' | 'duplicate' | 'unpersisted';
export type EnvFileExistence = 'present' | 'missing' | 'unverifiable';

export interface EnvInventoryItem {
  key: string;
  sources: EnvSource[];
  usedForInterpolation: boolean;
  injectedIntoService: boolean;
  required: boolean;
  hasDefault: boolean;
  likelySecret: boolean;
  status: EnvItemStatus;
}

export interface EnvFileInfo {
  rawPaths: string[];
  existence: EnvFileExistence;
  required: boolean;
  isInterpolationSource: boolean;
  isInjectionSource: boolean;
  declaringServices: string[];
}

export interface EnvInventory {
  stackName: string;
  renderable: boolean;
  items: EnvInventoryItem[];
  envFiles: EnvFileInfo[];
  summary: {
    total: number;
    missing: number;
    unused: number;
    duplicate: number;
    unpersisted: number;
    likelySecret: number;
  };
}

export const SOURCE_LABELS: Record<EnvSource, string> = {
  'compose-inline': 'inline',
  'env-file': 'env_file',
  'dotenv': '.env',
  'process-env': 'shell',
  'compose-ref': 'referenced',
};

export const STATUS_LABELS: Record<EnvItemStatus, string> = {
  present: 'present',
  missing: 'missing',
  unused: 'unused',
  duplicate: 'duplicate',
  unpersisted: 'shell-only',
};

function scopeLabel(item: EnvInventoryItem): string {
  const parts: string[] = [];
  if (item.usedForInterpolation) parts.push('interpolation');
  if (item.injectedIntoService) parts.push('injected');
  return parts.join('+') || 'unused';
}

/**
 * Build a Markdown checklist of the inventory: names, status, source, and scope
 * only. Never includes a value. Actionable statuses are unchecked boxes so the
 * list reads as a to-do.
 */
export function buildEnvChecklistMarkdown(inv: EnvInventory): string {
  const lines: string[] = [];
  lines.push(`# Environment checklist · ${inv.stackName}`);
  lines.push('');
  lines.push('> Variable names, status, and source only. No values are included.');
  if (!inv.renderable) {
    lines.push('>');
    lines.push('> The effective model could not be rendered, so injected-key data is partial.');
  }
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Total: ${inv.summary.total}`);
  lines.push(`- Missing: ${inv.summary.missing}`);
  lines.push(`- Duplicate: ${inv.summary.duplicate}`);
  lines.push(`- Unused: ${inv.summary.unused}`);
  lines.push(`- Shell-only: ${inv.summary.unpersisted}`);
  lines.push(`- Likely secrets: ${inv.summary.likelySecret}`);
  lines.push('');
  lines.push('## Variables');
  if (inv.items.length === 0) {
    lines.push('- None referenced or defined.');
  } else {
    for (const item of inv.items) {
      const done = item.status === 'present';
      const sources = item.sources.map(s => SOURCE_LABELS[s] ?? s).join(', ') || '-';
      const flags = [
        `status: ${STATUS_LABELS[item.status]}`,
        `source: ${sources}`,
        `scope: ${scopeLabel(item)}`,
      ];
      if (item.required) flags.push('required');
      if (item.likelySecret) flags.push('likely secret (value hidden)');
      lines.push(`- [${done ? 'x' : ' '}] ${item.key} · ${flags.join(' · ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
