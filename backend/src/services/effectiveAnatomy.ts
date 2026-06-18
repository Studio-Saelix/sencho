/**
 * Effective Stack Anatomy: the structural facts a stack's Dossier and doc-drift
 * read, derived from the FULLY-MERGED effective model (`docker compose config
 * --format json`) instead of a single compose file. For a multi-file Git source,
 * a service, port, network, or volume that only an override file adds is invisible
 * to a root-only parse, so the dossier and its doc-drift would show misleading
 * facts. Rendering the merged model and extracting the same anatomy shape keeps
 * those signals honest.
 *
 * Secret-safe by construction: the extractor reads only structural fields
 * (service keys, ports, volumes, restart, network keys). It never reads
 * `environment`, `command`, `entrypoint`, `labels`, `secrets`, or `configs`, so a
 * resolved secret VALUE in the rendered model can never reach this payload.
 */
import { ComposeService } from './ComposeService';
import { parseMissingRequiredVars } from './ComposeDoctorService';
import { getErrorMessage } from '../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';

const MAX_RENDER_ERROR = 600;

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
}

export interface EffectiveAnatomyResult extends EffectiveAnatomy {
  /** True when the merged model rendered; false leaves every fact list empty. */
  renderable: boolean;
  /** A redacted, secret-safe reason when the render failed, else null. */
  renderError: string | null;
}

const EMPTY: EffectiveAnatomy = { services: [], ports: {}, volumes: {}, restart: null, networks: [] };

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

/**
 * Map parsed `docker compose config --format json` to the {@link EffectiveAnatomy}
 * shape. Tolerant of missing fields; empty / garbage input yields an empty model
 * rather than throwing. Mirrors the frontend `parseAnatomy` field handling so the
 * dossier reads the same facts whether they came from a single file or the merge.
 */
export function parseEffectiveAnatomy(parsed: unknown): EffectiveAnatomy {
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
  const root = parsed as Record<string, unknown>;
  const servicesObj = (root.services && typeof root.services === 'object' && !Array.isArray(root.services))
    ? root.services as Record<string, unknown>
    : {};
  const serviceNames = Object.keys(servicesObj);

  const ports: Record<string, EffectiveAnatomyPort[]> = {};
  const volumes: Record<string, EffectiveAnatomyVolume[]> = {};
  let restart: string | null = null;
  const networks = new Set<string>();

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
  }

  if (root.networks && typeof root.networks === 'object' && !Array.isArray(root.networks)) {
    for (const n of Object.keys(root.networks as Record<string, unknown>)) networks.add(n);
  }

  return { services: serviceNames, ports, volumes, restart, networks: Array.from(networks) };
}

/**
 * Render the merged effective model for a stack and extract its anatomy facts.
 * Mirrors the Network Inspector's render-error handling: a missing required
 * variable, an unparseable model, or an unavailable docker binary becomes a
 * redacted `renderError` with empty facts, never raw stderr or an exception, so
 * the dossier can fall back to its root-only view.
 */
export async function buildEffectiveAnatomy(nodeId: number, stackName: string): Promise<EffectiveAnatomyResult> {
  let renderError: string;
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered !== null) {
      try {
        return { renderable: true, renderError: null, ...parseEffectiveAnatomy(JSON.parse(result.rendered)) };
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
  return { renderable: false, renderError, ...EMPTY };
}
