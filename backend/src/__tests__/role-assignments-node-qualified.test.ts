/**
 * migrateRoleAssignmentsNodeQualified: legacy rebuild, default remap,
 * no-default omit, sqlite_master idempotency probe, unique indexes,
 * deleteNode stack-grant cleanup, preserved ids/timestamps.
 */
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

function resetDatabaseSingleton(): void {
  const holder = DatabaseService as unknown as { instance?: DatabaseService };
  const existing = holder.instance;
  if (existing) {
    try {
      existing.getDb().close();
    } catch {
      // already closed
    }
    holder.instance = undefined;
  }
}

type IndexRow = { name: string; sql: string | null };
type AssignmentRow = {
  id: number;
  user_id: number;
  role: string;
  resource_type: string;
  resource_id: string;
  node_id: number | null;
  created_at: number;
};

function roleAssignmentsTableSql(raw: Database.Database): string {
  return (
    (raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'role_assignments'",
    ).get() as { sql: string } | undefined)?.sql ?? ''
  );
}

function roleAssignmentIndexes(raw: Database.Database): Map<string, string> {
  const rows = raw.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'role_assignments'",
  ).all() as IndexRow[];
  return new Map(rows.map((r) => [r.name, r.sql ?? '']));
}

/** Rewrite role_assignments to the pre-node_id schema and seed legacy rows. */
function seedLegacyRoleAssignments(
  dbPath: string,
  seed: {
    userId: number;
    stackRows: Array<{ id: number; role: string; resource_id: string; created_at: number }>;
    nodeRows: Array<{ id: number; role: string; resource_id: string; created_at: number }>;
  },
): void {
  const raw = new Database(dbPath);
  try {
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('DROP TABLE IF EXISTS role_assignments');
    raw.exec('DROP TABLE IF EXISTS role_assignments_new');
    raw.exec(`
      CREATE TABLE role_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_role_assignments_user ON role_assignments(user_id);
      CREATE INDEX IF NOT EXISTS idx_role_assignments_resource
        ON role_assignments(resource_type, resource_id);
    `);
    const insert = raw.prepare(`
      INSERT INTO role_assignments (id, user_id, role, resource_type, resource_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of seed.stackRows) {
      insert.run(row.id, seed.userId, row.role, 'stack', row.resource_id, row.created_at);
    }
    for (const row of seed.nodeRows) {
      insert.run(row.id, seed.userId, row.role, 'node', row.resource_id, row.created_at);
    }
  } finally {
    raw.close();
  }
}

function removeRoleAssignmentsCheck(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE role_assignments_without_check (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      node_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    INSERT INTO role_assignments_without_check
      SELECT * FROM role_assignments;
    DROP TABLE role_assignments;
    ALTER TABLE role_assignments_without_check RENAME TO role_assignments;
    CREATE INDEX idx_role_assignments_user ON role_assignments(user_id);
    CREATE INDEX idx_role_assignments_resource ON role_assignments(resource_type, resource_id);
    CREATE UNIQUE INDEX idx_role_assignments_stack_unique
      ON role_assignments(user_id, role, resource_type, resource_id, node_id)
      WHERE resource_type = 'stack';
    CREATE UNIQUE INDEX idx_role_assignments_node_unique
      ON role_assignments(user_id, role, resource_type, resource_id)
      WHERE resource_type = 'node';
  `);
}

function expectFinalSchema(raw: Database.Database): void {
  const tableSql = roleAssignmentsTableSql(raw);
  expect(tableSql).toContain("resource_type = 'stack' AND node_id IS NOT NULL");
  expect(tableSql).toContain("resource_type = 'node' AND node_id IS NULL");

  const indexes = roleAssignmentIndexes(raw);
  const stackUnique = indexes.get('idx_role_assignments_stack_unique') ?? '';
  const nodeUnique = indexes.get('idx_role_assignments_node_unique') ?? '';

  expect(stackUnique).toMatch(/user_id/i);
  expect(stackUnique).toMatch(/role/i);
  expect(stackUnique).toMatch(/resource_type/i);
  expect(stackUnique).toMatch(/resource_id/i);
  expect(stackUnique).toMatch(/node_id/i);
  expect(stackUnique).toMatch(/WHERE\s+resource_type\s*=\s*'stack'/i);

  expect(nodeUnique).toMatch(/user_id/i);
  expect(nodeUnique).toMatch(/role/i);
  expect(nodeUnique).toMatch(/resource_type/i);
  expect(nodeUnique).toMatch(/resource_id/i);
  expect(nodeUnique).toMatch(/WHERE\s+resource_type\s*=\s*'node'/i);
  const nodeCols = nodeUnique.replace(/WHERE[\s\S]*/i, '');
  expect(nodeCols).not.toMatch(/node_id/);
}

describe('migrateRoleAssignmentsNodeQualified', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupTestDb();
  });

  afterEach(() => {
    resetDatabaseSingleton();
    cleanupTestDb(tmpDir);
  });

  it('remaps legacy stack rows to the default node and preserves ids/timestamps', async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const remoteNodeId = db.addNode({
      name: 'mig-remote',
      type: 'remote',
      api_url: 'http://192.168.1.50:1852',
      api_token: '',
      compose_dir: '/tmp',
      is_default: false,
    });
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'mig-remap', password_hash: hash, role: 'viewer' });

    const stackCreatedAt = 1_700_000_000_001;
    const nodeCreatedAt = 1_700_000_000_002;
    resetDatabaseSingleton();
    seedLegacyRoleAssignments(path.join(tmpDir, 'sencho.db'), {
      userId,
      stackRows: [
        { id: 41, role: 'deployer', resource_id: 'web', created_at: stackCreatedAt },
        { id: 42, role: 'viewer', resource_id: 'api', created_at: stackCreatedAt + 1 },
      ],
      nodeRows: [
        { id: 51, role: 'node-admin', resource_id: String(remoteNodeId), created_at: nodeCreatedAt },
      ],
    });

    process.env.DATA_DIR = tmpDir;
    const migrated = DatabaseService.getInstance();
    const raw = migrated.getDb();
    expectFinalSchema(raw);

    const rows = raw.prepare(
      'SELECT * FROM role_assignments ORDER BY id',
    ).all() as AssignmentRow[];
    expect(rows).toHaveLength(3);

    const stackWeb = rows.find((r) => r.id === 41)!;
    expect(stackWeb.resource_type).toBe('stack');
    expect(stackWeb.resource_id).toBe('web');
    expect(stackWeb.node_id).toBe(defaultNodeId);
    expect(stackWeb.created_at).toBe(stackCreatedAt);
    expect(stackWeb.role).toBe('deployer');

    const stackApi = rows.find((r) => r.id === 42)!;
    expect(stackApi.node_id).toBe(defaultNodeId);
    expect(stackApi.created_at).toBe(stackCreatedAt + 1);

    const nodeGrant = rows.find((r) => r.id === 51)!;
    expect(nodeGrant.resource_type).toBe('node');
    expect(nodeGrant.node_id).toBeNull();
    expect(nodeGrant.created_at).toBe(nodeCreatedAt);
  });

  it('omits legacy stack rows when no default node exists', async () => {
    const db = DatabaseService.getInstance();
    const remoteNodeId = db.addNode({
      name: 'mig-no-default-remote',
      type: 'remote',
      api_url: 'http://192.168.1.51:1852',
      api_token: '',
      compose_dir: '/tmp',
      is_default: false,
    });
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'mig-omit', password_hash: hash, role: 'viewer' });
    db.getDb().prepare('UPDATE nodes SET is_default = 0').run();
    expect(db.getDefaultNode()).toBeUndefined();

    resetDatabaseSingleton();
    seedLegacyRoleAssignments(path.join(tmpDir, 'sencho.db'), {
      userId,
      stackRows: [
        { id: 61, role: 'deployer', resource_id: 'orphan-stack', created_at: 99 },
      ],
      nodeRows: [
        { id: 62, role: 'deployer', resource_id: String(remoteNodeId), created_at: 100 },
      ],
    });

    process.env.DATA_DIR = tmpDir;
    const migrated = DatabaseService.getInstance();
    const rows = migrated.getDb().prepare(
      'SELECT * FROM role_assignments ORDER BY id',
    ).all() as AssignmentRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(62);
    expect(rows[0].resource_type).toBe('node');
    expect(rows[0].node_id).toBeNull();
  });

  it('second init is idempotent via sqlite_master CHECK and partial-index WHERE probes', async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'mig-idem', password_hash: hash, role: 'viewer' });

    resetDatabaseSingleton();
    seedLegacyRoleAssignments(path.join(tmpDir, 'sencho.db'), {
      userId,
      stackRows: [
        { id: 71, role: 'deployer', resource_id: 'idem-stack', created_at: 200 },
      ],
      nodeRows: [],
    });

    process.env.DATA_DIR = tmpDir;
    const first = DatabaseService.getInstance();
    expectFinalSchema(first.getDb());
    const before = first.getDb().prepare(
      'SELECT id, node_id, created_at FROM role_assignments WHERE id = 71',
    ).get() as { id: number; node_id: number; created_at: number };
    expect(before.node_id).toBe(defaultNodeId);

    resetDatabaseSingleton();
    process.env.DATA_DIR = tmpDir;
    const second = DatabaseService.getInstance();
    expectFinalSchema(second.getDb());
    const after = second.getDb().prepare(
      'SELECT id, node_id, created_at FROM role_assignments WHERE id = 71',
    ).get() as { id: number; node_id: number; created_at: number };
    expect(after).toEqual(before);

    const stale = second.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_assignments_new'",
    ).get();
    expect(stale).toBeUndefined();
  });

  it('preserves node-qualified stack rows when repairing a missing index', async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const remoteNodeId = db.addNode({
      name: 'mig-repair-remote',
      type: 'remote',
      api_url: 'http://192.168.1.54:1852',
      api_token: '',
      compose_dir: '/tmp',
      is_default: false,
    });
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'mig-repair', password_hash: hash, role: 'viewer' });

    db.addRoleAssignment({
      user_id: userId, role: 'deployer', resource_type: 'stack',
      resource_id: 'shared-stack', node_id: defaultNodeId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'deployer', resource_type: 'stack',
      resource_id: 'shared-stack', node_id: remoteNodeId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'node-admin', resource_type: 'node',
      resource_id: String(remoteNodeId),
    });
    const before = db.getAllRoleAssignments(userId);
    db.getDb().exec('DROP INDEX idx_role_assignments_stack_unique');

    resetDatabaseSingleton();
    process.env.DATA_DIR = tmpDir;
    const repaired = DatabaseService.getInstance();
    expectFinalSchema(repaired.getDb());

    const rows = repaired.getAllRoleAssignments(userId);
    expect(rows).toEqual(before);
  });

  it('preserves node-qualified rows without a default node when repairing the table check', async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const remoteNodeId = db.addNode({
      name: 'mig-repair-no-default',
      type: 'remote',
      api_url: 'http://192.168.1.55:1852',
      api_token: '',
      compose_dir: '/tmp',
      is_default: false,
    });
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'mig-repair-check', password_hash: hash, role: 'viewer' });

    db.addRoleAssignment({
      user_id: userId, role: 'deployer', resource_type: 'stack',
      resource_id: 'local-stack', node_id: defaultNodeId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'admin', resource_type: 'stack',
      resource_id: 'remote-stack', node_id: remoteNodeId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'viewer', resource_type: 'node',
      resource_id: String(remoteNodeId),
    });
    const before = db.getAllRoleAssignments(userId);
    db.getDb().prepare('UPDATE nodes SET is_default = 0').run();
    removeRoleAssignmentsCheck(db.getDb());

    resetDatabaseSingleton();
    process.env.DATA_DIR = tmpDir;
    const repaired = DatabaseService.getInstance();
    expectFinalSchema(repaired.getDb());
    expect(repaired.getAllRoleAssignments(userId)).toEqual(before);
  });

  it('unique indexes use exact column sets including role', () => {
    const raw = DatabaseService.getInstance().getDb();
    const indexes = roleAssignmentIndexes(raw);
    const stackUnique = indexes.get('idx_role_assignments_stack_unique') ?? '';
    const nodeUnique = indexes.get('idx_role_assignments_node_unique') ?? '';

    expect(stackUnique.replace(/\s+/g, ' ')).toMatch(
      /ON role_assignments\s*\(\s*user_id\s*,\s*role\s*,\s*resource_type\s*,\s*resource_id\s*,\s*node_id\s*\)/i,
    );
    expect(nodeUnique.replace(/\s+/g, ' ')).toMatch(
      /ON role_assignments\s*\(\s*user_id\s*,\s*role\s*,\s*resource_type\s*,\s*resource_id\s*\)/i,
    );
  });

  it('deleteNode clears stack grants by node_id and preserves other nodes', async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const doomedId = db.addNode({
      name: 'mig-doomed',
      type: 'remote',
      api_url: 'http://192.168.1.52:1852',
      api_token: '',
      compose_dir: '/tmp',
      is_default: false,
    });
    const survivorId = db.addNode({
      name: 'mig-survivor',
      type: 'remote',
      api_url: 'http://192.168.1.53:1852',
      api_token: '',
      compose_dir: '/tmp',
      is_default: false,
    });
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'mig-delnode', password_hash: hash, role: 'viewer' });

    db.addRoleAssignment({
      user_id: userId, role: 'deployer', resource_type: 'stack',
      resource_id: 'shared-name', node_id: doomedId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'deployer', resource_type: 'stack',
      resource_id: 'shared-name', node_id: survivorId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'deployer', resource_type: 'stack',
      resource_id: 'local-only', node_id: defaultNodeId,
    });
    db.addRoleAssignment({
      user_id: userId, role: 'node-admin', resource_type: 'node',
      resource_id: String(doomedId),
    });

    db.deleteNode(doomedId);

    const remaining = db.getAllRoleAssignments(userId);
    expect(remaining.some((a) => a.node_id === doomedId)).toBe(false);
    expect(remaining.some((a) => a.resource_type === 'node' && a.resource_id === String(doomedId))).toBe(false);
    expect(remaining.some((a) => a.node_id === survivorId && a.resource_id === 'shared-name')).toBe(true);
    expect(remaining.some((a) => a.node_id === defaultNodeId && a.resource_id === 'local-only')).toBe(true);

    db.deleteUser(userId);
    db.deleteNode(survivorId);
  });
});
