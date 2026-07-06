import type { Node } from '@/context/NodeContext';
import { slugify } from '@/lib/slugify';

/** The local node that owns the reserved `local` slug. */
export function pickReservedLocalNode(nodes: Node[]): Node | null {
  const locals = nodes.filter(n => n.type === 'local');
  if (locals.length === 0) return null;
  const defaultLocal = locals.find(n => n.is_default);
  if (defaultLocal) return defaultLocal;
  return locals.reduce((a, b) => (a.id < b.id ? a : b));
}

/** Bijective node id -> URL slug map. Default local -> `local`; all others -> `<name>-<id>`. */
export function nodeSlugMap(nodes: Node[]): Map<number, string> {
  const reservedLocal = pickReservedLocalNode(nodes);
  const map = new Map<number, string>();
  for (const node of nodes) {
    if (reservedLocal && node.id === reservedLocal.id) {
      map.set(node.id, 'local');
    } else {
      map.set(node.id, `${slugify(node.name)}-${node.id}`);
    }
  }
  return map;
}

export function nodeIdToSlug(nodeId: number, nodes: Node[]): string | null {
  return nodeSlugMap(nodes).get(nodeId) ?? null;
}

/** Resolve a URL slug to a node id. Falls back to trailing `-<id>` for rename drift. */
export function slugToNodeId(slug: string, nodes: Node[]): number | null {
  const normalized = slug.toLowerCase();
  for (const [id, s] of nodeSlugMap(nodes)) {
    if (s === normalized) return id;
  }
  const match = normalized.match(/-(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (Number.isInteger(id) && nodes.some(n => n.id === id)) return id;
  }
  return null;
}
