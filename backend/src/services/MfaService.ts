import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { OTP } from 'otplib';
import { DatabaseService } from './DatabaseService';
import { MFA_REPLAY_TTL_MS, MFA_REPLAY_PURGE_INTERVAL_MS } from '../helpers/constants';
import { isDebugEnabled } from '../utils/debug';

// TOTP configuration: 6 digits, 30-second step, SHA-1, ±1 step tolerance.
// SHA-1 is the universally supported default for authenticator apps (RFC 6238).
const totp = new OTP({ strategy: 'totp' });
const TOTP_PARAMS = { algorithm: 'sha1' as const, digits: 6, period: 30 };

const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-like, no 0/O/1/I/L
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_COUNT = 10;
const BACKUP_HASH_COST = 10;

/**
 * Result of checking a backup code. On a match it carries the exact stored
 * hash so the caller can consume that entry atomically (see
 * DatabaseService.consumeBackupCodeHash); the discriminated shape makes the
 * "matched implies a hash to consume" invariant unrepresentable otherwise.
 */
export type BackupVerifyResult =
    | { matched: true; matchedHash: string }
    | { matched: false };

export class MfaService {
    private static instance: MfaService;
    private purgeTimer: NodeJS.Timeout | null = null;

    public static getInstance(): MfaService {
        if (!MfaService.instance) MfaService.instance = new MfaService();
        return MfaService.instance;
    }

    /**
     * Start the periodic purge of used-MFA-code rows. The replay blacklist
     * holds (user, code, window) tuples for the last ~2 minutes; older rows
     * are safe to drop. Idempotent: calling start() twice is a no-op.
     */
    public start(): void {
        if (this.purgeTimer) return;
        this.purgeTimer = setInterval(() => {
            try {
                const deleted = DatabaseService.getInstance().purgeOldMfaCodes(Date.now() - MFA_REPLAY_TTL_MS);
                if (isDebugEnabled() && deleted > 0) {
                    console.log('[MFA:diag] replay purge deleted=', deleted);
                }
            } catch (err) {
                console.warn('[MFA] Replay purge failed:', (err as Error).message);
            }
        }, MFA_REPLAY_PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
    }

    public stop(): void {
        if (this.purgeTimer) {
            clearInterval(this.purgeTimer);
            this.purgeTimer = null;
        }
    }

    /**
     * Generate a fresh base32 TOTP secret ready for `buildOtpauthUri` and
     * `verifyTotp`. Each user should receive a unique secret.
     */
    public static generateSecret(): string {
        return totp.generateSecret();
    }

    /**
     * Build an `otpauth://` URI for QR-code rendering or manual entry. The
     * label follows the RFC 6238 format `Issuer:account` so the authenticator
     * app can label the entry clearly.
     */
    public static buildOtpauthUri(secret: string, username: string, issuer = 'Sencho'): string {
        return totp.generateURI({ issuer, label: username, secret, ...TOTP_PARAMS });
    }

    /**
     * Verify a TOTP code against the stored secret. Uses the window tolerance
     * configured above, so a code is accepted if it matches the previous,
     * current, or next 30-second step.
     */
    public static verifyTotp(secret: string, code: string): boolean {
        if (!secret || !code) return false;
        const trimmed = code.trim().replace(/\s+/g, '');
        if (!/^\d{6}$/.test(trimmed)) return false;
        try {
            return totp.verifySync({ secret, token: trimmed, ...TOTP_PARAMS, epochTolerance: 30 }).valid;
        } catch {
            return false;
        }
    }

    /**
     * Return the integer Unix step for the current time. Used to key the
     * replay-prevention blacklist so a given (user, code, window) combination
     * can only be used once.
     */
    public static currentWindow(nowMs: number = Date.now()): number {
        return Math.floor(nowMs / 1000 / 30);
    }

    /**
     * Generate a fresh set of backup codes in cleartext. Callers should pass
     * these through `hashBackupCodes` before persistence and show the
     * cleartext to the user exactly once.
     */
    public static generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
        const codes: string[] = [];
        for (let i = 0; i < count; i++) {
            codes.push(this.randomBackupCode());
        }
        return codes;
    }

    /**
     * Hash each backup code with bcrypt so the stored form cannot be replayed
     * even if the database is leaked.
     */
    public static async hashBackupCodes(codes: string[]): Promise<string[]> {
        return Promise.all(codes.map((code) => bcrypt.hash(this.normalizeBackupCode(code), BACKUP_HASH_COST)));
    }

    /**
     * Check a user-supplied backup code against the stored hashes. Returns
     * `{ matched, matchedHash }`. The caller must consume `matchedHash`
     * atomically to enforce single-use; this method does not mutate state, so
     * two concurrent verifications of the same code cannot both win at the
     * write (see DatabaseService.consumeBackupCodeHash).
     */
    public static async verifyBackupCode(hashes: string[], code: string): Promise<BackupVerifyResult> {
        const normalized = this.normalizeBackupCode(code);
        if (!normalized) return { matched: false };

        for (const hash of hashes) {
            // bcrypt.compare is constant-time per hash; we return on the first
            // match. The matched slot's position carries no useful signal: the
            // codes are random and single-use, so leaking "which slot" via an
            // early return tells an attacker nothing.
            if (await bcrypt.compare(normalized, hash)) {
                return { matched: true, matchedHash: hash };
            }
        }
        return { matched: false };
    }

    /**
     * Display helper: group a 10-character backup code as `ABCDE-FGHIJ` so
     * it is easier for the user to read and transcribe.
     */
    public static formatBackupCodeForDisplay(code: string): string {
        const normalized = this.normalizeBackupCode(code);
        if (normalized.length !== BACKUP_CODE_LENGTH) return normalized;
        return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
    }

    /** Uppercase, strip non-alphanumeric separators (e.g. dashes, spaces). */
    public static normalizeBackupCode(code: string): string {
        if (!code) return '';
        return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    private static randomBackupCode(): string {
        const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
        let out = '';
        for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
            out += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
        }
        return out;
    }
}
