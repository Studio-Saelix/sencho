import path from 'path';
import { sanitizeForLog } from './safeLog';

/**
 * Stack name must only contain URL-safe characters with no path separators.
 * Prevents path-traversal attacks when the name is used to build filesystem paths.
 */
export const isValidStackName = (name: string): boolean =>
  /^[a-zA-Z0-9_-]+$/.test(name);

/** Docker container name (no path separators). Used for scheduled container targets. */
export const isValidContainerName = (name: string): boolean =>
  !name.includes('..') && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name);

/**
 * Validates that a remote node API URL is a safe, well-formed HTTP/HTTPS URL.
 * Rejects loopback addresses to prevent SSRF against local services.
 * Private/LAN IPs are allowed - users legitimately point Sencho at nodes on their LAN.
 */
export function isValidRemoteUrl(
  raw: string,
): { valid: true; url: URL } | { valid: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (e) {
    console.warn('[Validation] URL parse failure:', sanitizeForLog((e as Error).message), 'input:', sanitizeForLog(raw));
    return {
      valid: false,
      reason: 'API URL must be a valid URL (e.g. https://my-server.example.com:1852)',
    };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, reason: 'API URL must use http:// or https://' };
  }
  // Node.js URL API preserves brackets for IPv6: new URL('http://[::1]').hostname === '[::1]'
  const loopback = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i;
  if (loopback.test(url.hostname)) {
    return {
      valid: false,
      reason: 'API URL cannot point to localhost or loopback - use the actual host address',
    };
  }
  return { valid: true, url };
}

/** Returns true when all four captured octet strings are in 0-255 range. */
function octetsInRange(a: string, b: string, c: string, d: string): boolean {
  return [a, b, c, d].map(Number).every(o => o >= 0 && o <= 255);
}

/**
 * Validates an IPv4 CIDR notation string (e.g. `10.0.0.0/24`).
 * Checks octet ranges (0-255) and prefix length (0-32).
 */
export function isValidCidr(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match) return false;
  return octetsInRange(match[1], match[2], match[3], match[4]) && Number(match[5]) <= 32;
}

/**
 * Validates a plain IPv4 address (e.g. `192.168.1.1`).
 * Rejects CIDR notation; use `isValidCidr` for that.
 */
export function isValidIPv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  return octetsInRange(match[1], match[2], match[3], match[4]);
}

/**
 * Validates a Docker resource ID (hex string, 12-64 characters).
 * Covers both short IDs (12 chars) and full SHA256 IDs (64 chars).
 */
export function isValidDockerResourceId(id: string): boolean {
  return /^[a-f0-9]{12,64}$/i.test(id);
}

/**
 * Compose service name. Allows dots in addition to the stack-name set
 * (Compose spec permits `my.service`).
 */
export const isValidServiceName = (name: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);

/**
 * Validates a relative path supplied by the client for stack file operations.
 * An empty string is allowed (it means the stack root directory).
 * Rejects anything that could escape the stack directory or cause OS-level issues.
 */
export function isValidRelativeStackPath(rel: string): boolean {
  if (rel === '') return true;
  if (rel.includes('\0')) return false;
  if (rel.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return false;
  if (rel.includes('//')) return false;
  const segments = rel.split('/');
  return !segments.some(seg => seg === '..' || seg === '.');
}

/**
 * Validates a file path inside a fetched Git repository.
 * Git source paths are POSIX-style relative file paths. They must not escape
 * the clone root or target Git metadata.
 */
export function isValidGitSourcePath(rel: string): boolean {
  if (!isValidRelativeStackPath(rel)) return false;
  if (rel === '') return false;
  const segments = rel.split('/').map(seg => seg.toLowerCase());
  return !segments.some(seg => seg === '.git');
}

/**
 * Asserts that a resolved file path stays within a given base directory.
 * Returns true if the path is safe, false if it escapes the base.
 */
export function isPathWithinBase(resolvedPath: string, baseDir: string): boolean {
  const normalizedBase = path.resolve(baseDir);
  const normalizedPath = path.resolve(resolvedPath);
  return (
    normalizedPath === normalizedBase ||
    normalizedPath.startsWith(normalizedBase + path.sep)
  );
}
