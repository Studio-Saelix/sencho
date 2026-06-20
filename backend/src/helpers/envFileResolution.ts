/**
 * Authored-compose env analysis for a stack: the env_file declarations (with
 * existence metadata), the project `.env` interpolation source, the inline
 * `environment:` KEY names per service, and the `${}` interpolation references.
 *
 * This is the single reader of the authored compose file set, so the multi-file
 * Git case is handled once and every consumer (the route's env-file wrapper that
 * Fleet Secrets calls, the Compose Doctor preflight, and the env inventory) sees
 * the same env_file set. It surfaces NAMES and structural
 * facts only: an env-file value is never read here, and inline environment values
 * are dropped immediately after their key names are taken.
 */

import path from 'path';
import YAML from 'yaml';
import { FileSystemService } from '../services/FileSystemService';
import { DatabaseService } from '../services/DatabaseService';
import { isPathWithinBase, isValidRelativeStackPath } from '../utils/validation';
import { parseInterpolationRefs, type InterpolationRef } from './envVarParse';

const MAX_COMPOSE_PARSE_BYTES = 1_048_576; // 1 MiB, matches the routes/stacks.ts bound
const ROOT_COMPOSE_CANDIDATES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

export type EnvFileExistence = 'present' | 'missing' | 'unverifiable';

/**
 * One physical env file, deduped by resolved absolute path. The project `.env`
 * doubling as an `env_file: .env` entry is ONE physical file carrying both roles,
 * so it is never double-counted as a duplicate definition.
 */
export interface PhysicalEnvFile {
  /** Absolute path, or null when the raw path is interpolated or escapes the stack dir. */
  resolvedPath: string | null;
  /** Raw paths as written (or '.env' for the implicit project source). */
  rawPaths: string[];
  existence: EnvFileExistence;
  /** A missing file matters only when at least one declaration required it. */
  required: boolean;
  /** True when this is the project `.env` Compose reads for `${}` interpolation. */
  isInterpolationSource: boolean;
  /** True when a service `env_file:` injects this file into a container. */
  isInjectionSource: boolean;
  /** Services that declared this file via `env_file:`. */
  declaringServices: string[];
}

export interface StackEnvSources {
  stackDir: string;
  baseDir: string;
  /** Absolute authored compose files actually read (multi-file Git aware). */
  composeFiles: string[];
  /** Project `.env` + every declared env_file, deduped by resolved path. */
  envFiles: PhysicalEnvFile[];
  /** Authored `environment:` KEY names per service (union across authored files). */
  inlineEnvKeysByService: Record<string, string[]>;
  /** `${}` references found across the authored compose source. */
  interpolationRefs: InterpolationRef[];
}

interface EnvFileEntry {
  rawPath: string;
  required: boolean;
}

/** Normalize a service `env_file:` field (string, array of strings, or long-form objects). */
function normalizeEnvFileField(envFile: unknown): EnvFileEntry[] {
  if (typeof envFile === 'string') return [{ rawPath: envFile, required: true }];
  if (!Array.isArray(envFile)) return [];
  const out: EnvFileEntry[] = [];
  for (const entry of envFile) {
    if (typeof entry === 'string') {
      out.push({ rawPath: entry, required: true });
    } else if (entry && typeof entry === 'object') {
      const p = (entry as Record<string, unknown>).path;
      if (typeof p === 'string') {
        out.push({ rawPath: p, required: (entry as Record<string, unknown>).required !== false });
      }
    }
  }
  return out;
}

/** Inline `environment:` KEY names (object / `KEY=value` array / bare `KEY`), never values. */
function inlineEnvKeysOf(environment: unknown): string[] {
  if (Array.isArray(environment)) {
    return environment
      .filter((e): e is string => typeof e === 'string')
      .map(e => e.split('=')[0].trim())
      .filter(Boolean);
  }
  if (environment && typeof environment === 'object') {
    return Object.keys(environment as Record<string, unknown>);
  }
  return [];
}

async function existenceOf(fsService: FileSystemService, abs: string, baseDir: string): Promise<EnvFileExistence> {
  if (!isPathWithinBase(abs, baseDir)) return 'unverifiable';
  try {
    await fsService.access(abs);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unverifiable';
  }
}

/** The authored compose files Compose would read: the applied Git deploy spec, else the root file. */
async function discoverAuthoredComposeFiles(
  fsService: FileSystemService,
  stackName: string,
  stackDir: string,
): Promise<string[]> {
  const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
  if (spec && Array.isArray(spec.files) && spec.files.length > 0) {
    const files: string[] = [];
    for (const f of spec.files) {
      if (typeof f !== 'string' || !isValidRelativeStackPath(f)) continue;
      const abs = path.resolve(stackDir, f);
      if (isPathWithinBase(abs, stackDir)) files.push(abs);
    }
    if (files.length > 0) return files;
  }
  for (const name of ROOT_COMPOSE_CANDIDATES) {
    const abs = path.resolve(stackDir, name);
    try {
      await fsService.access(abs);
      return [abs];
    } catch {
      // try next candidate
    }
  }
  return [];
}

