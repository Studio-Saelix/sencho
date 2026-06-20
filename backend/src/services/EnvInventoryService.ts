/**
 * Per-stack environment inventory: which env vars a stack references, where they
 * come from, whether Compose interpolates them or injects them into a container,
 * and whether each is likely a secret. Names, sources, and status ONLY: an env
 * value is never read, returned, retained, or logged here.
 *
 * Compose env semantics this encodes:
 *  - `${VAR}` interpolation resolves from the project `.env` + the shell only.
 *  - `env_file:` and inline `environment:` inject values into a container.
 *  - `${VAR:?err}` fails when unset OR empty, so the unset/missing signal comes
 *    from Compose's own stderr (authoritative), not a key-only guess.
 *
 * Injected keys come from the merge-correct effective model; interpolation refs
 * and inline-vs-env-file provenance come from the authored source. `process.env`
 * is consulted ONLY to resolve interpolation refs the stack already references, so
 * unrelated host/system env names never appear as inventory rows.
 */

import { ComposeService } from './ComposeService';
import { parseEffectiveModel } from './preflight/effectiveModel';
import { resolveStackEnvSources, type EnvFileExistence } from '../helpers/envFileResolution';
import { parseUnsetEnvVars, parseMissingRequiredVars, readEnvFileKeys } from '../helpers/envVarParse';
import { isLikelySecretKey } from '../helpers/secretClassification';

export type EnvSource = 'compose-inline' | 'env-file' | 'dotenv' | 'process-env' | 'compose-ref';
export type EnvItemStatus = 'present' | 'missing' | 'unused' | 'duplicate' | 'unpersisted';

export interface EnvInventoryItem {
  key: string;
  sources: EnvSource[];
  /** Consumed by Compose `${}` interpolation. */
  usedForInterpolation: boolean;
  /** Injected into a container (effective model is authoritative). */
  injectedIntoService: boolean;
  required: boolean;
  hasDefault: boolean;
  likelySecret: boolean;
  status: EnvItemStatus;
}

export interface EnvFileInfo {
  /** Raw paths as written in compose (or '.env' for the project source). No absolute path. */
  rawPaths: string[];
  existence: EnvFileExistence;
  required: boolean;
  isInterpolationSource: boolean;
  isInjectionSource: boolean;
  declaringServices: string[];
}

