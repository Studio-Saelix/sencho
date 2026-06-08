/**
 * Deterministic Markdown builder for the whole-fleet dossier export.
 *
 * Fans the per-stack Stack Dossier generator across every node and stack in the
 * fleet and adds fleet-level index and network/port/volume maps, producing a
 * folder of Markdown files an operator can commit to Git or store alongside
 * backups. Pure and side-effect free: the same input always yields the same
 * file map.
 *
 * Like the generators it reuses, it only ever receives env variable names and
 * counts, never `.env` values, and the operator-note fields carry no secrets,
 * so nothing sensitive can leak into the export.
 */

import type { AnatomyMarkdownInput } from './anatomyMarkdown';
import { buildStackDossierMarkdown, operatorNotesSection, type StackDossierFields } from './dossierMarkdown';

export interface FleetDossierStack {
  stackName: string;
  /** Generated anatomy, or null when the stack's compose.yaml could not be parsed. */
  anatomy: AnatomyMarkdownInput | null;
  dossier: StackDossierFields;
}

interface FleetDossierNodeBase {
  id: number;
  name: string;
  type: 'local' | 'remote';
}

/**
 * A node in the export: either reachable with its stacks, or skipped with a
 * reason. Modelled as a discriminated union so an unreachable node can never
 * carry stacks and a reachable node always has them.
 */
export type FleetDossierNode =
  | (FleetDossierNodeBase & { reachable: true; stacks: FleetDossierStack[] })
  | (FleetDossierNodeBase & { reachable: false; skipReason: string });

export interface FleetDossierInput {
  /** ISO timestamp the export was generated. */
  generatedAt: string;
  senchoVersion: string;
  nodes: FleetDossierNode[];
}

/** Slugify a node or stack name into a safe, lowercase filename segment. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'unnamed';
}

// Escape a value for a Markdown table cell: backslash first (so it cannot defeat
// the pipe escaping), then pipes, then collapse line breaks onto one line.
function cell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n?|\n/g, ' ');
}

/** Collapse a multi-line operator field to a single line for table display. */
function inline(value: string): string {
  return value.trim().replace(/\s*\r?\n\s*/g, ' · ');
}

/** Assign each node a unique slug, disambiguating collisions with the node id. */
function nodeSlugs(nodes: FleetDossierNode[]): Map<number, string> {
  const used = new Set<string>();
  const map = new Map<number, string>();
  for (const node of nodes) {
    let slug = slugify(node.name);
    if (used.has(slug)) slug = `${slug}-${node.id}`;
    used.add(slug);
    map.set(node.id, slug);
  }
  return map;
}

/**
 * Map each (distinct) stack name on one node to a unique slug, disambiguating
 * collisions with a numeric suffix. Stack names are unique per node, but two
 * names can slugify to the same value (e.g. `Web` and `web` on a case-sensitive
 * host), which would otherwise overwrite a stack's page in the file map.
 */
function stackSlugs(names: string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const name of names) {
    let slug = slugify(name);
    if (used.has(slug)) {
      let i = 2;
      while (used.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }
    used.add(slug);
    map.set(name, slug);
  }
  return map;
}

function stackPageMarkdown(stack: FleetDossierStack): string {
  if (stack.anatomy) {
    return `${buildStackDossierMarkdown(stack.anatomy, stack.dossier)}\n`;
  }
  // Compose could not be parsed: keep the operator's notes rather than dropping
  // the stack from the export entirely.
  const notes = operatorNotesSection(stack.dossier);
  const body = `# ${stack.stackName}\n\n_compose.yaml could not be parsed; showing operator notes only._`;
  return `${notes ? `${body}\n\n${notes}` : body}\n`;
}

