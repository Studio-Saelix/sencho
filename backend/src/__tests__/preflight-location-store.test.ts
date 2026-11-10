import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import {
  normalizeDoctorHit, normalizeStoredFinding, serializeSourceLocation,
} from '../services/assurance/finding';
import { getAssuranceRule } from '../services/assurance/ruleRegistry';

let tmpDir: string;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
});

afterAll(() => cleanupTestDb(tmpDir));

function runRow(id: string) {
  return {
    id,
    node_id: nodeId,
    stack_name: 'stored-location',
    source_hash: null,
    rendered_hash: null,
    service_images: null,
    status: 'warning' as const,
    highest_severity: 'warning' as const,
    created_at: Date.now(),
    created_by: 'test',
    coverage: null,
  };
}

function findingRow(id: string, runId: string, sourceLocation: string | null) {
  return {
    id,
    run_id: runId,
    rule_id: 'image-latest',
    severity: 'warning',
    title: 'Image uses a moving tag',
    message: 'Service "api" uses a moving tag.',
    source_path: 'api',
    source_location: sourceLocation,
    remediation: null,
    service: 'api',
    created_at: Date.now(),
    rule_version: 1,
    subject_kind: 'service',
    subject_key: 'api',
  };
}

describe('preflight finding source locations', () => {
  it('round-trips an authored range through the stored row', () => {
    const db = DatabaseService.getInstance();
    const rule = getAssuranceRule('image-latest')!;
    const normalized = normalizeDoctorHit(
      nodeId, 'stored-location',
      { ruleId: 'image-latest', severity: 'warning', title: 't', message: 'm', service: 'api', sourcePath: 'api' },
      rule,
      { file: 'compose.override.yaml', path: 'services.api.image', line: 14, column: 12, endLine: 14, endColumn: 22 },
    );
    const serialized = serializeSourceLocation(normalized.location);
    expect(serialized).not.toBeNull();
    db.replacePreflightRun(runRow('run-1'), [findingRow('finding-1', 'run-1', serialized)]);

    const rows = db.getPreflightFindings('run-1');
    expect(rows[0].source_location).toBe(serialized);
    const read = normalizeStoredFinding(rows[0], nodeId, 'stored-location');
    expect(read.location).toMatchObject({
      file: 'compose.override.yaml', path: 'api', authoredPath: 'services.api.image',
      line: 14, column: 12, endLine: 14, endColumn: 22,
    });
  });

  it('keeps a long authored path from discarding the file and range', () => {
    const longPath = `services.api.${'x'.repeat(300)}`;
    const normalized = normalizeDoctorHit(
      nodeId, 'stored-location',
      { ruleId: 'image-latest', severity: 'warning', title: 't', message: 'm', service: 'api', sourcePath: 'api' },
      getAssuranceRule('image-latest')!,
      { file: 'compose.yaml', path: longPath, line: 3, column: 12, endLine: 3, endColumn: 20 },
    );
    const serialized = serializeSourceLocation(normalized.location);
    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain(longPath);
    const parsed = JSON.parse(serialized!);
    expect(parsed).toMatchObject({ file: 'compose.yaml', line: 3, column: 12, endLine: 3, endColumn: 20 });
  });

  it('reads a legacy row without the column as no location', () => {
    const db = DatabaseService.getInstance();
    db.getDb().prepare(
      `INSERT INTO preflight_findings
         (id, run_id, rule_id, severity, title, message, source_path, remediation, service, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-1', 'legacy-run', 'image-latest', 'warning', 't', 'm', 'api', null, 'api', Date.now());
    const row = db.getPreflightFindings('legacy-run')[0];
    expect(row.source_location).toBeNull();
    expect(normalizeStoredFinding(row, nodeId, 'stored-location').location).toEqual({ path: 'api' });
  });

  it('keeps the range when only the optional authored path is invalid', () => {
    const row = findingRow('bad-authored-path', 'invalid-run',
      JSON.stringify({ file: 'compose.yaml', line: 4, column: 2, endLine: 4, endColumn: 9, authoredPath: 'x'.repeat(300) }));
    const location = normalizeStoredFinding(row, nodeId, 'stored-location').location;
    expect(location).toEqual({
      path: 'api', file: 'compose.yaml', line: 4, column: 2, endLine: 4, endColumn: 9,
    });
  });

  it('drops an absolute path, a non-positive line, or a reversed range on read', () => {
    const invalid = [
      JSON.stringify({ file: '/etc/passwd', line: 1, column: 1, endLine: 1, endColumn: 2 }),
      JSON.stringify({ file: 'compose.yaml', line: 0, column: 1, endLine: 1, endColumn: 2 }),
      JSON.stringify({ file: 'compose.yaml', line: 5, column: 1, endLine: 4, endColumn: 2 }),
      JSON.stringify({ file: '../outside.yaml', line: 1, column: 1, endLine: 1, endColumn: 2 }),
      'not json',
    ];
    for (const [index, raw] of invalid.entries()) {
      const row = { ...findingRow(`invalid-${index}`, 'invalid-run', raw) };
      expect(normalizeStoredFinding(row, nodeId, 'stored-location').location).toEqual({ path: 'api' });
    }
  });
});
