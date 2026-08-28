import { createHash } from 'crypto';
import { encodeGitOpsJson } from './json';
import type { RepoIdentity } from './repoIdentity';

export type MaterialConfigInput = {
  repoIdentity: RepoIdentity;
  configuredRef: string;
  composePaths: readonly string[];
  contextDir: string | null;
  syncEnv: boolean;
  envPath: string | null;
};

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function canonicalMaterialConfigJson(input: MaterialConfigInput): string {
  const contextDir = emptyToNull(input.contextDir);
  const syncEnv = input.syncEnv === true;
  const envPath = syncEnv ? emptyToNull(input.envPath) : null;
  return encodeGitOpsJson({
    composePaths: [...input.composePaths],
    contextDir,
    syncEnv,
    envPath,
    repoIdentity: {
      host: input.repoIdentity.host,
      pathname: input.repoIdentity.pathname,
    },
    configuredRef: input.configuredRef,
  });
}

export function materializationFingerprint(input: MaterialConfigInput): string {
  return createHash('sha256').update(canonicalMaterialConfigJson(input)).digest('hex');
}
