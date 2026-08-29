import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureTrustedRoot, validateTrustedRoot } from '../helpers/privateRootValidator';

export const PREPARED_SOURCE_MARKER_FILE = '.sencho-prepared-source';
export const PREPARED_SOURCE_PARENT_PREFIX = 'sencho-registry-prepared-';
const DEFAULT_TTL_MS = 900_000;

export type PreparedSourceState = 'prepared' | 'claimed' | 'finalized';

export interface PreparedSourceEntry {
  prepId: string;
  sourceKind: string;
  sourceHash: string;
  dirPath: string;
  state: PreparedSourceState;
  createdAt: number;
  expiresAt: number;
}

function deliverySourceHash(deliverySourceId: string): string {
  return crypto.createHash('sha256').update(`prepared-source:${deliverySourceId}`).digest('hex');
}

export function getPreparedSourceRootPath(deliverySourceId: string): string {
  return path.join(os.tmpdir(), `${PREPARED_SOURCE_PARENT_PREFIX}${deliverySourceHash(deliverySourceId)}`);
}

function publishMarker(childDir: string, sourceKind: string): void {
  const markerPath = path.join(childDir, PREPARED_SOURCE_MARKER_FILE);
  const fd = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${sourceKind}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class PreparedSourceStore {
  private static instance: PreparedSourceStore | null = null;
  private entries = new Map<string, PreparedSourceEntry>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private deliverySourceId: string | null = null;

  static getInstance(): PreparedSourceStore {
    if (!this.instance) this.instance = new PreparedSourceStore();
    return this.instance;
  }

  configure(deliverySourceId: string): void {
    this.deliverySourceId = deliverySourceId;
  }

  start(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => this.expireStaleEntries(), 60_000);
    if (typeof this.expiryTimer.unref === 'function') {
      this.expiryTimer.unref();
    }
  }

  stop(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private requireDeliverySourceId(): string {
    if (!this.deliverySourceId) {
      throw new Error('PreparedSourceStore is not configured');
    }
    return this.deliverySourceId;
  }

  private childPath(prepId: string): string {
    const root = getPreparedSourceRootPath(this.requireDeliverySourceId());
    return path.join(root, prepId);
  }

  async prepareFromDirectory(
    sourceKind: string,
    sourceHash: string,
    stagingDir: string,
  ): Promise<PreparedSourceEntry> {
    const deliverySourceId = this.requireDeliverySourceId();
    const rootPath = getPreparedSourceRootPath(deliverySourceId);
    const rootValidation = ensureTrustedRoot({ rootPath, kind: 'prepared-source' });
    if (!rootValidation.ok) {
      throw new Error(rootValidation.reason);
    }

    const prepId = crypto.randomBytes(16).toString('hex');
    const childDir = path.join(rootPath, prepId);
    fs.mkdirSync(childDir, { mode: 0o700 });

    try {
      publishMarker(childDir, sourceKind);
      const payloadDir = path.join(childDir, 'payload');
      await fs.promises.rename(stagingDir, payloadDir);
    } catch (error) {
      try { await fs.promises.rm(childDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw error;
    }

    const now = Date.now();
    const entry: PreparedSourceEntry = {
      prepId,
      sourceKind,
      sourceHash,
      dirPath: childDir,
      state: 'prepared',
      createdAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
    };
    this.entries.set(prepId, entry);
    return entry;
  }

  getEntry(prepId: string): PreparedSourceEntry | undefined {
    return this.entries.get(prepId);
  }

  claim(prepId: string): PreparedSourceEntry {
    const entry = this.entries.get(prepId);
    if (!entry || entry.state !== 'prepared') {
      throw new Error('Prepared source is not available for claim');
    }
    if (entry.expiresAt <= Date.now()) {
      throw new Error('Prepared source expired');
    }
    entry.state = 'claimed';
    return entry;
  }

  peekPayloadPath(prepId: string): string {
    const entry = this.entries.get(prepId);
    if (!entry || entry.state === 'finalized') {
      throw new Error('Prepared source not found');
    }
    if (entry.expiresAt <= Date.now()) {
      throw new Error('Prepared source expired');
    }
    return path.join(entry.dirPath, 'payload');
  }

  finalize(prepId: string): void {
    const entry = this.entries.get(prepId);
    if (!entry) return;
    entry.state = 'finalized';
    try {
      fs.rmSync(entry.dirPath, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.entries.delete(prepId);
  }

  getPayloadPath(prepId: string): string {
    const entry = this.entries.get(prepId);
    if (!entry) {
      throw new Error('Prepared source not found');
    }
    return path.join(entry.dirPath, 'payload');
  }

  private expireStaleEntries(): void {
    const now = Date.now();
    for (const [prepId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        try {
          fs.rmSync(entry.dirPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        this.entries.delete(prepId);
      }
    }
  }

  async sweepOrphans(deliverySourceId: string): Promise<string[]> {
    const rootPath = getPreparedSourceRootPath(deliverySourceId);
    const swept: string[] = [];
    const validation = validateTrustedRoot({ rootPath, kind: 'prepared-source' });
    if (!validation.ok) {
      return swept;
    }

    let entries: string[];
    try {
      entries = await fs.promises.readdir(rootPath);
    } catch {
      return swept;
    }

    for (const entry of entries) {
      const childPath = path.join(rootPath, entry);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(childPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const markerPath = path.join(childPath, PREPARED_SOURCE_MARKER_FILE);
      if (!fs.existsSync(markerPath)) continue;
      try {
        await fs.promises.rm(childPath, { recursive: true, force: true });
        swept.push(entry);
      } catch {
        /* ignore */
      }
    }
    return swept;
  }
}