async function parseComposeServices(fsService: FileSystemService, absPath: string): Promise<{
  services: Record<string, unknown>;
  text: string;
} | null> {
  let content: string;
  try {
    content = await fsService.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
  if (content.length > MAX_COMPOSE_PARSE_BYTES) return null;
  try {
    const parsed = YAML.parse(content) as Record<string, unknown> | null;
    const services = (parsed?.services && typeof parsed.services === 'object')
      ? parsed.services as Record<string, unknown>
      : {};
    return { services, text: content };
  } catch {
    return { services: {}, text: content };
  }
}

/**
 * Resolve every authored env source for a stack. Reads each authored compose file
 * once and returns env_file existence, inline key names, and interpolation refs.
 */
export async function resolveStackEnvSources(nodeId: number, stackName: string): Promise<StackEnvSources> {
  const fsService = FileSystemService.getInstance(nodeId);
  const baseDir = fsService.getBaseDir();
  const stackDir = path.join(baseDir, stackName);

  const composeFiles = await discoverAuthoredComposeFiles(fsService, stackName, stackDir);

  // Physical env files, deduped by resolved absolute path. Seed with the project
  // `.env`: always the interpolation source, regardless of any env_file entry.
  const byPath = new Map<string, PhysicalEnvFile>();
  const dotenvPath = path.resolve(stackDir, '.env');
  const dotenv: PhysicalEnvFile = {
    resolvedPath: dotenvPath,
    rawPaths: ['.env'],
    existence: await existenceOf(fsService, dotenvPath, baseDir),
    required: false,
    isInterpolationSource: true,
    isInjectionSource: false,
    declaringServices: [],
  };
  byPath.set(dotenvPath, dotenv);

  const unresolved: PhysicalEnvFile[] = [];
  const inlineEnvKeysByService: Record<string, string[]> = {};
  let authoredText = '';

  for (const file of composeFiles) {
    const parsed = await parseComposeServices(fsService, file);
    if (!parsed) continue;
    authoredText += parsed.text + '\n';

    for (const [serviceName, svcRaw] of Object.entries(parsed.services)) {
      const svc = (svcRaw ?? {}) as Record<string, unknown>;

      const inlineKeys = inlineEnvKeysOf(svc.environment);
      if (inlineKeys.length > 0) {
        const existing = inlineEnvKeysByService[serviceName] ?? [];
        inlineEnvKeysByService[serviceName] = [...new Set([...existing, ...inlineKeys])];
      }

      for (const entry of normalizeEnvFileField(svc.env_file)) {
        const interpolated = entry.rawPath.includes('${');
        // Resolve relative to the directory of the compose file that declared it,
        // so an env_file in a nested multi-file override (e.g. infra/prod.yml ->
        // ./prod.env) lands next to that file, not at the stack root. For the root
        // compose file this dir is the stack dir, so the common case is unchanged.
        const abs = interpolated ? null : path.resolve(path.dirname(file), entry.rawPath);
        const within = abs !== null && isPathWithinBase(abs, stackDir);
        const resolvedPath = within ? abs : null;

        if (resolvedPath) {
          const existing = byPath.get(resolvedPath);
          if (existing) {
            existing.isInjectionSource = true;
            existing.required ||= entry.required;
            if (!existing.rawPaths.includes(entry.rawPath)) existing.rawPaths.push(entry.rawPath);
            if (!existing.declaringServices.includes(serviceName)) existing.declaringServices.push(serviceName);
          } else {
            byPath.set(resolvedPath, {
              resolvedPath,
              rawPaths: [entry.rawPath],
              existence: await existenceOf(fsService, resolvedPath, baseDir),
              required: entry.required,
              isInterpolationSource: false,
              isInjectionSource: true,
              declaringServices: [serviceName],
            });
          }
        } else {
          // Interpolated or escaping path: unverifiable, kept so the inventory can show it.
          unresolved.push({
            resolvedPath: null,
            rawPaths: [entry.rawPath],
            existence: 'unverifiable',
            required: entry.required,
            isInterpolationSource: false,
            isInjectionSource: true,
            declaringServices: [serviceName],
          });
        }
      }
    }
  }

  return {
    stackDir,
    baseDir,
    composeFiles,
    envFiles: [...byPath.values(), ...unresolved],
    inlineEnvKeysByService,
    interpolationRefs: parseInterpolationRefs(authoredText),
  };
}
