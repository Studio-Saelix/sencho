/**
 * Create-from-Git durability: the activation transaction, the teardown of a
 * create that never reached `applied`, and the staging marker plus
 * operation-owned cleanup that together decide what a crashed create is
 * allowed to delete.
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import {
  appliedRelPathFor,
  candidateRelPathForSha,
  deleteStagingMarker,
  CREATE_STAGING_MARKER_FILENAME,
  readStagingMarker,
  stagingMarkerPath,
  writeStagingMarker,
  CreateStagingMarkerError,
} from '../services/gitops/createStagingMarker';
import { cleanupUnclaimedManagedRoot, removeOperationOwnedPaths } from '../services/gitops/createCleanup';
import { GENERATIONS_DIR, MANAGED_ROOT_NAME, managedAreaBase } from '../services/gitops/managedPaths';
import type {
  GitOpsApplicationRow,
  GitOpsCreateCheckpointRow,
  GitOpsGenerationRow,
} from '../services/gitops/types';

const SHA = 'a1b2c3d4';

describe('gitops create-from-git', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('commits application, fetch, generation, checkpoint, and candidate in one transaction', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const result = tx.activateCreateFromGit({
      application: creatingApp('app-create', 'create-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-create', 'app-create'),
      checkpoint: checkpoint('app-create', 'create-web'),
      envelope: envelope('op-create'),
    });

    const app = store.getApplication('app-create')!;
    expect(app.lifecycle_status).toBe('creating');
    expect(app.desired_commit_sha).toBe(SHA);
    expect(app.fetched_commit_sha).toBe(SHA);
    expect(app.candidate_generation_id).toBe('gen-create');
    expect(app.accepted_generation_id).toBeNull();
    expect(app.source_acceptance_ref).toBeNull();

    const target = store.getTarget('app-create', 1)!;
    expect(target.candidate_generation_id).toBe('gen-create');
    expect(target.desired_generation_id).toBeNull();
    expect(target.applied_generation_id).toBeNull();

    expect(store.getCreateCheckpoint('app-create')?.generation_id).toBe('gen-create');
    expect(store.getCreateCheckpoint('app-create')?.phase).toBe('pre_stack');

    expect(result.historyIds).toHaveLength(3);
    const stages = DatabaseService.getInstance().getDb().prepare(
      'SELECT stage FROM gitops_history WHERE application_id = ? ORDER BY rowid ASC',
    ).all('app-create') as Array<{ stage: string }>;
    expect(stages.map((row) => row.stage)).toEqual(['application_activated', 'fetched', 'candidate_ready']);
  });

  it('refuses to persist a create whose candidate is blocked or stale', () => {
    const tx = GitOpsTransitions.getInstance();
    expect(() => tx.activateCreateFromGit({
      application: creatingApp('app-blocked', 'blocked-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: { ...gen('gen-blocked', 'app-blocked'), plan_blocked: 1 },
      checkpoint: checkpoint('app-blocked', 'blocked-web'),
      envelope: envelope('op-blocked'),
    })).toThrow(/invalid or blocked candidate/);

    expect(() => tx.activateCreateFromGit({
      application: creatingApp('app-stale', 'stale-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: { ...gen('gen-stale', 'app-stale'), materialization_fingerprint: 'b'.repeat(64) },
      checkpoint: checkpoint('app-stale', 'stale-web'),
      envelope: envelope('op-stale'),
    })).toThrow(/fingerprint/);

    expect(GitOpsStore.getInstance().getApplication('app-blocked')).toBeUndefined();
    expect(GitOpsStore.getInstance().getApplication('app-stale')).toBeUndefined();
  });

  it('activates the application only at applied, which is the success boundary', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateCreateFromGit({
      application: creatingApp('app-boundary', 'boundary-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-boundary', 'app-boundary'),
      checkpoint: checkpoint('app-boundary', 'boundary-web'),
      envelope: envelope('op-boundary'),
    });
    expect(store.getApplication('app-boundary')?.lifecycle_status).toBe('creating');

    tx.applied({
      applicationId: 'app-boundary',
      generationId: 'gen-boundary',
      artifactSetId: 'art-boundary',
      sourceAcceptanceId: 'acc-boundary',
      authority: 'operator',
      envelope: envelope('op-boundary-applied'),
      activateCreating: true,
    });

    const app = store.getApplication('app-boundary')!;
    expect(app.lifecycle_status).toBe('active');
    expect(app.accepted_generation_id).toBe('gen-boundary');
    expect(store.getTarget('app-boundary', 1)?.applied_generation_id).toBe('gen-boundary');

    // After the success boundary the create can no longer be torn down.
    expect(() => tx.createFailed('app-boundary', 'post_boundary', envelope('op-boundary-fail')))
      .toThrow(/requires a creating application/);
    expect(store.getApplication('app-boundary')?.lifecycle_status).toBe('active');
  });

  it('tombstones a failed create, drops its checkpoint, and frees the stack name', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateCreateFromGit({
      application: creatingApp('app-fail', 'fail-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-fail', 'app-fail'),
      checkpoint: checkpoint('app-fail', 'fail-web'),
      envelope: envelope('op-fail'),
    });
    tx.createFailed('app-fail', 'validation', envelope('op-fail'));

    const app = store.getApplication('app-fail')!;
    expect(app.lifecycle_status).toBe('deleted');
    expect(app.failure_stage).toBe('create');
    expect(app.failure_class).toBe('validation');
    expect(store.getCreateCheckpoint('app-fail')).toBeUndefined();
    expect(store.getTarget('app-fail', 1)?.target_status).toBe('tombstoned');
    expect(store.getLiveDirectApplication('fail-web')).toBeUndefined();

    // Retry is a brand new application id against the now-free stack name.
    tx.activateCreateFromGit({
      application: creatingApp('app-fail-retry', 'fail-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-fail-retry', 'app-fail-retry'),
      checkpoint: checkpoint('app-fail-retry', 'fail-web'),
      envelope: envelope('op-fail-retry'),
    });
    expect(store.getLiveDirectApplication('fail-web')?.id).toBe('app-fail-retry');
  });
});

describe('gitops create staging marker', () => {
  let root: string;
  let dataDir: string;
  let priorDataDir: string | undefined;

  beforeAll(() => {
    // A managed root only ever lives inside the managed area, and the marker
    // helpers enforce that at every filesystem call, so the fixture has to be a
    // real managed area rather than a bare temp directory.
    priorDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'sencho-marker-'));
    process.env.DATA_DIR = dataDir;
    root = managedAreaBase();
    fs.mkdirSync(root, { recursive: true });
  });

  afterAll(() => {
    if (priorDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = priorDataDir;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function areaFor(name: string): string {
    return path.join(root, name);
  }

  it('derives generation paths without depending on import order', () => {
    // These were briefly built from a constant imported across a module cycle,
    // which evaluated as undefined and produced `undefined/candidate-<sha>`:
    // a path that passes containment, names nothing, and makes cleanup a no-op.
    expect(candidateRelPathForSha('abc123')).toBe('generations/candidate-abc123');
    expect(appliedRelPathFor('abc123', 2)).toBe('generations/applied-abc123-2');
  });

  it('round-trips a valid marker and refuses a foreign live marker', async () => {
    const area = areaFor('round-trip');
    await writeStagingMarker(area, {
      schemaVersion: 1,
      operationId: 'op-1',
      rootPreexisted: true,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: 1,
    });
    const read = await readStagingMarker(area);
    expect(read.state).toBe('valid');
    if (read.state !== 'valid') throw new Error('expected a valid marker');
    expect(read.marker.operationId).toBe('op-1');
    expect(read.marker.candidateRelPath).toBe(`generations/candidate-${SHA}`);

    // Same operation may rewrite its own marker; a different one may not.
    await writeStagingMarker(area, { ...read.marker, createdAt: 2 });
    await expect(writeStagingMarker(area, { ...read.marker, operationId: 'op-2' }))
      .rejects.toBeInstanceOf(CreateStagingMarkerError);

    await deleteStagingMarker(area);
    expect((await readStagingMarker(area)).state).toBe('missing');
  });

  it('treats every unsafe candidate path as corrupt', async () => {
    const cases: Array<[string, unknown]> = [
      ['absolute', path.resolve(root, 'elsewhere')],
      ['dotdot', '../escape'],
      ['empty', ''],
      ['wrong prefix', 'applied/candidate-abc'],
      ['escape', 'generations/candidate-../../../etc'],
      ['null', null],
    ];
    for (const [label, candidateRelPath] of cases) {
      const area = areaFor(`corrupt-${label.replace(/\s/g, '-')}`);
      await fsPromises.mkdir(area, { recursive: true });
      await fsPromises.writeFile(
        stagingMarkerPath(area),
        JSON.stringify({ schemaVersion: 1, operationId: 'op-x', rootPreexisted: true, candidateRelPath, createdAt: 1 }),
        'utf8',
      );
      const read = await readStagingMarker(area);
      expect(read.state, `${label} should be corrupt`).toBe('corrupt');
    }
  });

  it('rejects a marker with a bad schema version or missing fields', async () => {
    const area = areaFor('bad-shape');
    await fsPromises.mkdir(area, { recursive: true });
    await fsPromises.writeFile(stagingMarkerPath(area), '{"schemaVersion":2}', 'utf8');
    expect((await readStagingMarker(area)).state).toBe('corrupt');
    await fsPromises.writeFile(stagingMarkerPath(area), 'not json', 'utf8');
    expect((await readStagingMarker(area)).state).toBe('corrupt');
  });

  it('refuses to claim an area whose marker cannot be read', async () => {
    // A marker that exists but will not parse is still someone's claim.
    // Writing over it would hand this operation deletion authority over what
    // the last one staged.
    const area = areaFor('unreadable-claim');
    await fsPromises.mkdir(area, { recursive: true });
    await fsPromises.writeFile(stagingMarkerPath(area), 'not json', 'utf8');
    await expect(writeStagingMarker(area, {
      schemaVersion: 1,
      operationId: 'op-new',
      rootPreexisted: true,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: 1,
    })).rejects.toThrow(/unreadable staging marker/);
  });

  it('refuses every marker operation on a root outside the managed area', async () => {
    // The stack name reaches this root without being validated here, so each
    // call checks containment itself. Without these the checks are deletable
    // and nothing notices.
    const outside = path.join(dataDir, 'not-the-managed-area', 'web');
    await fsPromises.mkdir(outside, { recursive: true });

    const read = await readStagingMarker(outside);
    expect(read.state).toBe('corrupt');
    if (read.state !== 'corrupt') throw new Error('expected a corrupt result');
    expect(read.reason).toMatch(/managed area/);

    await expect(writeStagingMarker(outside, {
      schemaVersion: 1,
      operationId: 'op-outside',
      rootPreexisted: true,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: 1,
    })).rejects.toBeInstanceOf(CreateStagingMarkerError);

    await expect(deleteStagingMarker(outside)).rejects.toBeInstanceOf(CreateStagingMarkerError);
  });
});

describe('gitops create cleanup', () => {
  let root: string;
  let dataDir: string;
  let priorDataDir: string | undefined;

  beforeAll(() => {
    // Same as the marker describe: cleanup refuses to touch anything outside
    // the managed area, so the fixture areas have to live inside one.
    priorDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'sencho-cleanup-'));
    process.env.DATA_DIR = dataDir;
    root = managedAreaBase();
    fs.mkdirSync(root, { recursive: true });
  });

  afterAll(() => {
    if (priorDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = priorDataDir;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedArea(name: string): Promise<{ area: string; candidateRel: string; sentinel: string }> {
    const area = path.join(root, name);
    const candidateRel = candidateRelPathForSha(SHA);
    await fsPromises.mkdir(path.join(area, candidateRel), { recursive: true });
    const sentinel = path.join(area, 'generations', 'applied-old');
    await fsPromises.mkdir(sentinel, { recursive: true });
    return { area, candidateRel, sentinel };
  }

  it('removes only the staged candidate when the managed root pre-existed', async () => {
    const { area, candidateRel, sentinel } = await seedArea('preexisting');
    await removeOperationOwnedPaths({ stackManagedRoot: area, candidateRelPath: candidateRel, ownsManagedRoot: false });
    expect(fs.existsSync(path.join(area, candidateRel))).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.existsSync(area)).toBe(true);
  });

  it('removes the whole root only when the operation created it', async () => {
    const { area, candidateRel } = await seedArea('owned');
    await removeOperationOwnedPaths({ stackManagedRoot: area, candidateRelPath: candidateRel, ownsManagedRoot: true });
    expect(fs.existsSync(area)).toBe(false);
  });

  it('refuses to remove a managed root outside the managed area', async () => {
    // The guard that keeps a recursive removal inside the area it is meant to
    // clean. Without a test it is deletable and nothing notices.
    const outside = path.join(dataDir, 'not-the-managed-area', 'web');
    fs.mkdirSync(outside, { recursive: true });
    await expect(removeOperationOwnedPaths({
      stackManagedRoot: outside,
      candidateRelPath: null,
      ownsManagedRoot: true,
    })).rejects.toThrow(/outside the managed area/);
    expect(fs.existsSync(outside)).toBe(true);

    // The reaper reports rather than throws, so it answers `preserved`.
    expect(await cleanupUnclaimedManagedRoot(outside, {
      operationId: 'op-outside',
      rootPreexisted: false,
      candidateRelPath: candidateRelPathForSha(SHA),
    })).toBe('preserved');
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses to remove a path outside the managed root', async () => {
    const { area } = await seedArea('escape-guard');
    await expect(removeOperationOwnedPaths({
      stackManagedRoot: area,
      candidateRelPath: '../../outside',
      ownsManagedRoot: false,
    })).rejects.toThrow(/outside the managed root/);
  });

  /**
   * A directory link that lands outside the managed area.
   *
   * `junction` is what Windows can create without elevation, and Node ignores
   * the type argument everywhere else, so one call covers both platforms.
   */
  async function linkOutside(linkPath: string, name: string, victimRelPath?: string): Promise<string> {
    const external = path.join(dataDir, 'external', name);
    await fsPromises.mkdir(external, { recursive: true });
    await fsPromises.writeFile(path.join(external, 'keepme.txt'), 'not ours', 'utf8');
    // The path the escaping delete would actually resolve to. Without content
    // at exactly that path the removal is a no-op even unguarded, and the
    // survival assertion would pass against the unfixed code too.
    if (victimRelPath) {
      const victim = path.join(external, victimRelPath);
      await fsPromises.mkdir(victim, { recursive: true });
      await fsPromises.writeFile(path.join(victim, 'victim.txt'), 'would have been deleted', 'utf8');
    }
    await fsPromises.mkdir(path.dirname(linkPath), { recursive: true });
    await fsPromises.symlink(external, linkPath, 'junction');
    return external;
  }

  it('refuses to remove a path whose parent links out of the managed area', async () => {
    // The lexical checks all pass here: `<area>/generations/candidate-*` reads
    // as contained no matter what `generations` points at. Containment has to
    // be proven against the real filesystem, because the recursive delete is
    // what follows the link.
    const area = path.join(root, 'junction-parent');
    const candidateRel = candidateRelPathForSha(SHA);
    const external = await linkOutside(path.join(area, 'generations'), 'parent-escape', `candidate-${SHA}`);

    await expect(removeOperationOwnedPaths({
      stackManagedRoot: area,
      candidateRelPath: candidateRel,
      ownsManagedRoot: false,
    })).rejects.toThrow(/links outside its managed location/);
    // The path the escaping delete would have resolved to, not just a bystander
    // file: this is the data an unguarded removal destroys.
    expect(fs.existsSync(path.join(external, `candidate-${SHA}`, 'victim.txt'))).toBe(true);
    expect(fs.existsSync(path.join(external, 'keepme.txt'))).toBe(true);
  });

  it('refuses to remove a managed root that is itself a link out of the area', async () => {
    const area = path.join(root, 'junction-root');
    const external = await linkOutside(area, 'root-escape');

    await expect(removeOperationOwnedPaths({
      stackManagedRoot: area,
      candidateRelPath: null,
      ownsManagedRoot: true,
    })).rejects.toThrow(/links outside its managed location/);
    expect(fs.existsSync(path.join(external, 'keepme.txt'))).toBe(true);
    // The link itself survives too. Unlinking it is the damage an unguarded
    // delete does here, and it is the operator's own relocation pointer.
    expect(fs.existsSync(area)).toBe(true);

    // The boot sweep reaches the same root by a different route and must reach
    // the same answer, reporting rather than throwing as it does everywhere.
    expect(await cleanupUnclaimedManagedRoot(area, {
      operationId: 'op-junction',
      rootPreexisted: false,
      candidateRelPath: candidateRelPathForSha(SHA),
    })).toBe('preserved');
    expect(fs.existsSync(path.join(external, 'keepme.txt'))).toBe(true);
    expect(fs.existsSync(area)).toBe(true);
  });

  /**
   * A directory link that stays *inside* the managed area but lands in another
   * stack's subtree.
   *
   * The area-membership check cannot see this: the link's target is a real path
   * under the managed area, so "is this inside the area" answers yes while the
   * delete walks into a generation that belongs to someone else. Containment has
   * to be proven against the path's own place in the area, not the area itself.
   */
  it('refuses to remove a candidate reached through a junction into a sibling stack', async () => {
    const victim = await seedArea('sibling-victim');
    const attacker = path.join(root, 'sibling-attacker');
    await fsPromises.mkdir(attacker, { recursive: true });
    await fsPromises.symlink(
      path.join(victim.area, GENERATIONS_DIR),
      path.join(attacker, GENERATIONS_DIR),
      'junction',
    );

    await expect(removeOperationOwnedPaths({
      stackManagedRoot: attacker,
      candidateRelPath: candidateRelPathForSha(SHA),
      ownsManagedRoot: false,
    })).rejects.toThrow(/links outside its managed location/);
    // The other stack's staged generation, which an area-only guard removes.
    expect(fs.existsSync(path.join(victim.area, victim.candidateRel))).toBe(true);
    expect(fs.existsSync(victim.sentinel)).toBe(true);
  });

  it('refuses to remove a managed root that junctions into another node subtree', async () => {
    // Mirrors the production layout `<area>/<nodeId>/<stackName>`, because the
    // node segment is the one an area-only guard also fails to pin.
    const victimRoot = path.join(root, 'node-2', 'shared-name');
    const victimGeneration = path.join(victimRoot, candidateRelPathForSha(SHA));
    await fsPromises.mkdir(victimGeneration, { recursive: true });

    const attackerRoot = path.join(root, 'node-1', 'shared-name');
    await fsPromises.mkdir(path.dirname(attackerRoot), { recursive: true });
    await fsPromises.symlink(victimRoot, attackerRoot, 'junction');

    await expect(removeOperationOwnedPaths({
      stackManagedRoot: attackerRoot,
      candidateRelPath: null,
      ownsManagedRoot: true,
    })).rejects.toThrow(/links outside its managed location/);
    expect(fs.existsSync(victimGeneration)).toBe(true);

    // The boot sweep reaches the same root by another route and must agree.
    expect(await cleanupUnclaimedManagedRoot(attackerRoot, {
      operationId: 'op-sibling-node',
      rootPreexisted: false,
      candidateRelPath: candidateRelPathForSha(SHA),
    })).toBe('preserved');
    expect(fs.existsSync(victimGeneration)).toBe(true);
  });

  it('refuses to write or delete a staging marker through a junction into a sibling stack', async () => {
    // The write sink needs the same rule as the delete: a marker written into
    // another stack's root would hand this operation deletion authority there,
    // and would overwrite the claim that stack is relying on.
    const victim = path.join(root, 'sibling-marker-victim');
    await fsPromises.mkdir(victim, { recursive: true });
    const attacker = path.join(root, 'sibling-marker-attacker');
    await fsPromises.symlink(victim, attacker, 'junction');

    // No marker at the victim yet, so the write reaches the containment check
    // rather than being turned back by the "someone already owns this" guard.
    await expect(writeStagingMarker(attacker, {
      schemaVersion: 1,
      operationId: 'op-sibling-marker',
      rootPreexisted: false,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: 1,
    })).rejects.toThrow(/links outside its managed location/);
    expect(fs.existsSync(path.join(victim, CREATE_STAGING_MARKER_FILENAME))).toBe(false);

    // Now the victim holds its own claim, and the delete must not clear it:
    // that claim is what stops a second create racing this stack.
    await fsPromises.writeFile(path.join(victim, CREATE_STAGING_MARKER_FILENAME), 'theirs', 'utf8');
    await expect(deleteStagingMarker(attacker)).rejects.toThrow(/links outside its managed location/);
    expect(fs.readFileSync(path.join(victim, CREATE_STAGING_MARKER_FILENAME), 'utf8')).toBe('theirs');
  });

  it('refuses to write a staging marker through a link out of the area', async () => {
    // The write sink gets the same barrier as the delete. Without it a marker
    // could be written through a link and then refused by the hardened delete,
    // wedging the stack name behind a claim nothing could clear.
    const area = path.join(root, 'junction-write');
    const external = await linkOutside(area, 'write-escape');

    await expect(writeStagingMarker(area, {
      schemaVersion: 1,
      operationId: 'op-write-escape',
      rootPreexisted: false,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: 1,
    })).rejects.toThrow(/links outside its managed location/);
    expect(fs.existsSync(path.join(external, CREATE_STAGING_MARKER_FILENAME))).toBe(false);
  });

  it('refuses to delete a staging marker through a link out of the area', async () => {
    // Reached only through the real-path barrier: the marker path is lexically
    // inside the area, so every string check passes.
    const area = path.join(root, 'junction-marker');
    const external = await linkOutside(area, 'marker-escape');
    await fsPromises.writeFile(path.join(external, CREATE_STAGING_MARKER_FILENAME), '{}', 'utf8');

    await expect(deleteStagingMarker(area)).rejects.toThrow(/links outside its managed location/);
    expect(fs.existsSync(path.join(external, CREATE_STAGING_MARKER_FILENAME))).toBe(true);
  });

  it('treats a managed area that does not exist as nothing to remove', async () => {
    // A database restored without its data directory, or a volume that failed
    // to mount. Every path under the area is absent, so a forced remove is a
    // no-op. Refusing here instead would make an absent directory look like a
    // link escape and, with the boot gate, stop the instance starting at all.
    const missingData = path.join(dataDir, 'no-area-here');
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = missingData;
    try {
      const area = path.join(managedAreaBase(), 'ghost-stack');
      await expect(removeOperationOwnedPaths({
        stackManagedRoot: area,
        candidateRelPath: candidateRelPathForSha(SHA),
        ownsManagedRoot: false,
      })).resolves.toBe('cleared');
    } finally {
      process.env.DATA_DIR = previous;
    }
  });

  it('still cleans up when the managed area itself is relocated onto a link', async () => {
    // The counterpart to the two tests above: an operator who points the data
    // directory at another volume has moved the whole area rather than escaped
    // it, and cleanup must keep working for them.
    const relocatedData = path.join(dataDir, 'relocated-data');
    const storage = path.join(dataDir, 'other-volume');
    await fsPromises.mkdir(relocatedData, { recursive: true });
    await fsPromises.mkdir(storage, { recursive: true });
    await fsPromises.symlink(storage, path.join(relocatedData, MANAGED_ROOT_NAME), 'junction');

    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = relocatedData;
    try {
      const area = path.join(managedAreaBase(), 'relocated-stack');
      const candidateRel = candidateRelPathForSha(SHA);
      await fsPromises.mkdir(path.join(area, candidateRel), { recursive: true });

      await removeOperationOwnedPaths({ stackManagedRoot: area, candidateRelPath: candidateRel, ownsManagedRoot: false });
      expect(fs.existsSync(path.join(area, candidateRel))).toBe(false);
    } finally {
      process.env.DATA_DIR = previous;
    }
  });

  it('preserves an unclaimed root whose marker is missing or corrupt', async () => {
    const { area, sentinel } = await seedArea('unclaimed');
    expect(await cleanupUnclaimedManagedRoot(area, null)).toBe('preserved');
    expect(fs.existsSync(sentinel)).toBe(true);

    expect(await cleanupUnclaimedManagedRoot(area, {
      operationId: 'op-x',
      rootPreexisted: true,
      candidateRelPath: '../escape',
    })).toBe('preserved');
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('applies operation-owned cleanup for an unclaimed root with a valid marker', async () => {
    const preexisting = await seedArea('unclaimed-preexisting');
    expect(await cleanupUnclaimedManagedRoot(preexisting.area, {
      operationId: 'op-x',
      rootPreexisted: true,
      candidateRelPath: preexisting.candidateRel,
    })).toBe('removed_candidate');
    expect(fs.existsSync(path.join(preexisting.area, preexisting.candidateRel))).toBe(false);
    expect(fs.existsSync(preexisting.sentinel)).toBe(true);

    const owned = await seedArea('unclaimed-owned');
    expect(await cleanupUnclaimedManagedRoot(owned.area, {
      operationId: 'op-x',
      rootPreexisted: false,
      candidateRelPath: owned.candidateRel,
    })).toBe('removed_root');
    expect(fs.existsSync(owned.area)).toBe(false);
  });
});

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}

