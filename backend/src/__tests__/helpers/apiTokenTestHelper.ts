import crypto from 'crypto';
import { generateApiToken } from '../../utils/apiTokenFormat';
import type { DatabaseService } from '../../services/DatabaseService';

type DbClass = typeof DatabaseService;

export interface CreateTestApiTokenOptions {
  db: DbClass;
  scope: 'read-only' | 'deploy-only' | 'full-admin';
  userId: number;
  name?: string;
  expiresAt?: number | null;
}

/**
 * Generate a `sen_sk_` API token and insert a backing row into `api_tokens`,
 * mirroring what `routes/apiTokens.ts` does in production. Returns the raw
 * token (only secret value the test sees; the DB stores its sha256).
 */
export function createTestApiToken(opts: CreateTestApiTokenOptions): string {
  const raw = generateApiToken();
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  opts.db.getInstance().addApiToken({
    token_hash: tokenHash,
    name: opts.name ?? `test-${opts.scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    scope: opts.scope,
    user_id: opts.userId,
    created_at: Date.now(),
    expires_at: opts.expiresAt ?? null,
  });
  return raw;
}

/**
 * Produce a well-formed `sen_sk_` token that has no matching DB row. The
 * auth layer should reject it at the row-lookup step — useful for asserting
 * unbacked tokens are not honoured.
 */
export function unbackedApiToken(): string {
  return generateApiToken();
}
