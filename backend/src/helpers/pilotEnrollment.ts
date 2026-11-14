import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DatabaseService } from '../services/DatabaseService';
import { isNativeTlsEnabled, loadNativeTlsMaterial } from './nativeTls';
import { buildPilotEnrollmentCompose } from './pilotEnrollmentCompose';

/** One-use enrollment credential lifetime. The tunnel consumes it once, inside this window. */
export const PILOT_ENROLLMENT_TTL_SECONDS = 15 * 60;

/**
 * Mint the one-use `pilot_enroll` credential for a node and record its hash.
 * Minting again replaces the previous row, so an earlier unused token stops
 * working. The token itself is never stored.
 */
export function mintPilotEnrollmentToken(nodeId: number): { token: string; expiresAt: number } {
  const db = DatabaseService.getInstance();
  const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
  if (!jwtSecret) throw new Error('JWT secret not configured');
  const expiresAt = Date.now() + PILOT_ENROLLMENT_TTL_SECONDS * 1000;
  const enrollNonce = crypto.randomUUID();
  const token = jwt.sign(
    { scope: 'pilot_enroll', nodeId, enrollNonce },
    jwtSecret,
    { expiresIn: PILOT_ENROLLMENT_TTL_SECONDS },
  );
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.createPilotEnrollment(nodeId, tokenHash, expiresAt);
  return { token, expiresAt };
}

/** The hub CA a Pilot must trust, when the hub terminates TLS itself. */
export function pilotHubCaPem(): string | undefined {
  return isNativeTlsEnabled() ? loadNativeTlsMaterial()?.caPem : undefined;
}

/** Mint a credential and the canonical Pilot compose file that carries it. */
export function mintPilotEnrollment(nodeId: number, primaryUrl: string, composeDir: string): {
  token: string;
  expiresAt: number;
  composeYaml: string;
  caPem?: string;
} {
  const { token, expiresAt } = mintPilotEnrollmentToken(nodeId);
  const caPem = pilotHubCaPem();
  const composeYaml = buildPilotEnrollmentCompose({ primaryUrl, token, composeDir, caPem });
  return caPem
    ? { token, expiresAt, composeYaml, caPem }
    : { token, expiresAt, composeYaml };
}
