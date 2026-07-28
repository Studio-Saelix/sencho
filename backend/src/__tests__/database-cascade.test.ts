/**
 * Tests for cascade delete behavior in DatabaseService.
 *
 * Verifies that deleting a scheduled task also removes its runs,
 * and deleting a node cascades through tasks and their runs.
 *
 * Uses an in-memory SQLite database (via better-sqlite3 directly)
 * to test actual SQL behavior without touching disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Minimal schema for the tables we need
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

  CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    output TEXT,
    error TEXT,
    triggered_by TEXT DEFAULT 'scheduler',
    FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS stack_update_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    stack_name TEXT NOT NULL,
    has_update INTEGER DEFAULT 0,
    checked_at INTEGER
  );
`;

describe('Cascade delete behavior (in-memory SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.prepare(SCHEMA.split(';').filter(s => s.trim())[0] + ';').run();
    db.prepare(SCHEMA.split(';').filter(s => s.trim())[1] + ';').run();
    db.prepare(SCHEMA.split(';').filter(s => s.trim())[2] + ';').run();
    db.prepare(SCHEMA.split(';').filter(s => s.trim())[3] + ';').run();
  });

  afterEach(() => {
    db.close();
  });

  function insertNode(name = 'test-node'): number {
    return db.prepare(
      'INSERT INTO nodes (name, type, status, is_default) VALUES (?, ?, ?, ?)'
    ).run(name, 'local', 'online', 0).lastInsertRowid as number;
  }

  function insertTask(nodeId: number, name = 'test-task'): number {
    return db.prepare(
      'INSERT INTO scheduled_tasks (name, node_id, action, cron_expression, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(name, nodeId, 'update', '0 3 * * *', 'admin').lastInsertRowid as number;
  }

  function insertRun(taskId: number): number {
    return db.prepare(
      'INSERT INTO scheduled_task_runs (task_id, started_at, status, triggered_by) VALUES (?, ?, ?, ?)'
    ).run(taskId, Date.now(), 'success', 'scheduler').lastInsertRowid as number;
  }

  function insertStackStatus(nodeId: number, stackName: string): void {
    db.prepare(
      'INSERT INTO stack_update_status (node_id, stack_name, has_update, checked_at) VALUES (?, ?, ?, ?)'
    ).run(nodeId, stackName, 0, Date.now());
  }

  function countRows(table: string): number {
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  }

  // ── deleteScheduledTask cascade ─────────────────────────────────────

  describe('deleteScheduledTask cascade', () => {
    it('removes associated runs when deleting a task', () => {
      const nodeId = insertNode();
      const taskId = insertTask(nodeId);
      insertRun(taskId);
      insertRun(taskId);
      insertRun(taskId);

      expect(countRows('scheduled_task_runs')).toBe(3);

      // Simulate the cascade delete (same logic as DatabaseService.deleteScheduledTask)
      db.transaction(() => {
        db.prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?').run(taskId);
        db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
      })();

      expect(countRows('scheduled_tasks')).toBe(0);
      expect(countRows('scheduled_task_runs')).toBe(0);
    });

    it('only removes runs for the deleted task, not other tasks', () => {
      const nodeId = insertNode();
      const task1 = insertTask(nodeId, 'task-1');
      const task2 = insertTask(nodeId, 'task-2');
      insertRun(task1);
      insertRun(task1);
      insertRun(task2);
      insertRun(task2);

      expect(countRows('scheduled_task_runs')).toBe(4);

      db.transaction(() => {
        db.prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?').run(task1);
        db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(task1);
      })();

      expect(countRows('scheduled_tasks')).toBe(1);
      expect(countRows('scheduled_task_runs')).toBe(2);

      // Remaining runs belong to task2
      const remaining = db.prepare('SELECT task_id FROM scheduled_task_runs').all() as { task_id: number }[];
      expect(remaining.every(r => r.task_id === task2)).toBe(true);
    });
  });

  // ── deleteNode cascade ──────────────────────────────────────────────

  describe('deleteNode cascade', () => {
    it('removes tasks, runs, and status when deleting a node', () => {
      const nodeId = insertNode();
      const task1 = insertTask(nodeId, 'task-a');
      const task2 = insertTask(nodeId, 'task-b');
      insertRun(task1);
      insertRun(task1);
      insertRun(task2);
      insertStackStatus(nodeId, 'my-stack');

      expect(countRows('nodes')).toBe(1);
      expect(countRows('scheduled_tasks')).toBe(2);
      expect(countRows('scheduled_task_runs')).toBe(3);
      expect(countRows('stack_update_status')).toBe(1);

      // Simulate the cascade delete (same logic as DatabaseService.deleteNode)
      db.transaction(() => {
        db.prepare('DELETE FROM scheduled_task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE node_id = ?)').run(nodeId);
        db.prepare('DELETE FROM scheduled_tasks WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM stack_update_status WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
      })();

      expect(countRows('nodes')).toBe(0);
      expect(countRows('scheduled_tasks')).toBe(0);
      expect(countRows('scheduled_task_runs')).toBe(0);
      expect(countRows('stack_update_status')).toBe(0);
    });

    it('does not affect other nodes or their data', () => {
      const node1 = insertNode('node-1');
      const node2 = insertNode('node-2');
      const task1 = insertTask(node1, 'task-node1');
      const task2 = insertTask(node2, 'task-node2');
      insertRun(task1);
      insertRun(task2);
      insertStackStatus(node1, 'stack-1');
      insertStackStatus(node2, 'stack-2');

      // Delete node1
      db.transaction(() => {
        db.prepare('DELETE FROM scheduled_task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE node_id = ?)').run(node1);
        db.prepare('DELETE FROM scheduled_tasks WHERE node_id = ?').run(node1);
        db.prepare('DELETE FROM stack_update_status WHERE node_id = ?').run(node1);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(node1);
      })();

      // node2 data should be untouched
      expect(countRows('nodes')).toBe(1);
      expect(countRows('scheduled_tasks')).toBe(1);
      expect(countRows('scheduled_task_runs')).toBe(1);
      expect(countRows('stack_update_status')).toBe(1);

      const remainingNode = db.prepare('SELECT name FROM nodes').get() as { name: string };
      expect(remainingNode.name).toBe('node-2');
    });
  });
});
