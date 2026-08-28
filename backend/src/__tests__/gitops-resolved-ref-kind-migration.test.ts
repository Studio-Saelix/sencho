/**
 * Legacy installations regain gitops_generations.resolved_ref_kind and
 * gitops_applications.fetched_resolved_ref_kind through initSchema's maybeAddCol.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DB_PATH } from './helpers/testConstants';

let tmpDir: string;

beforeAll(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-ref-mig-'));
  process.env.DATA_DIR = tmpDir;
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tmpDir, 'sencho.db'));
  raw.exec('ALTER TABLE gitops_generations DROP COLUMN resolved_ref_kind');
  raw.exec('ALTER TABLE gitops_applications DROP COLUMN fetched_resolved_ref_kind');
  raw.close();

  const { DatabaseService } = await import('../services/DatabaseService');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DatabaseService as any).instance = undefined;
  DatabaseService.getInstance();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('resolved ref kind schema migration', () => {
  it('re-adds generation and application columns through DatabaseService initSchema', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance().getDb();
    const generationCols = new Set(
      (db.pragma('table_info(gitops_generations)') as Array<{ name: string }>).map((c) => c.name),
    );
    const applicationCols = new Set(
      (db.pragma('table_info(gitops_applications)') as Array<{ name: string }>).map((c) => c.name),
    );
    expect(generationCols.has('resolved_ref_kind')).toBe(true);
    expect(applicationCols.has('fetched_resolved_ref_kind')).toBe(true);
  });
});