function nodePageMarkdown(node: FleetDossierNode, slug: string, slugForStack: Map<string, string>): string {
  const lines = [`# ${node.name}`, ''];
  lines.push(`- **Type:** ${node.type}`);
  lines.push(`- **Status:** ${node.reachable ? 'reachable' : 'unreachable'}`);
  if (!node.reachable) {
    lines.push(`- **Skipped:** ${node.skipReason}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`- **Stacks:** ${node.stacks.length}`);
  lines.push('', '## Stacks');
  if (node.stacks.length === 0) {
    lines.push('_none_');
  } else {
    for (const stack of node.stacks) {
      lines.push(`- [${stack.stackName}](../stacks/${slug}--${slugForStack.get(stack.stackName)}.md)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function indexMarkdown(input: FleetDossierInput, slugs: Map<number, string>): string {
  const lines = ['# Homelab Dossier', '', `_Generated ${input.generatedAt} · Sencho ${input.senchoVersion}_`, ''];

  lines.push('## Nodes', '', '| Node | Type | Status | Stacks |', '| --- | --- | --- | --- |');
  for (const node of input.nodes) {
    const slug = slugs.get(node.id)!;
    const status = node.reachable ? 'reachable' : 'unreachable';
    const count = node.reachable ? String(node.stacks.length) : '-';
    lines.push(`| [${cell(node.name)}](nodes/${slug}.md) | ${node.type} | ${status} | ${count} |`);
  }

  if (input.nodes.some(n => !n.reachable)) {
    lines.push('', '## Skipped nodes', '');
    for (const node of input.nodes) {
      if (node.reachable) continue;
      lines.push(`- **${node.name}** (${node.type}): ${node.skipReason}`);
    }
  }

  lines.push('', '## Network maps', '', '- [Port, volume, and network maps](network.md)');
  return `${lines.join('\n')}\n`;
}

interface StackRef { nodeName: string; stack: FleetDossierStack; }

function reachableStacks(input: FleetDossierInput): StackRef[] {
  const refs: StackRef[] = [];
  for (const node of input.nodes) {
    if (!node.reachable) continue;
    for (const stack of node.stacks) refs.push({ nodeName: node.name, stack });
  }
  return refs;
}

function table(header: string[], rows: string[][]): string {
  if (rows.length === 0) return '_none_';
  const head = `| ${header.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function networkMarkdown(input: FleetDossierInput): string {
  const refs = reachableStacks(input);
  const lines = ['# Network Maps', '', `_Generated ${input.generatedAt} · Sencho ${input.senchoVersion}_`, ''];

  const portRows: string[][] = [];
  const volumeRows: string[][] = [];
  const networkRows: string[][] = [];
  const envRows: string[][] = [];
  const accessRows: string[][] = [];
  const infraRows: string[][] = [];

  for (const { nodeName, stack } of refs) {
    const { anatomy, dossier, stackName } = stack;
    if (anatomy) {
      for (const [svc, list] of Object.entries(anatomy.ports)) {
        for (const p of list) portRows.push([nodeName, stackName, svc, p.host, p.container, p.proto]);
      }
      for (const [svc, list] of Object.entries(anatomy.volumes)) {
        for (const v of list) volumeRows.push([nodeName, stackName, svc, v.host, v.container]);
      }
      networkRows.push([nodeName, stackName, anatomy.networkName]);
      envRows.push([
        nodeName,
        stackName,
        anatomy.envFile ?? 'none',
        String(anatomy.envVarCount),
        anatomy.missingVars.length > 0 ? anatomy.missingVars.join(', ') : 'none',
      ]);
    }
    const accessUrls = inline(dossier.access_urls);
    if (accessUrls) accessRows.push([nodeName, stackName, accessUrls]);
    if (dossier.static_ip.trim() || dossier.vlan.trim() || dossier.firewall_notes.trim()) {
      infraRows.push([
        nodeName,
        stackName,
        dossier.static_ip.trim() || '-',
        dossier.vlan.trim() || '-',
        inline(dossier.firewall_notes) || '-',
      ]);
    }
  }

  lines.push('## Port map', '', table(['Node', 'Stack', 'Service', 'Host', 'Container', 'Protocol'], portRows), '');
  lines.push('## Volume map', '', table(['Node', 'Stack', 'Service', 'Host', 'Container'], volumeRows), '');
  lines.push('## Network map', '', table(['Node', 'Stack', 'Network'], networkRows), '');
  lines.push('## Environment checklist', '', table(['Node', 'Stack', 'Env file', 'Variables', 'Missing'], envRows), '');
  lines.push('## Access URLs', '', table(['Node', 'Stack', 'URLs'], accessRows), '');
  lines.push('## VLAN / static IP / firewall', '', table(['Node', 'Stack', 'Static IP', 'VLAN', 'Firewall'], infraRows));
  return `${lines.join('\n')}\n`;
}

/**
 * Build the full fleet dossier as a map of relative file path to Markdown
 * content, ready to zip. Always emits `index.md` and `network.md`; emits one
 * `nodes/<slug>.md` per node and one `stacks/<node>--<stack>.md` per stack on a
 * reachable node.
 */
export function buildFleetDossier(input: FleetDossierInput): Record<string, string> {
  const slugs = nodeSlugs(input.nodes);
  const files: Record<string, string> = {
    'index.md': indexMarkdown(input, slugs),
    'network.md': networkMarkdown(input),
  };

  for (const node of input.nodes) {
    const slug = slugs.get(node.id)!;
    // One stack-slug map per node, shared by the node-page links and the file
    // emission below so a slug collision never points a link at the wrong page
    // or silently overwrites a stack's file.
    const slugForStack = node.reachable ? stackSlugs(node.stacks.map(s => s.stackName)) : new Map<string, string>();
    files[`nodes/${slug}.md`] = nodePageMarkdown(node, slug, slugForStack);
    if (!node.reachable) continue;
    for (const stack of node.stacks) {
      files[`stacks/${slug}--${slugForStack.get(stack.stackName)}.md`] = stackPageMarkdown(stack);
    }
  }

  return files;
}