export interface EnvInventory {
  stackName: string;
  /** False when the effective model could not be rendered; the inventory is then partial. */
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

/** Build the env inventory for a stack on a node. Key names only; never any value. */
export async function buildEnvInventory(nodeId: number, stackName: string): Promise<EnvInventory> {
  const sources = await resolveStackEnvSources(nodeId, stackName);
  const refByName = new Map(sources.interpolationRefs.map(r => [r.name, r]));

  // Render the effective model: the authoritative injected-key set and the
  // unset/missing-required signal. Failure path materializes no values.
  const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
  const missingRequired = new Set(parseMissingRequiredVars(result.stderr));
  let renderable = false;
  let unsetVars = new Set<string>();
  const effectiveKeys = new Set<string>();
  if (result.rendered !== null) {
    unsetVars = new Set(parseUnsetEnvVars(result.stderr));
    try {
      const model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
      for (const svc of model.services) for (const k of svc.envKeys) effectiveKeys.add(k);
      renderable = true;
    } catch {
      renderable = false;
    }
  }

  const names = new Set<string>();
  const locations = new Map<string, Set<string>>(); // distinct physical definition locations
  const itemSources = new Map<string, Set<EnvSource>>();
  const dotenvKeys = new Set<string>();
  const injectionFileKeys = new Set<string>();

  const addLocation = (key: string, location: string) => {
    const set = locations.get(key) ?? new Set<string>();
    set.add(location);
    locations.set(key, set);
  };
  const addSource = (key: string, source: EnvSource) => {
    const set = itemSources.get(key) ?? new Set<EnvSource>();
    set.add(source);
    itemSources.set(key, set);
  };

  for (const ref of sources.interpolationRefs) names.add(ref.name);

  // Env-file provenance: each physical file contributes ONE source label and ONE
  // location, so the project `.env` doubling as `env_file: .env` is not a duplicate.
  for (const file of sources.envFiles) {
    if (!file.resolvedPath || file.existence !== 'present') continue;
    const { keys, unverifiable } = await readEnvFileKeys(file.resolvedPath, sources.baseDir);
    if (unverifiable) {
      // The existence probe said present, but the key read failed (a permission
      // change, a race, or transient I/O). Surface that rather than silently
      // reporting zero keys for a file the inventory claims is present.
      file.existence = 'unverifiable';
      continue;
    }
    const label: EnvSource = file.isInterpolationSource ? 'dotenv' : 'env-file';
    for (const key of keys) {
      names.add(key);
      addLocation(key, file.resolvedPath);
      addSource(key, label);
      if (file.isInterpolationSource) dotenvKeys.add(key);
      if (file.isInjectionSource) injectionFileKeys.add(key);
    }
  }

  // Inline `environment:` keys, reconciled against the effective model so an
  // override that removed a key is not reported as still injected.
  const inlineAll = new Set<string>();
  for (const keys of Object.values(sources.inlineEnvKeysByService)) for (const k of keys) inlineAll.add(k);
  for (const key of inlineAll) {
    if (renderable && !effectiveKeys.has(key)) continue;
    names.add(key);
    addLocation(key, 'inline');
    addSource(key, 'compose-inline');
  }

  for (const key of effectiveKeys) names.add(key);

  const injectedKeys = renderable
    ? effectiveKeys
    : new Set<string>([...inlineAll, ...injectionFileKeys]);

  const shellHas = (name: string): boolean => Object.prototype.hasOwnProperty.call(process.env, name);

  const items: EnvInventoryItem[] = [];
  for (const key of [...names].sort()) {
    const ref = refByName.get(key);
    const usedForInterpolation = !!ref;
    const required = ref?.required ?? false;
    const hasDefault = ref?.hasDefault ?? false;
    const alternate = ref?.alternate ?? false;
    const injected = injectedKeys.has(key);
    const locationCount = locations.get(key)?.size ?? 0;
    const sourceSet = new Set<EnvSource>(itemSources.get(key) ?? []);

    // A referenced var defined in no stack-local source resolves from the shell or
    // is missing. Surface that provenance without adding unreferenced shell keys.
    if (usedForInterpolation && locationCount === 0 && !injected) {
      if (shellHas(key)) sourceSet.add('process-env');
      else sourceSet.add('compose-ref');
    }

    // Compose's own resolution is authoritative for unset/empty required vars; the
    // heuristic only fills in when the model could not be rendered for other reasons.
    const refUndefinedUnshelled = usedForInterpolation && !hasDefault && !alternate && locationCount === 0 && !shellHas(key);
    const missing = missingRequired.has(key)
      || (renderable && unsetVars.has(key))
      || (!renderable && refUndefinedUnshelled);
    const unpersisted = usedForInterpolation && locationCount === 0 && !missing && shellHas(key);
    const unused = dotenvKeys.has(key) && !usedForInterpolation && !injected;

    let status: EnvItemStatus;
    if (missing) status = 'missing';
    else if (locationCount >= 2) status = 'duplicate';
    else if (unpersisted) status = 'unpersisted';
    else if (unused) status = 'unused';
    else status = 'present';

    items.push({
      key,
      sources: [...sourceSet],
      usedForInterpolation,
      injectedIntoService: injected,
      required,
      hasDefault,
      likelySecret: isLikelySecretKey(key),
      status,
    });
  }

  const envFiles: EnvFileInfo[] = sources.envFiles.map(f => ({
    rawPaths: f.rawPaths,
    existence: f.existence,
    required: f.required,
    isInterpolationSource: f.isInterpolationSource,
    isInjectionSource: f.isInjectionSource,
    declaringServices: f.declaringServices,
  }));

  return {
    stackName,
    renderable,
    items,
    envFiles,
    summary: {
      total: items.length,
      missing: items.filter(i => i.status === 'missing').length,
      unused: items.filter(i => i.status === 'unused').length,
      duplicate: items.filter(i => i.status === 'duplicate').length,
      unpersisted: items.filter(i => i.status === 'unpersisted').length,
      likelySecret: items.filter(i => i.likelySecret).length,
    },
  };
}
