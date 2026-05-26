/**
 * Integration tests for DatabaseService metrics, cleanup, notification cap,
 * and stack alert CRUD. Uses a real temp SQLite database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: any;
let db: any;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  DatabaseService = (await import('../services/DatabaseService')).DatabaseService;
  db = DatabaseService.getInstance();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('DatabaseService - container metrics', () => {
  it('stores and retrieves a metric', () => {
    const now = Date.now();
    db.addContainerMetric({
      container_id: 'abc123',
      stack_name: 'test-stack',
      cpu_percent: 42.5,
      memory_mb: 256,
      net_rx_mb: 1.2,
      net_tx_mb: 0.8,
      timestamp: now,
    });

    const metrics = db.getContainerMetrics(1);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const found = metrics.find((m: any) => m.container_id === 'abc123');
    expect(found).toBeDefined();
    expect(found.stack_name).toBe('test-stack');
    expect(found.cpu_percent).toBeCloseTo(42.5, 0);
  });

  it('aggregates metrics into minute buckets', () => {
    const baseTime = Math.floor(Date.now() / 60000) * 60000; // floor to minute start
    // Insert two metrics within the same minute
    db.addContainerMetric({
      container_id: 'bucket-test',
      stack_name: 'bucket-stack',
      cpu_percent: 20,
      memory_mb: 100,
      net_rx_mb: 1,
      net_tx_mb: 2,
      timestamp: baseTime,
    });
    db.addContainerMetric({
      container_id: 'bucket-test',
      stack_name: 'bucket-stack',
      cpu_percent: 40,
      memory_mb: 200,
      net_rx_mb: 3,
      net_tx_mb: 4,
      timestamp: baseTime + 5000, // 5 seconds later, same minute bucket
    });

    const metrics = db.getContainerMetrics(1);
    const bucketMetrics = metrics.filter((m: any) => m.container_id === 'bucket-test');
    // Should be aggregated into 1 bucket (same minute)
    expect(bucketMetrics.length).toBe(1);
    // CPU and memory are averaged
    expect(bucketMetrics[0].cpu_percent).toBeCloseTo(30, 0);
    expect(bucketMetrics[0].memory_mb).toBeCloseTo(150, 0);
    // Network uses MAX
    expect(bucketMetrics[0].net_rx_mb).toBeCloseTo(3, 0);
    expect(bucketMetrics[0].net_tx_mb).toBeCloseTo(4, 0);
  });

  it('filters out metrics older than hoursLookback', () => {
    const oldTimestamp = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
    db.addContainerMetric({
      container_id: 'old-container',
      stack_name: 'old-stack',
      cpu_percent: 10,
      memory_mb: 50,
      net_rx_mb: 0.1,
      net_tx_mb: 0.1,
      timestamp: oldTimestamp,
    });

    // Look back only 1 hour — should not find it
    const recent = db.getContainerMetrics(1);
    const found = recent.find((m: any) => m.container_id === 'old-container');
    expect(found).toBeUndefined();

    // Look back 4 hours — should find it
    const wider = db.getContainerMetrics(4);
    const foundWider = wider.find((m: any) => m.container_id === 'old-container');
    expect(foundWider).toBeDefined();
  });

  it('handles multiple containers in the same stack', () => {
    const now = Date.now();
    db.addContainerMetric({
      container_id: 'multi-1',
      stack_name: 'multi-stack',
      cpu_percent: 10,
      memory_mb: 100,
      net_rx_mb: 1,
      net_tx_mb: 1,
      timestamp: now,
    });
    db.addContainerMetric({
      container_id: 'multi-2',
      stack_name: 'multi-stack',
      cpu_percent: 20,
      memory_mb: 200,
      net_rx_mb: 2,
      net_tx_mb: 2,
      timestamp: now,
    });

    const metrics = db.getContainerMetrics(1);
    const stackMetrics = metrics.filter((m: any) => m.stack_name === 'multi-stack');
    // Two distinct containers, so two rows (different container_id in GROUP BY)
    expect(stackMetrics.length).toBe(2);
  });
});

describe('DatabaseService - cleanupOldMetrics', () => {
  it('deletes metrics older than specified hours', () => {
    const oldTimestamp = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
    db.addContainerMetric({
      container_id: 'cleanup-target',
      stack_name: 'cleanup-stack',
      cpu_percent: 5,
      memory_mb: 32,
      net_rx_mb: 0,
      net_tx_mb: 0,
      timestamp: oldTimestamp,
    });

    db.cleanupOldMetrics(24);

    const all = db.getContainerMetrics(72);
    const found = all.find((m: any) => m.container_id === 'cleanup-target');
    expect(found).toBeUndefined();
  });

  it('retains metrics within the retention window', () => {
    const recentTimestamp = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
    db.addContainerMetric({
      container_id: 'keep-me',
      stack_name: 'keep-stack',
      cpu_percent: 15,
      memory_mb: 64,
      net_rx_mb: 0.5,
      net_tx_mb: 0.5,
      timestamp: recentTimestamp,
    });

    db.cleanupOldMetrics(24);

    const metrics = db.getContainerMetrics(24);
    const found = metrics.find((m: any) => m.container_id === 'keep-me');
    expect(found).toBeDefined();
  });
});

describe('DatabaseService - cleanupOldNotifications', () => {
  it('deletes notifications older than specified days and retains recent ones', () => {
    const oldTimestamp = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const recentTimestamp = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago

    db.addNotificationHistory(0, { level: 'info', message: 'old notification', timestamp: oldTimestamp });
    db.addNotificationHistory(0, { level: 'info', message: 'recent notification', timestamp: recentTimestamp });

    db.cleanupOldNotifications(30);

    const history = db.getNotificationHistory(0, 200);
    const old = history.find((n: any) => n.message === 'old notification');
    const recent = history.find((n: any) => n.message === 'recent notification');
    expect(old).toBeUndefined();
    expect(recent).toBeDefined();
  });
});

describe('DatabaseService - cleanupOldAuditLogs', () => {
  it('deletes audit logs older than specified days and retains recent ones', () => {
    const oldTimestamp = Date.now() - 120 * 24 * 60 * 60 * 1000; // 120 days ago
    const recentTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago

    db.insertAuditLog({
      timestamp: oldTimestamp,
      username: 'admin',
      method: 'GET',
      path: '/api/old',
      status_code: 200,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: 'old audit entry',
    });
    db.insertAuditLog({
      timestamp: recentTimestamp,
      username: 'admin',
      method: 'POST',
      path: '/api/recent',
      status_code: 200,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: 'recent audit entry',
    });

    db.cleanupOldAuditLogs(90);

    const { entries } = db.getAuditLogs({ limit: 200, offset: 0 });
    const old = entries.find((e: any) => e.summary === 'old audit entry');
    const recent = entries.find((e: any) => e.summary === 'recent audit entry');
    expect(old).toBeUndefined();
    expect(recent).toBeDefined();
  });
});

describe('DatabaseService - notification history cap (periodic)', () => {
  it('does not prune on insert; periodic cleanup caps per (node, stack)', () => {
    db.deleteAllNotifications(0);

    // A chatty stack writes 600 events.
    const base = Date.now();
    for (let i = 0; i < 600; i++) {
      db.addNotificationHistory(0, {
        level: 'info',
        message: `chatty-${i}`,
        timestamp: base + i,
        stack_name: 'chatty',
      });
    }
    // A quiet stack writes 3 events long before the chatty burst.
    for (let i = 0; i < 3; i++) {
      db.addNotificationHistory(0, {
        level: 'info',
        message: `quiet-${i}`,
        timestamp: base - 10_000 + i,
        stack_name: 'quiet',
      });
    }

    // No per-insert prune: every row is present.
    const beforeCleanup = db.getNotificationHistory(0, 2000);
    expect(beforeCleanup.length).toBe(603);

    db.cleanupOldNotifications(30, { perStackCap: 500, perNodeUnattachedCap: 1000 });

    const after = db.getNotificationHistory(0, 2000);
    const chatty = after.filter((n: any) => n.stack_name === 'chatty');
    const quiet = after.filter((n: any) => n.stack_name === 'quiet');
    expect(chatty.length).toBe(500);
    // Quiet stack is untouched even though chatty is far noisier.
    expect(quiet.length).toBe(3);
  });

  it('caps per-node events without a stack_name', () => {
    db.deleteAllNotifications(0);

    const base = Date.now();
    for (let i = 0; i < 1200; i++) {
      db.addNotificationHistory(0, {
        level: 'info',
        message: `system-${i}`,
        timestamp: base + i,
      });
    }

    db.cleanupOldNotifications(30, { perStackCap: 500, perNodeUnattachedCap: 1000 });

    const all = db.getNotificationHistory(0, 2000);
    const unattached = all.filter((n: any) => !n.stack_name);
    expect(unattached.length).toBe(1000);
  });

  it('keeps the newest entries per (node, stack) after periodic cap', () => {
    db.deleteAllNotifications(0);
    const base = Date.now();
    for (let i = 0; i < 600; i++) {
      db.addNotificationHistory(0, {
        level: 'info',
        message: `ordered-${i}`,
        timestamp: base + i * 10,
        stack_name: 'ordered',
      });
    }

    db.cleanupOldNotifications(30, { perStackCap: 500, perNodeUnattachedCap: 1000 });

    const after = db.getNotificationHistory(0, 2000);
    const ordered = after.filter((n: any) => n.stack_name === 'ordered');
    expect(ordered.length).toBe(500);
    // Newest 500 survive; oldest 100 are gone.
    expect(ordered.find((n: any) => n.message === 'ordered-0')).toBeUndefined();
    expect(ordered.find((n: any) => n.message === 'ordered-599')).toBeDefined();
  });

  it('uses safe defaults when called with only the retention argument', () => {
    db.deleteAllNotifications(0);
    const base = Date.now();
    for (let i = 0; i < 600; i++) {
      db.addNotificationHistory(0, { level: 'info', message: `d-${i}`, timestamp: base + i, stack_name: 'default' });
    }
    // Production caller (MonitorService) only passes daysToKeep; the cap defaults must enforce the per-stack 500 limit.
    const summary = db.cleanupOldNotifications(30);
    const after = db.getNotificationHistory(0, 2000).filter((n: any) => n.stack_name === 'default');
    expect(after.length).toBe(500);
    expect(summary.perStack).toBe(100);
  });
});

describe('DatabaseService - stack alerts CRUD', () => {
  it('adds and retrieves stack alerts', () => {
    db.addStackAlert({
      stack_name: 'alert-stack',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 5,
      cooldown_mins: 15,
    });

    const alerts = db.getStackAlerts();
    const found = alerts.find((a: any) => a.stack_name === 'alert-stack');
    expect(found).toBeDefined();
    expect(found.metric).toBe('cpu_percent');
    expect(found.operator).toBe('>');
    expect(found.threshold).toBe(80);
    expect(found.duration_mins).toBe(5);
    expect(found.cooldown_mins).toBe(15);
  });

  it('filters alerts by stack name', () => {
    db.addStackAlert({
      stack_name: 'filter-stack-a',
      metric: 'memory_mb',
      operator: '>=',
      threshold: 512,
      duration_mins: 1,
      cooldown_mins: 10,
    });
    db.addStackAlert({
      stack_name: 'filter-stack-b',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 90,
      duration_mins: 2,
      cooldown_mins: 5,
    });

    const alertsA = db.getStackAlerts('filter-stack-a');
    expect(alertsA.length).toBe(1);
    expect(alertsA[0].stack_name).toBe('filter-stack-a');

    const alertsB = db.getStackAlerts('filter-stack-b');
    expect(alertsB.length).toBe(1);
    expect(alertsB[0].stack_name).toBe('filter-stack-b');
  });

  it('updates last_fired_at timestamp', () => {
    db.addStackAlert({
      stack_name: 'fired-stack',
      metric: 'net_rx',
      operator: '>',
      threshold: 100,
      duration_mins: 1,
      cooldown_mins: 30,
    });

    const alerts = db.getStackAlerts('fired-stack');
    const alert = alerts[0];
    const fireTime = Date.now();
    db.updateStackAlertLastFired(alert.id, fireTime);

    const updated = db.getStackAlerts('fired-stack');
    expect(updated[0].last_fired_at).toBe(fireTime);
  });

  it('deletes an alert by id', () => {
    db.addStackAlert({
      stack_name: 'delete-stack',
      metric: 'memory_percent',
      operator: '>',
      threshold: 95,
      duration_mins: 1,
      cooldown_mins: 5,
    });

    const before = db.getStackAlerts('delete-stack');
    expect(before.length).toBe(1);

    db.deleteStackAlert(before[0].id);

    const after = db.getStackAlerts('delete-stack');
    expect(after.length).toBe(0);
  });
});

describe('DatabaseService - stress tests', () => {
  it('handles 1000+ metrics and cleanup bounds growth', () => {
    const now = Date.now();

    // Insert 1200 metrics spread across 2 hours in a single transaction.
    // Individual auto-committed inserts trigger a disk fsync each, making
    // 1200 separate calls impractically slow on spinning disks and Windows.
    const metrics = Array.from({ length: 1200 }, (_, i) => ({
      container_id: `stress-container-${i % 10}`,
      stack_name: 'stress-stack',
      cpu_percent: Math.random() * 100,
      memory_mb: Math.random() * 1024,
      net_rx_mb: Math.random() * 10,
      net_tx_mb: Math.random() * 10,
      timestamp: now - (i * 6000), // Every 6 seconds over ~2 hours
    }));
    db.bulkAddContainerMetrics(metrics);

    // Cleanup with 1 hour retention
    db.cleanupOldMetrics(1);

    // Only metrics from last hour should remain (600 entries = 1 hour / 6 seconds)
    const remaining = db.getContainerMetrics(2);
    // Aggregated into minute buckets, so much fewer than 600
    expect(remaining.length).toBeLessThan(700);
    // But should still have data from the retained window
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('aggregation remains correct at scale', () => {
    const now = Date.now();
    const minuteBase = Math.floor(now / 60000) * 60000; // Start of current minute

    // Insert 50 metrics in the same minute for one container
    for (let i = 0; i < 50; i++) {
      db.addContainerMetric({
        container_id: 'agg-stress',
        stack_name: 'agg-stack',
        cpu_percent: 50, // Constant value so average should be 50
        memory_mb: 256,
        net_rx_mb: i, // Increasing, MAX should be 49
        net_tx_mb: 0,
        timestamp: minuteBase + i * 100,
      });
    }

    const metrics = db.getContainerMetrics(1);
    const aggMetrics = metrics.filter((m: any) => m.container_id === 'agg-stress');
    expect(aggMetrics.length).toBe(1); // All in one minute bucket
    expect(aggMetrics[0].cpu_percent).toBeCloseTo(50, 0);
    expect(aggMetrics[0].memory_mb).toBeCloseTo(256, 0);
    expect(aggMetrics[0].net_rx_mb).toBe(49);
  });
});
