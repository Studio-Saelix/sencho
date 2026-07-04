/**
 * Classify Compose stderr "unset variable" names into intentional references vs
 * spurious fragments from literal `$` sequences inside env values (e.g. bcrypt
 * hashes). Names only; env values are never read or returned.
 */

import type { StackEnvSources } from './envFileResolution';
import { parseIntentionalBareDollarRefs } from './envVarParse';
import { isLikelySecretKey } from './secretClassification';

export interface LiteralDollarWarning {
  envKey?: string;
  likelySecret: boolean;
  service?: string;
}

export interface UnsetEnvClassification {
  intentional: string[];
  literalDollar: LiteralDollarWarning[];
}

function intentionalRefNames(envSources: StackEnvSources): Set<string> {
  const names = new Set<string>();
  for (const ref of envSources.interpolationRefs) names.add(ref.name);
  for (const name of parseIntentionalBareDollarRefs(envSources.authoredComposeText)) names.add(name);
  return names;
}

/** Parse an inline `environment:` key from a compose source line (names only). */
function extractEnvKeyFromComposeLine(line: string): string | null {
  const trimmed = line.trim();
  const listMatch = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/);
  if (listMatch) return listMatch[1];
  const mapMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
  if (mapMatch) return mapMatch[1];
  const eqMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (eqMatch) return eqMatch[1];
  return null;
}

function findServiceForEnvKey(
  inlineEnvKeysByService: Record<string, string[]>,
  envKey: string,
): string | undefined {
  for (const [service, keys] of Object.entries(inlineEnvKeysByService)) {
    if (keys.includes(envKey)) return service;
  }
  return undefined;
}

function attributeFragmentToEnvKey(authoredText: string, fragment: string): string | null {
  const needle = `$${fragment}`;
  for (const line of authoredText.split(/\r?\n/)) {
    if (!line.includes(needle)) continue;
    const key = extractEnvKeyFromComposeLine(line);
    if (key) return key;
  }
  return null;
}

/**
 * Split stderr unset names into intentional Compose variable references and
 * literal-dollar warnings safe to show in Doctor (no hash/secret fragments).
 */
export function classifyUnsetEnvVars(
  unsetNames: string[],
  envSources: StackEnvSources,
  envFileKeys: string[] = [],
): UnsetEnvClassification {
  const intentionalSet = intentionalRefNames(envSources);
  const intentional: string[] = [];
  const spurious: string[] = [];
  for (const name of unsetNames) {
    if (intentionalSet.has(name)) intentional.push(name);
    else spurious.push(name);
  }

  if (spurious.length === 0) {
    return { intentional, literalDollar: [] };
  }

  const warnings = new Map<string, LiteralDollarWarning>();

  const addWarning = (w: LiteralDollarWarning) => {
    const id = w.envKey ?? (w.likelySecret ? '__secret__' : '__generic__');
    if (!warnings.has(id)) warnings.set(id, w);
  };

  for (const fragment of spurious) {
    const envKey = attributeFragmentToEnvKey(envSources.authoredComposeText, fragment);
    if (envKey) {
      addWarning({
        envKey,
        likelySecret: isLikelySecretKey(envKey),
        service: findServiceForEnvKey(envSources.inlineEnvKeysByService, envKey),
      });
    }
  }

  const unattributed = spurious.some(f => !attributeFragmentToEnvKey(envSources.authoredComposeText, f));
  if (unattributed) {
    const secretFileKeys = envFileKeys.filter(isLikelySecretKey);
    if (secretFileKeys.length === 1) {
      const key = secretFileKeys[0];
      addWarning({ envKey: key, likelySecret: true });
    } else {
      addWarning({ likelySecret: secretFileKeys.length > 0 });
    }
  }

  return { intentional, literalDollar: [...warnings.values()] };
}
