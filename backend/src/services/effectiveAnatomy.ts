/**
 * Effective Stack Anatomy: the structural facts a stack's Dossier and doc-drift
 * read, derived from the FULLY-MERGED effective model (`docker compose config
 * --format json`) instead of a single compose file. For a multi-file Git source,
 * a service, port, network, or volume that only an override file adds is invisible
 * to a root-only parse, so the dossier and its doc-drift would show misleading
 * facts. Rendering the merged model and extracting the same anatomy shape keeps
 * those signals honest.
 *
 * Reads structural fields (service keys, ports, volumes, restart, network keys)
 * plus one allowlisted label, `sencho.service.url`, and only when that value is
 * an http(s) URL with no userinfo. It never reads `environment`, `command`,
 * `entrypoint`, other label values, `secrets`, or `configs`, so a secret
 * INJECTED through those fields can never reach this payload. The exception is
 * a secret interpolated INTO a structural field or into the allowlisted label
 * (a bind path, network name, published port, or URL built from a `${VAR}`):
 * `docker compose config` resolves it before this parse, leaving no provenance
 * to distinguish it, so the resolved value is returned. That value is already
 * readable at the same `stack:read` scope via the stack's files, so this is a
 * documented caveat (see docs/features/environment-guardrails), not a new
 * exposure.
 */
import { ComposeService } from './ComposeService';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { parseMissingRequiredVars } from '../helpers/envVarParse';
import { composeFileEnvVarSelectsLayers } from '../utils/authoredComposeArgs';
import { getErrorMessage } from '../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';
import { SERVICE_URL_LABEL, serviceUrlFromLabels } from '../helpers/serviceUrlLabel';
import { resolveServiceUrlEditState, resolveServiceUrlClearState, chainFilesAroundRoot, type ServiceUrlEditState } from './serviceUrlSource';

const MAX_RENDER_ERROR = 600;
const MAX_CHAIN_FILE_BYTES = 2 * 1024 * 1024;

/** Service-keyed maps use a null prototype so a service named `constructor` cannot read an inherited value. */
function serviceMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export interface EffectiveAnatomyPort {
  host: string;
  container: string;
  proto: string;
  published: boolean;
}

export interface EffectiveAnatomyVolume {
  host: string;
  container: string;
}

export interface EffectiveAnatomy {
  services: string[];
  ports: Record<string, EffectiveAnatomyPort[]>;
  volumes: Record<string, EffectiveAnatomyVolume[]>;
  restart: string | null;
  networks: string[];
  /** Validated `sencho.service.url` values, keyed by service. Omitted services have none. */
  serviceUrls: Record<string, string>;
}

export interface EffectiveAnatomyResult extends EffectiveAnatomy {
  /** True when the merged model rendered; false leaves every fact list empty. */
  renderable: boolean;
  /** A redacted, secret-safe reason when the render failed, else null. */
  renderError: string | null;
  /**
   * Per-service editability of the URL label from the resolved main compose
   * file, so the editor can refuse a write another chain file would shadow.
   */
  serviceUrlEdit: Record<string, ServiceUrlEditState>;
  /**
   * Per-service clearing authority of the URL label from the resolved main
   * compose file. `root` means removing the label there makes the effective URL
   * disappear; `other` or `unknown` mean another file or an inheritance
   * construct can supply it, so a clear is refused.
   */
  serviceUrlClear: Record<string, ServiceUrlEditState>;
}

/** Fresh empty anatomy, with fresh maps, so a returned result never shares state. */
function emptyAnatomy(): EffectiveAnatomy {
  return { services: [], ports: serviceMap(), volumes: serviceMap(), restart: null, networks: [], serviceUrls: serviceMap() };
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Parse one rendered `ports:` entry (long object form, with a short-string fallback). */
function parsePort(entry: unknown): EffectiveAnatomyPort | null {
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const host = asString(o.published) ?? '';
    const container = asString(o.target) ?? '';
    const proto = asString(o.protocol) ?? 'tcp';
    if (host === '' && container === '') return null;
    return { host, container, proto, published: host !== '' };
  }
  const s = asString(entry);
  if (s === undefined) return null;
  const protoMatch = s.match(/\/(tcp|udp)$/i);
  const proto = protoMatch ? protoMatch[1].toLowerCase() : 'tcp';
  const body = s.replace(/\/(tcp|udp)$/i, '');
  const parts = body.split(':');
  if (parts.length === 2) return { host: parts[0], container: parts[1], proto, published: true };
  if (parts.length === 3) return { host: parts[1], container: parts[2], proto, published: true };
  return { host: '', container: body, proto, published: false };
}

/** Parse one rendered `volumes:` entry (long object form, with a short-string fallback). */
function parseVolume(entry: unknown): EffectiveAnatomyVolume | null {
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const host = asString(o.source);
    const container = asString(o.target);
    if (host && container) return { host, container };
    return null;
  }
  const s = asString(entry);
  if (s === undefined) return null;
  const parts = s.split(':');
  if (parts.length >= 2) return { host: parts[0], container: parts[1] };
  return null;
}

function networkKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((s): s is string => s !== undefined);
  }
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

/** Compose writes a literal `$` as `$$` in rendered config. Undo that once. */
function unescapeRenderedServiceUrl(labels: unknown): unknown {
  const unescape = (value: string) => value.replaceAll('$$', '$');
  if (Array.isArray(labels)) {
    return labels.map(entry => {
      if (typeof entry !== 'string') return entry;
      const eq = entry.indexOf('=');
      if (eq <= 0 || entry.slice(0, eq) !== SERVICE_URL_LABEL) return entry;
      return `${SERVICE_URL_LABEL}=${unescape(entry.slice(eq + 1))}`;
    });
  }
  if (labels && typeof labels === 'object') {
    const copy: Record<string, unknown> = { ...(labels as Record<string, unknown>) };
    const raw = copy[SERVICE_URL_LABEL];
    if (typeof raw === 'string') copy[SERVICE_URL_LABEL] = unescape(raw);
    return copy;
  }
  return labels;
}

/**
 * Map parsed `docker compose config --format json` to the {@link EffectiveAnatomy}
 * shape. Tolerant of missing fields; empty / garbage input yields an empty model
 * rather than throwing. Mirrors the frontend `parseAnatomy` field handling so the
 * dossier reads the same facts whether they came from a single file or the merge.
 */
export function parseEffectiveAnatomy(parsed: unknown): EffectiveAnatomy {
  if (!parsed || typeof parsed !== 'object') return emptyAnatomy();
  const root = parsed as Record<string, unknown>;
  const servicesObj = (root.services && typeof root.services === 'object' && !Array.isArray(root.services))
    ? root.services as Record<string, unknown>
    : {};
  const serviceNames = Object.keys(servicesObj);

  const ports: Record<string, EffectiveAnatomyPort[]> = serviceMap();
  const volumes: Record<string, EffectiveAnatomyVolume[]> = serviceMap();
  let restart: string | null = null;
  const networks = new Set<string>();
  const serviceUrls: Record<string, string> = serviceMap();

  for (const name of serviceNames) {
    const svc = servicesObj[name];
    if (!svc || typeof svc !== 'object') continue;
    const o = svc as Record<string, unknown>;

    const p = Array.isArray(o.ports)
      ? o.ports.map(parsePort).filter((r): r is EffectiveAnatomyPort => r !== null)
      : [];
    const v = Array.isArray(o.volumes)
      ? o.volumes.map(parseVolume).filter((r): r is EffectiveAnatomyVolume => r !== null)
      : [];
    if (p.length) ports[name] = p;
    if (v.length) volumes[name] = v;
    if (restart === null && typeof o.restart === 'string') restart = o.restart;
    for (const n of networkKeys(o.networks)) networks.add(n);
    const serviceUrl = serviceUrlFromLabels(unescapeRenderedServiceUrl(o.labels));
    if (serviceUrl) serviceUrls[name] = serviceUrl;
  }

  if (root.networks && typeof root.networks === 'object' && !Array.isArray(root.networks)) {
    for (const n of Object.keys(root.networks as Record<string, unknown>)) networks.add(n);
  }

  return { services: serviceNames, ports, volumes, restart, networks: Array.from(networks), serviceUrls };
}

/** One other chain file's label contribution; null content means it could not be read. */
async function readChainFile(nodeId: number, stackName: string, name: string): Promise<string | null> {
  try {
    const file = await FileSystemService.getInstance(nodeId).readStackFile(stackName, name, MAX_CHAIN_FILE_BYTES);
    if (file.binary || file.oversized || typeof file.content !== 'string') return null;
    return file.content;
  } catch (error) {
    console.warn('[EffectiveAnatomy] Could not read compose file %s for stack %s:',
      sanitizeForLog(name), sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
    return null;
  }
}

/**
 * The files merged before and after the resolved main file, the main file's own
 * source, and whether the main file is part of the authored chain at all. Null
 * when the chain itself cannot be established.
 */
async function editabilityInput(nodeId: number, stackName: string): Promise<{
  rootInChain: boolean;
  rootContent: string | null;
  earlierFiles: Array<{ name: string; content: string | null }>;
  otherFiles: Array<{ name: string; content: string | null }>;
} | null> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const rootName = await fsSvc.getComposeFilename(stackName);
  const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
  let chain: string[];
  if (spec && spec.files.length > 0) {
    chain = [...spec.files];
  } else {
    // COMPOSE_FILE replaces Compose's own file discovery, so the explicit chain
    // (resolved main file plus the auto-discovered override) can no longer be
    // trusted. Sencho does not manage that variable anywhere, so a stack that
    // sets it is reported unverifiable instead of guessing. Explicit `-f` args
    // (multi-file Git stacks) ignore COMPOSE_FILE, so this only runs for a
    // discovered chain.
    if (await composeFileEnvVarSelectsLayers(stackName, nodeId)) return null;
    const override = await fsSvc.getOverrideFilename(stackName);
    chain = override ? [rootName, override] : [rootName];
  }
  // Only files merged after the open file can shadow a set; earlier files lose
  // to its direct label but can surface again after a clear. This also keeps a
  // later same-named file in a subdirectory from being mistaken for the open
  // file itself, and drops an earlier occurrence of the same authored file.
  const { rootInChain, earlier, shadowing } = chainFilesAroundRoot(chain, rootName);
  if (!rootInChain) return { rootInChain: false, rootContent: null, earlierFiles: [], otherFiles: [] };
  const earlierFiles: Array<{ name: string; content: string | null }> = [];
  for (const name of earlier) {
    earlierFiles.push({ name, content: await readChainFile(nodeId, stackName, name) });
  }
  const otherFiles: Array<{ name: string; content: string | null }> = [];
  for (const name of shadowing) {
    otherFiles.push({ name, content: await readChainFile(nodeId, stackName, name) });
  }
  return {
    rootInChain: true,
    rootContent: await readChainFile(nodeId, stackName, rootName),
    earlierFiles,
    otherFiles,
  };
}

