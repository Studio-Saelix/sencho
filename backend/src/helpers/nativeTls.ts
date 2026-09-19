import fs from 'fs';

export const TLS_CERT_FILE_ENV = 'SENCHO_TLS_CERT_FILE';
export const TLS_KEY_FILE_ENV = 'SENCHO_TLS_KEY_FILE';
export const TLS_CA_FILE_ENV = 'SENCHO_TLS_CA_FILE';
export const TLS_KEY_PASSPHRASE_ENV = 'SENCHO_TLS_KEY_PASSPHRASE';

export class NativeTlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeTlsConfigError';
  }
}

export interface NativeTlsMaterial {
  cert: string;
  key: string;
  passphrase?: string;
  caPem?: string;
}

export interface NativeTlsServerOptions {
  cert: string;
  key: string;
  passphrase?: string;
  minVersion: 'TLSv1.2';
}

function envPath(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? '';
}

function isPilotMode(env: NodeJS.ProcessEnv): boolean {
  return env.SENCHO_MODE === 'pilot';
}

/** True when this process should listen with HTTPS. False in Pilot mode. Does not read the files. */
export function isNativeTlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isPilotMode(env)) return false;
  return Boolean(envPath(env, TLS_CERT_FILE_ENV) && envPath(env, TLS_KEY_FILE_ENV));
}

function readRequired(filePath: string, label: string): string {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unreadable';
    throw new NativeTlsConfigError(`Failed to read ${label} (${filePath}): ${detail}`);
  }
  if (!contents.trim()) {
    throw new NativeTlsConfigError(`${label} (${filePath}) is empty`);
  }
  return contents;
}

/**
 * Load hub TLS material. Returns null when native TLS is unset or this
 * process is a Pilot agent. Throws NativeTlsConfigError when configuration
 * is partial, a file is unreadable, or a PEM is empty, so the process never
 * silently serves HTTP after the operator asked for TLS.
 */
export function loadNativeTlsMaterial(env: NodeJS.ProcessEnv = process.env): NativeTlsMaterial | null {
  const certPath = envPath(env, TLS_CERT_FILE_ENV);
  const keyPath = envPath(env, TLS_KEY_FILE_ENV);

  if (isPilotMode(env)) {
    if (certPath || keyPath) {
      console.warn(
        '[TLS] SENCHO_TLS_CERT_FILE / SENCHO_TLS_KEY_FILE are ignored when SENCHO_MODE=pilot; the loopback listener stays HTTP',
      );
    }
    return null;
  }

  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new NativeTlsConfigError(
      'SENCHO_TLS_CERT_FILE and SENCHO_TLS_KEY_FILE must both be set to enable native TLS',
    );
  }

  const cert = readRequired(certPath, TLS_CERT_FILE_ENV);
  const key = readRequired(keyPath, TLS_KEY_FILE_ENV);
  const passphrase = envPath(env, TLS_KEY_PASSPHRASE_ENV) || undefined;

  const caPath = envPath(env, TLS_CA_FILE_ENV);
  const caPem = caPath ? readRequired(caPath, TLS_CA_FILE_ENV) : undefined;

  return { cert, key, passphrase, caPem };
}

export function nativeTlsServerOptions(material: NativeTlsMaterial): NativeTlsServerOptions {
  return {
    cert: material.cert,
    key: material.key,
    passphrase: material.passphrase,
    minVersion: 'TLSv1.2',
  };
}

export function rewriteHttpUrlToHttps(url: string): string {
  const prefix = 'http://';
  if (!url.toLowerCase().startsWith(prefix)) return url;
  return `https://${url.slice(prefix.length)}`;
}
