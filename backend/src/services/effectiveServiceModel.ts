/**
 * Effective Service Model: per-service facts that service-scoped update and
 * restore key off of (declared image, build presence, expected replica
 * count, dependencies, healthcheck presence), derived from the
 * FULLY-MERGED effective model (`docker compose config --format json`)
 * instead of a single compose file, so a multi-file Git source's overrides
 * are always reflected.
 *
 * Fail closed: unlike the read-only facts readers in this module family
 * (effectiveAnatomy, storage inventory, etc.), this model backs mutation and
 * readiness decisions, so a render failure must never fall back to a
 * root-file parse. A caller that mutates or gates on `renderable: false`
 * would risk pulling the wrong image or under/over-recreating replicas
 * against a stale guess.
 *
 * Reads only the structural fields a mutation needs; it never reads
 * `environment`, `command`, `entrypoint`, `labels`, `secrets`, or `configs`.
 */
import { ComposeService } from './ComposeService';
import { parseMissingRequiredVars } from '../helpers/envVarParse';
import { isComposeHealthcheckActive } from '../helpers/healthcheckPresence';
import { getErrorMessage } from '../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';

const MAX_RENDER_ERROR = 600;

export interface EffectiveServiceSpec {
  name: string;
  declaredImage: string | null;
  hasBuild: boolean;
  /** May be 0 (explicit `scale: 0` or `deploy.replicas: 0`); defaults to 1 when neither is set, matching Compose's own default. */
  expectedReplicas: number;
  dependsOn: string[];
  hasHealthcheck: boolean;
}

export type EffectiveServiceModelResult =
  | { renderable: true; services: EffectiveServiceSpec[] }
  | { renderable: false; code: 'effective_model_render_failed'; error: string };

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/**
 * `depends_on` always renders as a map keyed by target service name (Compose
 * normalizes the short list form into the same map shape), so a plain key
 * extraction covers both authoring styles; the list branch is a defensive
 * fallback for a hand-built fixture.
 */
function dependsOnNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((s): s is string => s !== undefined);
  }
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

/**
 * Expected replica count mirrors Compose's own `ServiceConfig.GetScale()`:
 * the top-level `scale` field wins when set (Compose keeps it in sync with
 * `deploy.replicas`), else `deploy.replicas`, else the Compose default of 1.
 */
function expectedReplicasOf(svc: Record<string, unknown>, deploy: Record<string, unknown> | undefined): number {
  return asNumber(svc.scale) ?? asNumber(deploy?.replicas) ?? 1;
}

function parseServiceSpec(name: string, raw: unknown): EffectiveServiceSpec {
  const svc = (raw ?? {}) as Record<string, unknown>;
  const deploy = (svc.deploy && typeof svc.deploy === 'object') ? svc.deploy as Record<string, unknown> : undefined;
  const healthcheck = svc.healthcheck;
  const hasHealthcheck = isComposeHealthcheckActive(healthcheck);
  return {
    name,
    declaredImage: asString(svc.image) ?? null,
    hasBuild: !!svc.build && typeof svc.build === 'object',
    expectedReplicas: expectedReplicasOf(svc, deploy),
    dependsOn: dependsOnNames(svc.depends_on),
    hasHealthcheck,
  };
}

/** Parse the raw `docker compose config --format json` output into the per-service specs. Tolerant of missing/garbage fields: an empty or malformed `services` map yields an empty list rather than throwing. */
function parseEffectiveServices(parsed: unknown): EffectiveServiceSpec[] {
  const root = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  const rawServices = (root.services && typeof root.services === 'object' && !Array.isArray(root.services))
    ? root.services as Record<string, unknown>
    : {};
  return Object.entries(rawServices).map(([name, svc]) => parseServiceSpec(name, svc));
}

/**
 * Render the fully-merged effective Compose model for a stack and extract the
 * per-service specs service-scoped update/restore key off of. Mirrors the
 * render-error handling of the other effective-facts readers (redacted,
 * never raw stderr or an exception), but never falls back to a root-file
 * parse: a render failure leaves `renderable: false` with no services, so a
 * caller that skips the `renderable` check cannot silently mutate against a
 * stale or partial model.
 */
export async function buildEffectiveServiceModel(nodeId: number, stackName: string): Promise<EffectiveServiceModelResult> {
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered !== null) {
      try {
        return { renderable: true, services: parseEffectiveServices(JSON.parse(result.rendered)) };
      } catch (parseErr) {
        // JSON.parse errors carry no file content, so the message is safe to log.
        console.warn('[EffectiveServiceModel] Effective model parse failed for %s:',
          sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(parseErr, 'unknown')));
        return {
          renderable: false,
          code: 'effective_model_render_failed',
          error: 'Sencho could not parse the rendered Compose model.',
        };
      }
    }

    // Raw stderr can echo file content/secrets and is never surfaced; only the
    // names of any missing required variables, otherwise a generic nudge.
    const missing = parseMissingRequiredVars(result.stderr);
    const error = missing.length
      ? `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`
      : 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.';
    return { renderable: false, code: 'effective_model_render_failed', error };
  } catch (err) {
    // Spawn failure (docker unavailable), or an unexpected throw before/inside the
    // render. Leave a sanitized breadcrumb so a non-spawn bug is not invisible, then
    // redact the surfaced message defensively.
    console.warn('[EffectiveServiceModel] Render failed for %s:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'unknown')));
    const error = redactSensitiveText(getErrorMessage(err, 'docker compose could not be started.')).slice(0, MAX_RENDER_ERROR).trim()
      || 'Sencho could not run docker compose on this node.';
    return { renderable: false, code: 'effective_model_render_failed', error };
  }
}