/** Both URL-label authorities for every rendered service; all `unknown` when the chain cannot be established. */
async function buildServiceUrlAuthority(
  nodeId: number,
  stackName: string,
  services: string[],
): Promise<{ serviceUrlEdit: Record<string, ServiceUrlEditState>; serviceUrlClear: Record<string, ServiceUrlEditState> }> {
  const unknownForAll = (): Record<string, ServiceUrlEditState> => {
    const states: Record<string, ServiceUrlEditState> = serviceMap();
    for (const name of services) states[name] = 'unknown';
    return states;
  };
  const unknown = { serviceUrlEdit: unknownForAll(), serviceUrlClear: unknownForAll() };
  try {
    const input = await editabilityInput(nodeId, stackName);
    if (!input) return unknown;
    return {
      serviceUrlEdit: resolveServiceUrlEditState({
        rootInChain: input.rootInChain,
        rootContent: input.rootContent,
        otherFiles: input.otherFiles,
        services,
      }),
      serviceUrlClear: resolveServiceUrlClearState({ ...input, services }),
    };
  } catch (error) {
    console.warn('[EffectiveAnatomy] Could not establish service URL sources for %s:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
    return unknown;
  }
}

/**
 * Render the merged effective model for a stack and extract its anatomy facts.
 * Mirrors the Network Inspector's render-error handling: a missing required
 * variable, an unparseable model, or an unavailable docker binary becomes a
 * redacted `renderError` with empty facts, never raw stderr or an exception, so
 * the dossier can fall back to its root-only view.
 */
export async function buildEffectiveAnatomy(nodeId: number, stackName: string): Promise<EffectiveAnatomyResult> {
  // docker compose follows a compose file, and the override it discovers, when
  // either links at a sibling stack. Reading or saving refuses the compose
  // file. This render refuses that file and the discovered override, or the
  // response would include the sibling's ports and service URL.
  await FileSystemService.getInstance(nodeId).assertComposeFileWithinStack(stackName);
  let renderError: string;
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered !== null) {
      try {
        const anatomy = parseEffectiveAnatomy(JSON.parse(result.rendered));
        return {
          renderable: true,
          renderError: null,
          ...anatomy,
          ...await buildServiceUrlAuthority(nodeId, stackName, anatomy.services),
        };
      } catch (parseErr) {
        // JSON.parse errors carry no file content, so the message is safe to log.
        console.warn('[EffectiveAnatomy] Effective model parse failed for %s:',
          sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(parseErr, 'unknown')));
        renderError = 'Sencho could not parse the rendered Compose model.';
      }
    } else {
      // Raw stderr can echo file content/secrets and is never surfaced; only the
      // names of any missing required variables, otherwise a generic nudge.
      const missing = parseMissingRequiredVars(result.stderr);
      renderError = missing.length
        ? `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`
        : 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.';
    }
  } catch (err) {
    // Spawn failure (docker unavailable), or an unexpected throw before/inside the
    // render. Leave a sanitized breadcrumb so a non-spawn bug is not invisible, then
    // redact the surfaced message defensively.
    console.warn('[EffectiveAnatomy] Render failed for %s:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'unknown')));
    renderError = redactSensitiveText(getErrorMessage(err, 'docker compose could not be started.')).slice(0, MAX_RENDER_ERROR).trim()
      || 'Sencho could not run docker compose on this node.';
  }
  return {
    renderable: false,
    renderError,
    ...emptyAnatomy(),
    serviceUrlEdit: serviceMap(),
    serviceUrlClear: serviceMap(),
  };
}
