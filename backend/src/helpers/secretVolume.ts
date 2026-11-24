import type { Response } from 'express';
import { SEALED_SECRET_PURPOSES } from '../services/sealedSecrets/purposes';

/**
 * Docker volume label that marks a volume holding a sealed secret. Its value
 * is the purpose; the key alone is what every reader checks, so an empty value
 * still marks the volume.
 */
export const SECRET_VOLUME_LABEL = 'io.sencho.secret';

/** The machine code a client switches on when an operation is refused to protect a secret volume. */
export const SECRET_VOLUME_PROTECTED_CODE = 'secret_volume_protected';

/** True when a volume's labels mark it as a secret volume (key presence, any value). */
export function isSecretVolume(labels: Record<string, string> | null | undefined): boolean {
  return !!labels && Object.prototype.hasOwnProperty.call(labels, SECRET_VOLUME_LABEL);
}

/** Volume names reserved for sealed secrets, one per purpose. */
export function secretVolumeNames(): ReadonlySet<string> {
  return new Set(Object.values(SEALED_SECRET_PURPOSES).map((purpose) => purpose.volume));
}

/** True when the name is a reserved secret volume name. */
export function isReservedSecretVolumeName(name: string): boolean {
  return secretVolumeNames().has(name);
}

/** True when either the name is reserved or the labels mark the volume. */
export function isSecretVolumeRef(name: string, labels?: Record<string, string> | null): boolean {
  return isReservedSecretVolumeName(name) || isSecretVolume(labels);
}

/**
 * Refusal raised by every Sencho reader, writer, capture and removal path
 * that reaches a secret volume. Nothing in Sencho reads the value back.
 */
export class SecretVolumeProtectedError extends Error {
  readonly code = SECRET_VOLUME_PROTECTED_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'SecretVolumeProtectedError';
    Object.setPrototypeOf(this, SecretVolumeProtectedError.prototype);
  }
}

export function isSecretVolumeProtectedError(error: unknown): error is SecretVolumeProtectedError {
  return error instanceof SecretVolumeProtectedError;
}

/** The refusal text for a direct read, write or removal of a secret volume. */
export function secretVolumeAccessMessage(name: string): string {
  return `Volume "${name}" holds a secret Sencho delivered to this node, so Sencho does not open, change or remove it.`;
}

/** Answers 423 with the refusal's code when `error` is one. Returns false for any other error. */
export function sendIfSecretVolumeProtected(res: Response, error: unknown): boolean {
  if (!isSecretVolumeProtectedError(error)) return false;
  if (!res.headersSent) res.status(423).json({ error: error.message, code: error.code });
  return true;
}
