/**
 * Which compose file in a stack's authored chain supplies each service's
 * `sencho.service.url` label, expressed as an editability state for the file the
 * editor has open (the resolved main compose file).
 *
 * Compose merges label maps per key in file order, last file wins, and a file's
 * own direct label always wins over what its `include` or `extends` contributes.
 * An edit to the file the editor has open therefore changes the effective URL
 * exactly when no file merged after it sets that key. The open file's own
 * constructs (its includes, extends, tags) do not need inspecting: a direct
 * label written into it beats all of them.
 *
 * Establishing the shadowing from the merged render alone is impossible (a
 * shadowed or invalid value is indistinguishable from an absent one), so this
 * module reads the label key presence in each later chain file. Only presence is
 * read; a label value never leaves here. A later file that uses a construct whose
 * label merge cannot be reproduced this way (top-level `include`, `extends` on
 * the service, any non-standard YAML tag), or that cannot be read, could set any
 * service's label, so every service becomes `unknown` and the edit is refused.
 */
import path from 'path';
import { parse, parseDocument, visit } from 'yaml';
import { SERVICE_URL_LABEL } from '../helpers/serviceUrlLabel';

export type ServiceUrlEditState = 'root' | 'other' | 'unknown';

export interface ServiceUrlFileFacts {
  /** Services whose labels contain the URL key in this file, whatever its value. */
  sets: Set<string>;
  /** Services whose label contribution this file cannot establish (`extends`). */
  unknown: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Same refusal as the editor's patch helper: a custom tag hides merge semantics. */
function hasCustomTag(doc: Parameters<typeof visit>[0]): boolean {
  let found = false;
  visit(doc, {
    Node(_key, node) {
      if ('tag' in node && typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:')) {
        found = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return found;
}

function labelsSetUrl(labels: unknown): boolean {
  if (Array.isArray(labels)) {
    const prefix = `${SERVICE_URL_LABEL}=`;
    return labels.some(item => typeof item === 'string' && item.startsWith(prefix));
  }
  const record = asRecord(labels);
  return record !== null && own(record, SERVICE_URL_LABEL) !== undefined;
}

/**
 * The URL-label facts of one compose file's own model, or null when the file's
 * contribution cannot be established at all: unparseable YAML, a top-level
 * `include` (which can inject or override labels invisibly), or any custom tag.
 */
export function serviceUrlFileFacts(source: string): ServiceUrlFileFacts | null {
  let doc: ReturnType<typeof parseDocument>;
  let parsed: unknown;
  try {
    doc = parseDocument(source);
    if (doc.errors.length > 0) return null;
    if (hasCustomTag(doc)) return null;
    // Merges are resolved so `<<:` templates and anchors count as set keys.
    parsed = parse(source, { merge: true });
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root || own(root, 'include') !== undefined) return null;
  const facts: ServiceUrlFileFacts = { sets: new Set(), unknown: new Set() };
  const services = asRecord(own(root, 'services'));
  if (!services) return facts;
  for (const [name, raw] of Object.entries(services)) {
    const service = asRecord(raw);
    if (!service) continue;
    if (own(service, 'extends') !== undefined) {
      facts.unknown.add(name);
      continue;
    }
    if (labelsSetUrl(own(service, 'labels'))) facts.sets.add(name);
  }
  return facts;
}

export interface ServiceUrlEditInput {
  /** True when the editor's open file is one of the files the authored render merges. */
  rootInChain: boolean;
  /**
   * The chain files merged AFTER the open file, in precedence order; only these
   * can keep winning after an edit. Null content means the file was unreadable.
   */
  otherFiles: Array<{ name: string; content: string | null }>;
  services: string[];
}

/**
 * Split an authored chain around the file the editor has open. Files merged
 * before it cannot shadow its label (its direct value wins over them), so only
 * the later ones are returned. Paths are normalized whole, not by basename, so a
 * later file that shares the open file's basename in a subdirectory still counts
 * as a shadower. `rootInChain: false` means the open file is not rendered at all.
 */
export function chainFilesShadowsRoot(chain: string[], rootName: string): { rootInChain: boolean; shadowing: string[] } {
  const normalize = (name: string) => path.normalize(name.replace(/^\.\//, ''));
  const root = normalize(rootName);
  // Anchor at the last occurrence: a chain may list the same file twice (each
  // later instance overrides the earlier one), and only entries after the last
  // occurrence can still shadow the open file.
  let index = -1;
  for (let cursor = chain.length - 1; cursor >= 0; cursor -= 1) {
    if (normalize(chain[cursor]) === root) {
      index = cursor;
      break;
    }
  }
  if (index === -1) return { rootInChain: false, shadowing: [] };
  return { rootInChain: true, shadowing: chain.slice(index + 1) };
}

/**
 * The editability state per service for the file the editor has open. `root`
 * means saving a URL label there changes the effective URL; `other` means a
 * later chain file sets the key and would keep winning; `unknown` means the
 * chain or a file's contribution could not be established, so an edit must be
 * refused rather than written where it cannot take effect.
 */
export function resolveServiceUrlEditState(input: ServiceUrlEditInput): Record<string, ServiceUrlEditState> {
  const states: Record<string, ServiceUrlEditState> = Object.create(null) as Record<string, ServiceUrlEditState>;
  const facts = input.otherFiles.map(file => (file.content === null ? null : serviceUrlFileFacts(file.content)));
  // An unreadable file, an unverifiable construct, or an open file that the
  // render does not merge makes every service unverifiable.
  const globallyUnknown = !input.rootInChain || facts.some(fileFacts => fileFacts === null);
  const unknownServices = new Set<string>();
  const setElsewhere = new Set<string>();
  for (const fileFacts of facts) {
    if (!fileFacts) continue;
    for (const name of fileFacts.unknown) unknownServices.add(name);
    for (const name of fileFacts.sets) setElsewhere.add(name);
  }
  for (const service of new Set([...input.services, ...setElsewhere, ...unknownServices])) {
    states[service] = globallyUnknown || unknownServices.has(service)
      ? 'unknown'
      : setElsewhere.has(service) ? 'other' : 'root';
  }
  return states;
}