function checkpoint(applicationId: string, stackName: string): GitOpsCreateCheckpointRow {
  return {
    application_id: applicationId,
    stack_name: stackName,
    phase: 'pre_stack',
    generation_id: null,
    operation_id: `op-${applicationId}`,
    repo_url: 'https://github.com/org/repo.git',
    branch: 'main',
    compose_path: 'compose.yml',
    compose_paths_json: '["compose.yml"]',
    context_dir: null,
    sync_env: 0,
    env_path: null,
    auth_type: 'none',
    encrypted_token: null,
    auto_apply_on_webhook: 0,
    auto_deploy_on_apply: 0,
    commit_sha: SHA,
    applied_spec_json: null,
    created_managed_root: 1,
    created_at: 1,
    updated_at: 1,
  };
}

function creatingApp(id: string, stackName: string): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `direct:${stackName}`,
    lifecycle_status: 'creating',
    target_mode: 'direct',
    stack_name: stackName,
    blueprint_id: null,
    configured_repo_url: 'https://github.com/org/repo.git',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yml"]',
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: 'a'.repeat(64),
    desired_commit_sha: null,
    fetched_commit_sha: null,
    candidate_generation_id: null,
    accepted_generation_id: null,
    candidate_plan_blocked: 0,
    review_required: 0,
    artifact_set_id: null,
    latest_artifact_set_id: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    preflight_fingerprint: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    partial_json: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    retry_at: null,
    retry_count: 0,
    suspended_at: null,
    recovery_ref: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    evidence_fresh_at: null,
    evidence_limitations_json: null,
    created_at: 1,
    updated_at: 1,
  };
}

function gen(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: SHA,
    repo_url: 'https://github.com/org/repo.git',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 0,
    candidate_dir: candidateRelPathForSha(SHA),
    applied_dir: `generations/applied-${id}-0`,
    expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    materialization_fingerprint: 'a'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${id}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    created_at: 1,
  };
}
