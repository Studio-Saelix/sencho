/**
 * A persisted Doctor location is only usable while the file it points into has
 * the content the run hashed. Editing that file must drop the link (a wrong
 * line is worse than no line); an unchanged file keeps it, and restoring the
 * exact content restores the link.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { sha256Hex } from '../utils/hashing';
import type { PreflightFinding, PreflightReport } from '../services/preflight/types';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeDoctorService: typeof import('../services/ComposeDoctorService').ComposeDoctorService;
let nodeId: number;

const STACK = 'location-freshness';
const PRIMARY = [
  'services:',
  '  api:',
  '    image: nginx:1.27',
  '    privileged: true',
  '',
].join('\n');
const OVERRIDE = [
  'services:',
  '  api:',
  '    image: nginx:latest',
  '',
].join('\n');

function db() { return DatabaseService.getInstance(); }
function doctor() { return ComposeDoctorService.getInstance(); }

function stackDir(): string {
  return path.join(process.env.COMPOSE_DIR as string, STACK);
}

function writeStack(files: Record<string, string>): void {
  fs.mkdirSync(stackDir(), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(stackDir(), name), content);
}

function stubDocker(renderable = true): void {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: renderable
        ? JSON.stringify({
          name: STACK,
          services: { api: { image: 'nginx:latest', privileged: true } },
          networks: {},
          volumes: {},
        })
        : null,
      stderr: '',
      code: renderable ? 0 : 1,
      timedOut: false,
    }),
    composeVersion: vi.fn().mockResolvedValue('2.30.0'),
  } as unknown as ComposeService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    getDocker: vi.fn(() => ({ listContainers: vi.fn().mockResolvedValue([]) })),
    inspectImage: vi.fn().mockRejectedValue(new Error('No such image')),
  } as unknown as DockerController);
}

function locationOf(report: PreflightReport, ruleId: string): PreflightFinding | undefined {
  return report.findings.find(finding => finding.ruleId === ruleId);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  await import('../index');
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeDoctorService } = await import('../services/ComposeDoctorService'));
  nodeId = (db().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stackDir(), { recursive: true, force: true });
});

describe('stored Doctor location freshness', () => {
  it('keeps links while the located files are unchanged and carries the digest with the wire range', async () => {
    writeStack({ 'compose.yaml': PRIMARY, 'compose.override.yaml': OVERRIDE });
    stubDocker();
    const run = await doctor().runPreflight(nodeId, STACK, 'tester');
    const imageRun = run.findings.find(finding => finding.ruleId === 'image-latest');
    const privilegedRun = run.findings.find(finding => finding.ruleId === 'privileged');
    expect(imageRun?.location).toMatchObject({ file: 'compose.override.yaml', line: 3 });
    expect(privilegedRun?.location).toMatchObject({ file: 'compose.yaml', line: 4 });

    const latest = await doctor().getLatest(nodeId, STACK);
    const image = locationOf(latest, 'image-latest');
    const privileged = locationOf(latest, 'privileged');
    expect(image?.location).toMatchObject({ file: 'compose.override.yaml', line: 3 });
    expect(privileged?.location).toMatchObject({ file: 'compose.yaml', line: 4 });
    // The digest travels with the range so the client can prove the content it
    // opens is the revision the range was computed against.
    expect(image?.location?.fileHash).toBe(sha256Hex(OVERRIDE));
    expect(privileged?.location?.fileHash).toBe(sha256Hex(PRIMARY));

    const row = db().getPreflightFindings(db().getLatestPreflightRun(nodeId, STACK)!.id)
      .find(finding => finding.rule_id === 'image-latest')!;
    const stored = JSON.parse(row.source_location!) as { fileHash: string };
    expect(stored).toMatchObject({
      file: 'compose.override.yaml', line: 3,
      fileHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(image?.location?.fileHash).toBe(stored.fileHash);
  });

  it('drops the link into an edited file and keeps the link into an unchanged one', async () => {
    writeStack({ 'compose.yaml': PRIMARY, 'compose.override.yaml': OVERRIDE });
    stubDocker();
    await doctor().runPreflight(nodeId, STACK, 'tester');

    // Editing the override moves its lines; the primary is untouched.
    writeStack({ 'compose.override.yaml': `# moved\n${OVERRIDE}` });
    const latest = await doctor().getLatest(nodeId, STACK);
    expect(locationOf(latest, 'image-latest')?.location).toBeUndefined();
    expect(locationOf(latest, 'image-latest')?.sourcePath).toBe('api');
    expect(locationOf(latest, 'privileged')?.location).toMatchObject({ file: 'compose.yaml', line: 4 });

    // Editing the primary drops its own link but not the override's (now unchanged).
    writeStack({ 'compose.yaml': `# moved\n${PRIMARY}` });
    const afterPrimary = await doctor().getLatest(nodeId, STACK);
    // The override still holds the edited content, so its hash stays mismatched.
    expect(locationOf(afterPrimary, 'image-latest')?.location).toBeUndefined();
    expect(locationOf(afterPrimary, 'privileged')?.location).toBeUndefined();
  });

  it('restores the link when the file returns to the content the run hashed', async () => {
    writeStack({ 'compose.yaml': PRIMARY, 'compose.override.yaml': OVERRIDE });
    stubDocker();
    await doctor().runPreflight(nodeId, STACK, 'tester');

    writeStack({ 'compose.override.yaml': `# moved\n${OVERRIDE}` });
    expect(locationOf(await doctor().getLatest(nodeId, STACK), 'image-latest')?.location).toBeUndefined();

    writeStack({ 'compose.override.yaml': OVERRIDE });
    expect(locationOf(await doctor().getLatest(nodeId, STACK), 'image-latest')?.location)
      .toMatchObject({ file: 'compose.override.yaml', line: 3 });
  });

  it('drops the link when the located file was deleted', async () => {
    writeStack({ 'compose.yaml': PRIMARY, 'compose.override.yaml': OVERRIDE });
    stubDocker();
    await doctor().runPreflight(nodeId, STACK, 'tester');

    fs.rmSync(path.join(stackDir(), 'compose.override.yaml'));
    expect(locationOf(await doctor().getLatest(nodeId, STACK), 'image-latest')?.location).toBeUndefined();
  });

  it('does not attach a run-time location when the located file could not be read', async () => {
    writeStack({
      'compose.yaml': 'include:\n  - missing.yaml\nservices:\n  api:\n    image: nginx:1\n',
    });
    stubDocker(false);
    const run = await doctor().runPreflight(nodeId, STACK, 'tester');
    const renderFailed = locationOf(run, 'render-failed');
    expect(renderFailed).toBeTruthy();
    // The missing include has only a fallback line 1 and no content digest, so
    // the run must not offer a link that a later read would drop.
    expect(renderFailed?.location).toBeUndefined();
  });

  it('drops a location stored without a file digest, as an older row cannot prove the range', async () => {
    writeStack({ 'compose.yaml': PRIMARY, 'compose.override.yaml': OVERRIDE });
    stubDocker();
    await doctor().runPreflight(nodeId, STACK, 'tester');
    const stored = JSON.parse(db().getPreflightFindings(db().getLatestPreflightRun(nodeId, STACK)!.id)
      .find(finding => finding.rule_id === 'image-latest')!.source_location!);
    const { file, line, column, endLine, endColumn } = stored;
    db().getDb().prepare('UPDATE preflight_findings SET source_location = ? WHERE rule_id = ?')
      .run(JSON.stringify({ file, line, column, endLine, endColumn }), 'image-latest');

    const latest = await doctor().getLatest(nodeId, STACK);
    expect(locationOf(latest, 'image-latest')?.location).toBeUndefined();
    expect(locationOf(latest, 'image-latest')?.sourcePath).toBe('api');
  });

  it('hashes a BOM-prefixed compose file with the BOM, matching the bytes on disk', async () => {
    // A leading UTF-8 BOM is part of the bytes a client reads back, so the
    // digest must cover it; the client verifies the same decoded text.
    const bomPrimary = `\uFEFF${PRIMARY}`;
    writeStack({ 'compose.yaml': bomPrimary, 'compose.override.yaml': OVERRIDE });
    stubDocker();
    await doctor().runPreflight(nodeId, STACK, 'tester');

    const latest = await doctor().getLatest(nodeId, STACK);
    expect(locationOf(latest, 'privileged')?.location).toMatchObject({
      file: 'compose.yaml',
      line: 4,
      fileHash: sha256Hex(bomPrimary),
    });
  });
});
