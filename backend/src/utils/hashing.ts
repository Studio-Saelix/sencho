import { createHash } from 'crypto';

/** Hex-encoded SHA-256 of a UTF-8 string. Stable across runs and platforms. */
export function sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}
