/**
 * Tests for Stack Labels feature: DatabaseService methods and cascade behavior.
 *
 * Uses an in-memory SQLite database (via better-sqlite3 directly)
 * to test actual SQL behavior without touching disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'local',
    status TEXT DEFAULT 'online',
    is_default INTEGER DEFAULT 0,
    api_url TEXT,
    api_token TEXT
  );

  CREATE TABLE IF NOT EXISTS stack_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    UNIQUE(node_id, name)
  );

  CREATE TABLE IF NOT EXISTS stack_label_assignments (
    label_id INTEGER NOT NULL REFERENCES stack_labels(id) ON DELETE CASCADE,
    stack_name TEXT NOT NULL,
    node_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (label_id, stack_name, node_id)
  );

  CREATE INDEX IF NOT EXISTS idx_label_assignments_stack
    ON stack_label_assignments(stack_name, node_id);

  CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    output TEXT,
    error TEXT,
    triggered_by TEXT DEFAULT 'scheduler'
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'stack',
    target_id TEXT,
    node_id INTEGER,
    action TEXT NOT NULL DEFAULT 'update',
    cron_expression TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at INTEGER,
    updated_at INTEGER,
    last_run_at INTEGER,
    next_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    prune_targets TEXT,
    target_services TEXT,
    prune_label_filter TEXT,
    selector_type TEXT,
    selector_value TEXT,
    FOREIGN KEY(node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS stack_update_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    stack_name TEXT NOT NULL,
    has_update INTEGER DEFAULT 0,
    checked_at INTEGER
  );
`;

function execStatements(db: Database.Database, sql: string) {
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    db.prepare(stmt).run();
  }
}

describe('Stack Labels (in-memory SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    execStatements(db, SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  // ── Helpers ────────────────────────────────────────────────────────

  function insertNode(name = 'test-node'): number {
    return db.prepare(
      'INSERT INTO nodes (name, type, status, is_default) VALUES (?, ?, ?, ?)'
    ).run(name, 'local', 'online', 0).lastInsertRowid as number;
  }

  interface Label { id: number; node_id: number; name: string; color: string }

  function createLabel(nodeId: number, name: string, color: string): Label {
    const result = db.prepare(
      'INSERT INTO stack_labels (node_id, name, color) VALUES (?, ?, ?)'
    ).run(nodeId, name, color);
    return { id: result.lastInsertRowid as number, node_id: nodeId, name, color };
  }

  function getLabel(id: number, nodeId: number): Label | null {
    return (db.prepare('SELECT * FROM stack_labels WHERE id = ? AND node_id = ?')
      .get(id, nodeId) as Label) ?? null;
  }

  function getLabels(nodeId: number): Label[] {
    return db.prepare('SELECT * FROM stack_labels WHERE node_id = ? ORDER BY name')
      .all(nodeId) as Label[];
  }

  function getLabelCount(nodeId: number): number {
    return (db.prepare('SELECT COUNT(*) as cnt FROM stack_labels WHERE node_id = ?')
      .get(nodeId) as { cnt: number }).cnt;
  }

  function updateLabel(id: number, nodeId: number, updates: { name?: string; color?: string }): Label | null {
    const label = db.prepare('SELECT * FROM stack_labels WHERE id = ? AND node_id = ?').get(id, nodeId) as Label | undefined;
    if (!label) return null;
    const name = updates.name ?? label.name;
    const color = updates.color ?? label.color;
    db.prepare('UPDATE stack_labels SET name = ?, color = ? WHERE id = ? AND node_id = ?').run(name, color, id, nodeId);
    return { ...label, name, color };
  }

  function deleteLabel(id: number, nodeId: number): void {
    db.prepare('DELETE FROM stack_labels WHERE id = ? AND node_id = ?').run(id, nodeId);
  }

  function setStackLabels(stackName: string, nodeId: number, labelIds: number[]): void {
    const txn = db.transaction(() => {
      if (labelIds.length > 0) {
        const placeholders = labelIds.map(() => '?').join(',');
        const validCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM stack_labels WHERE id IN (${placeholders}) AND node_id = ?`
        ).get(...labelIds, nodeId) as { cnt: number };
        if (validCount.cnt !== labelIds.length) {
          throw new Error('One or more label IDs are invalid for this node');
        }
      }
      db.prepare('DELETE FROM stack_label_assignments WHERE stack_name = ? AND node_id = ?').run(stackName, nodeId);
      const insert = db.prepare('INSERT INTO stack_label_assignments (label_id, stack_name, node_id) VALUES (?, ?, ?)');
      for (const labelId of labelIds) {
        insert.run(labelId, stackName, nodeId);
      }
    });
    txn();
  }

  function getLabelsForStacks(nodeId: number): Record<string, Label[]> {
    const rows = db.prepare(`
      SELECT a.stack_name, l.id, l.node_id, l.name, l.color
      FROM stack_label_assignments a
      JOIN stack_labels l ON a.label_id = l.id
      WHERE a.node_id = ?
      ORDER BY l.name
    `).all(nodeId) as (Label & { stack_name: string })[];
    const result: Record<string, Label[]> = {};
    for (const row of rows) {
      if (!result[row.stack_name]) result[row.stack_name] = [];
      result[row.stack_name].push({ id: row.id, node_id: row.node_id, name: row.name, color: row.color });
    }
    return result;
  }

  function getStacksForLabel(labelId: number, nodeId: number): string[] {
    const rows = db.prepare('SELECT stack_name FROM stack_label_assignments WHERE label_id = ? AND node_id = ?')
      .all(labelId, nodeId) as { stack_name: string }[];
    return rows.map(r => r.stack_name);
  }

  function cleanupStaleAssignments(nodeId: number, validStackNames: string[]): number {
    if (validStackNames.length === 0) {
      return db.prepare('DELETE FROM stack_label_assignments WHERE node_id = ?').run(nodeId).changes;
    }
    const placeholders = validStackNames.map(() => '?').join(',');
    return db.prepare(
      `DELETE FROM stack_label_assignments WHERE node_id = ? AND stack_name NOT IN (${placeholders})`
    ).run(nodeId, ...validStackNames).changes;
  }

  function countRows(table: string): number {
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  }

  // ── getLabels ──────────────────────────────────────────────────────

  describe('getLabels', () => {
    it('returns empty array for node with no labels', () => {
      expect(getLabels(0)).toEqual([]);
    });

    it('returns labels ordered by name', () => {
      createLabel(0, 'Zulu', 'teal');
      createLabel(0, 'Alpha', 'blue');
      createLabel(0, 'Mike', 'rose');
      const labels = getLabels(0);
      expect(labels.map(l => l.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
    });

    it('only returns labels for the specified node', () => {
      createLabel(0, 'local-label', 'teal');
      createLabel(1, 'remote-label', 'blue');
      expect(getLabels(0)).toHaveLength(1);
      expect(getLabels(0)[0].name).toBe('local-label');
      expect(getLabels(1)).toHaveLength(1);
      expect(getLabels(1)[0].name).toBe('remote-label');
    });
  });

  // ── getLabel ───────────────────────────────────────────────────────

  describe('getLabel', () => {
    it('returns the label by id and nodeId', () => {
      const created = createLabel(0, 'test', 'teal');
      const found = getLabel(created.id, 0);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('test');
      expect(found!.color).toBe('teal');
    });

    it('returns null for wrong nodeId', () => {
      const created = createLabel(0, 'test', 'teal');
      expect(getLabel(created.id, 999)).toBeNull();
    });

    it('returns null for nonexistent id', () => {
      expect(getLabel(999, 0)).toBeNull();
    });
  });

  // ── createLabel ────────────────────────────────────────────────────

  describe('createLabel', () => {
    it('creates label and returns it with id', () => {
      const label = createLabel(0, 'production', 'rose');
      expect(label.id).toBeGreaterThan(0);
      expect(label.name).toBe('production');
      expect(label.color).toBe('rose');
      expect(label.node_id).toBe(0);
    });

    it('throws on duplicate (node_id, name)', () => {
      createLabel(0, 'unique-name', 'teal');
      expect(() => createLabel(0, 'unique-name', 'blue')).toThrow();
    });

    it('allows same name on different nodes', () => {
      createLabel(0, 'shared-name', 'teal');
      const label2 = createLabel(1, 'shared-name', 'blue');
      expect(label2.id).toBeGreaterThan(0);
    });

    it('accepts names at exactly 30 characters', () => {
      const longName = 'a'.repeat(30);
      const label = createLabel(0, longName, 'teal');
      expect(label.name).toBe(longName);
    });

    it('accepts names with spaces and hyphens', () => {
      const label = createLabel(0, 'my cool-label', 'blue');
      expect(label.name).toBe('my cool-label');
    });
  });

  // ── getLabelCount ──────────────────────────────────────────────────

  describe('getLabelCount', () => {
    it('returns correct count', () => {
      createLabel(0, 'a', 'teal');
      createLabel(0, 'b', 'blue');
      createLabel(0, 'c', 'rose');
      expect(getLabelCount(0)).toBe(3);
    });

    it('returns 0 for node with no labels', () => {
      expect(getLabelCount(42)).toBe(0);
    });

    it('counts only labels for the specified node', () => {
      createLabel(0, 'a', 'teal');
      createLabel(0, 'b', 'blue');
      createLabel(1, 'c', 'rose');
      expect(getLabelCount(0)).toBe(2);
      expect(getLabelCount(1)).toBe(1);
    });
  });

  // ── updateLabel ────────────────────────────────────────────────────

  describe('updateLabel', () => {
    it('updates name only', () => {
      const label = createLabel(0, 'old-name', 'teal');
      const updated = updateLabel(label.id, 0, { name: 'new-name' });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('new-name');
      expect(updated!.color).toBe('teal');
    });

    it('updates color only', () => {
      const label = createLabel(0, 'test', 'teal');
      const updated = updateLabel(label.id, 0, { color: 'rose' });
      expect(updated).not.toBeNull();
      expect(updated!.color).toBe('rose');
      expect(updated!.name).toBe('test');
    });

    it('updates both name and color', () => {
      const label = createLabel(0, 'old', 'teal');
      const updated = updateLabel(label.id, 0, { name: 'new', color: 'purple' });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('new');
      expect(updated!.color).toBe('purple');
    });

    it('returns null for nonexistent label', () => {
      expect(updateLabel(999, 0, { name: 'nope' })).toBeNull();
    });

    it('returns null for wrong nodeId', () => {
      const label = createLabel(0, 'test', 'teal');
      expect(updateLabel(label.id, 999, { name: 'nope' })).toBeNull();
    });
  });

  // ── deleteLabel ────────────────────────────────────────────────────

  describe('deleteLabel', () => {
    it('removes the label', () => {
      const label = createLabel(0, 'doomed', 'teal');
      deleteLabel(label.id, 0);
      expect(getLabels(0)).toHaveLength(0);
    });

    it('cascade deletes assignments', () => {
      const label = createLabel(0, 'test', 'teal');
      setStackLabels('my-stack', 0, [label.id]);
      expect(countRows('stack_label_assignments')).toBe(1);

      deleteLabel(label.id, 0);
      expect(countRows('stack_label_assignments')).toBe(0);
    });

    it('no-op for wrong nodeId', () => {
      const label = createLabel(0, 'test', 'teal');
      deleteLabel(label.id, 999);
      expect(getLabels(0)).toHaveLength(1);
    });
  });

  // ── setStackLabels ─────────────────────────────────────────────────

  describe('setStackLabels', () => {
    it('assigns labels to a stack', () => {
      const l1 = createLabel(0, 'a', 'teal');
      const l2 = createLabel(0, 'b', 'blue');
      setStackLabels('my-stack', 0, [l1.id, l2.id]);

      const map = getLabelsForStacks(0);
      expect(map['my-stack']).toHaveLength(2);
    });

    it('replaces existing assignments', () => {
      const l1 = createLabel(0, 'a', 'teal');
      const l2 = createLabel(0, 'b', 'blue');
      setStackLabels('my-stack', 0, [l1.id, l2.id]);
      setStackLabels('my-stack', 0, [l1.id]);

      const map = getLabelsForStacks(0);
      expect(map['my-stack']).toHaveLength(1);
      expect(map['my-stack'][0].name).toBe('a');
    });

    it('clears assignments when empty array', () => {
      const l1 = createLabel(0, 'a', 'teal');
      setStackLabels('my-stack', 0, [l1.id]);
      setStackLabels('my-stack', 0, []);

      const map = getLabelsForStacks(0);
      expect(map['my-stack']).toBeUndefined();
    });

    it('throws for invalid label IDs', () => {
      expect(() => setStackLabels('my-stack', 0, [999])).toThrow('One or more label IDs are invalid');
    });

    it('throws if any label ID belongs to a different node', () => {
      const l1 = createLabel(1, 'remote-label', 'teal');
      expect(() => setStackLabels('my-stack', 0, [l1.id])).toThrow('One or more label IDs are invalid');
    });
  });

  // ── getLabelsForStacks ─────────────────────────────────────────────

  describe('getLabelsForStacks', () => {
    it('returns correct mapping', () => {
      const l1 = createLabel(0, 'alpha', 'teal');
      const l2 = createLabel(0, 'beta', 'blue');
      setStackLabels('stack-a', 0, [l1.id, l2.id]);
      setStackLabels('stack-b', 0, [l2.id]);

      const map = getLabelsForStacks(0);
      expect(Object.keys(map)).toHaveLength(2);
      expect(map['stack-a']).toHaveLength(2);
      expect(map['stack-b']).toHaveLength(1);
      // Verify ordering by name
      expect(map['stack-a'][0].name).toBe('alpha');
      expect(map['stack-a'][1].name).toBe('beta');
    });

    it('returns empty object when no assignments', () => {
      expect(getLabelsForStacks(0)).toEqual({});
    });

    it('scopes results to the specified node', () => {
      const l1 = createLabel(0, 'local', 'teal');
      const l2 = createLabel(1, 'remote', 'blue');
      setStackLabels('stack-a', 0, [l1.id]);
      setStackLabels('stack-b', 1, [l2.id]);

      const localMap = getLabelsForStacks(0);
      expect(Object.keys(localMap)).toEqual(['stack-a']);

      const remoteMap = getLabelsForStacks(1);
      expect(Object.keys(remoteMap)).toEqual(['stack-b']);
    });
  });

  // ── getStacksForLabel ──────────────────────────────────────────────

  describe('getStacksForLabel', () => {
    it('returns stack names for label', () => {
      const l1 = createLabel(0, 'test', 'teal');
      setStackLabels('stack-a', 0, [l1.id]);
      setStackLabels('stack-b', 0, [l1.id]);

      const stacks = getStacksForLabel(l1.id, 0);
      expect(stacks).toHaveLength(2);
      expect(stacks).toContain('stack-a');
      expect(stacks).toContain('stack-b');
    });

    it('filters by nodeId', () => {
      const l1 = createLabel(0, 'local', 'teal');
      const l2 = createLabel(1, 'remote', 'blue');
      setStackLabels('stack-a', 0, [l1.id]);
      setStackLabels('stack-b', 1, [l2.id]);

      expect(getStacksForLabel(l1.id, 0)).toEqual(['stack-a']);
      expect(getStacksForLabel(l1.id, 1)).toEqual([]);
      expect(getStacksForLabel(l2.id, 1)).toEqual(['stack-b']);
    });

    it('returns empty for nonexistent label', () => {
      expect(getStacksForLabel(999, 0)).toEqual([]);
    });
  });

  // ── cleanupStaleAssignments ────────────────────────────────────────

  describe('cleanupStaleAssignments', () => {
    it('removes assignments for stacks not in the valid list', () => {
      const l1 = createLabel(0, 'test', 'teal');
      setStackLabels('alive-stack', 0, [l1.id]);
      setStackLabels('dead-stack', 0, [l1.id]);

      const removed = cleanupStaleAssignments(0, ['alive-stack']);
      expect(removed).toBe(1);

      const map = getLabelsForStacks(0);
      expect(Object.keys(map)).toEqual(['alive-stack']);
    });

    it('preserves assignments for valid stacks', () => {
      const l1 = createLabel(0, 'a', 'teal');
      const l2 = createLabel(0, 'b', 'blue');
      setStackLabels('stack-1', 0, [l1.id, l2.id]);
      setStackLabels('stack-2', 0, [l1.id]);

      const removed = cleanupStaleAssignments(0, ['stack-1', 'stack-2']);
      expect(removed).toBe(0);
      expect(countRows('stack_label_assignments')).toBe(3);
    });

    it('handles empty valid list (deletes all for the node)', () => {
      const l1 = createLabel(0, 'test', 'teal');
      setStackLabels('stack-a', 0, [l1.id]);
      setStackLabels('stack-b', 0, [l1.id]);

      const removed = cleanupStaleAssignments(0, []);
      expect(removed).toBe(2);
      expect(countRows('stack_label_assignments')).toBe(0);
    });

    it('only affects the specified node', () => {
      const l1 = createLabel(0, 'local', 'teal');
      const l2 = createLabel(1, 'remote', 'blue');
      setStackLabels('stack-a', 0, [l1.id]);
      setStackLabels('stack-b', 1, [l2.id]);

      cleanupStaleAssignments(0, []);
      expect(getLabelsForStacks(0)).toEqual({});
      expect(Object.keys(getLabelsForStacks(1))).toEqual(['stack-b']);
    });
  });

  // ── deleteNode cascade ─────────────────────────────────────────────

  describe('deleteNode cascade (labels)', () => {
    it('deletes labels and assignments when node is deleted', () => {
      const nodeId = insertNode();
      const l1 = createLabel(nodeId, 'label-a', 'teal');
      const l2 = createLabel(nodeId, 'label-b', 'blue');
      setStackLabels('stack-1', nodeId, [l1.id, l2.id]);
      setStackLabels('stack-2', nodeId, [l1.id]);

      expect(getLabelCount(nodeId)).toBe(2);
      expect(countRows('stack_label_assignments')).toBe(3);

      // Simulate DatabaseService.deleteNode
      db.transaction(() => {
        db.prepare('DELETE FROM stack_label_assignments WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM stack_labels WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
      })();

      expect(countRows('nodes')).toBe(0);
      expect(countRows('stack_labels')).toBe(0);
      expect(countRows('stack_label_assignments')).toBe(0);
    });

    it('does not affect other nodes labels', () => {
      const node1 = insertNode('node-1');
      const node2 = insertNode('node-2');
      const l1 = createLabel(node1, 'label-a', 'teal');
      const l2 = createLabel(node2, 'label-b', 'blue');
      setStackLabels('stack-1', node1, [l1.id]);
      setStackLabels('stack-2', node2, [l2.id]);

      // Delete node1
      db.transaction(() => {
        db.prepare('DELETE FROM stack_label_assignments WHERE node_id = ?').run(node1);
        db.prepare('DELETE FROM stack_labels WHERE node_id = ?').run(node1);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(node1);
      })();

      // node2 data untouched
      expect(getLabelCount(node2)).toBe(1);
      expect(Object.keys(getLabelsForStacks(node2))).toEqual(['stack-2']);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('setStackLabels is atomic (all-or-nothing)', () => {
      const l1 = createLabel(0, 'valid', 'teal');
      setStackLabels('my-stack', 0, [l1.id]);

      // Try to set with a mix of valid and invalid IDs
      expect(() => setStackLabels('my-stack', 0, [l1.id, 999])).toThrow();

      // Original assignment should be unchanged (transaction rolled back)
      const map = getLabelsForStacks(0);
      expect(map['my-stack']).toHaveLength(1);
      expect(map['my-stack'][0].name).toBe('valid');
    });

    it('cascade delete on label removes all its assignments across stacks', () => {
      const l1 = createLabel(0, 'shared', 'teal');
      const l2 = createLabel(0, 'other', 'blue');
      setStackLabels('stack-a', 0, [l1.id, l2.id]);
      setStackLabels('stack-b', 0, [l1.id]);
      setStackLabels('stack-c', 0, [l1.id]);

      expect(countRows('stack_label_assignments')).toBe(4);

      deleteLabel(l1.id, 0);

      // Only l2's assignment on stack-a should remain
      expect(countRows('stack_label_assignments')).toBe(1);
      const map = getLabelsForStacks(0);
      expect(Object.keys(map)).toEqual(['stack-a']);
      expect(map['stack-a'][0].name).toBe('other');
    });

    it('multiple labels assigned to the same stack', () => {
      const l1 = createLabel(0, 'env', 'teal');
      const l2 = createLabel(0, 'tier', 'blue');
      const l3 = createLabel(0, 'team', 'rose');
      setStackLabels('my-stack', 0, [l1.id, l2.id, l3.id]);

      const map = getLabelsForStacks(0);
      expect(map['my-stack']).toHaveLength(3);
    });
  });
});
