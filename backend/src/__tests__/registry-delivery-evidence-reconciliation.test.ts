import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import {
  importRegistryDeliveryEvidencePage,
  listRegistryDeliveryEvidencePage,
  recordRegistryDeliveryEvent,
} from '../helpers/registryDeliveryEvidence';
import { RegistryDeliveryReconciler } from '../services/RegistryDeliveryReconciler';

describe('registry delivery evidence persistence', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryReconciler.resetForTests();
  });

  it('assigns monotonic seq values and pages by cursor', () => {
    const db = DatabaseService.getInstance();
    const deliverySourceId = db.getGlobalSettings().delivery_source_id!;

    recordRegistryDeliveryEvent({
      deliverySourceId,
      eventType: 'swept_local',
      tempDirId: 'local-abc',
    });
    recordRegistryDeliveryEvent({
      deliverySourceId,
      eventType: 'swept_delivered',
      tempDirId: 'delivered-def',
    });

    const page1 = listRegistryDeliveryEvidencePage(deliverySourceId, 0, 1);
    expect(page1.events).toHaveLength(1);
    expect(page1.events[0]?.event_type).toBe('swept_local');
    expect(page1.nextCursor).toBe(page1.events[0]?.seq);

    const page2 = listRegistryDeliveryEvidencePage(deliverySourceId, page1.nextCursor, 10);
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0]?.event_type).toBe('swept_delivered');
  });

  it('imports a page in one transaction and advances the cursor', () => {
    const db = DatabaseService.getInstance();
    const deliverySourceId = db.getGlobalSettings().delivery_source_id!;
    const hubNodeId = 1;
    const beforeSeq = listRegistryDeliveryEvidencePage(deliverySourceId, 0, 1000).nextCursor;

    recordRegistryDeliveryEvent({
      deliverySourceId,
      eventType: 'operation_completed',
      stack: 'demo',
      op: 'stack-deploy',
    });
    const page = listRegistryDeliveryEvidencePage(deliverySourceId, beforeSeq, 10);
    expect(page.events).toHaveLength(1);
    const result = importRegistryDeliveryEvidencePage(hubNodeId, deliverySourceId, page.events);
    expect(result.imported).toBe(1);
    expect(result.lastSeq).toBe(page.events[0]?.seq);
    expect(db.getRegistryDeliveryImportCursor(deliverySourceId)).toBe(page.events[0]?.seq);

    const duplicate = importRegistryDeliveryEvidencePage(hubNodeId, deliverySourceId, page.events);
    expect(duplicate.imported).toBe(0);
  });

  it('keeps the original hub_node_id_snapshot when the same source is re-imported', () => {
    const db = DatabaseService.getInstance();
    const deliverySourceId = db.getGlobalSettings().delivery_source_id!;
    const beforeSeq = listRegistryDeliveryEvidencePage(deliverySourceId, 0, 1000).nextCursor;

    recordRegistryDeliveryEvent({
      deliverySourceId,
      eventType: 'operation_completed',
      stack: 'demo',
      op: 'stack-deploy',
    });
    const page = listRegistryDeliveryEvidencePage(deliverySourceId, beforeSeq, 10);
    expect(page.events).toHaveLength(1);
    importRegistryDeliveryEvidencePage(10, deliverySourceId, page.events);
    importRegistryDeliveryEvidencePage(20, deliverySourceId, page.events);

    const imported = db.getDb().prepare(
      'SELECT hub_node_id_snapshot FROM registry_delivery_imported_events WHERE event_id = ?',
    ).all(page.events[0]!.event_id) as Array<{ hub_node_id_snapshot: number }>;
    expect(imported).toHaveLength(1);
    expect(imported[0]?.hub_node_id_snapshot).toBe(10);
  });

  it('writes a retention_gap event with pruned_through_seq when old rows are pruned', () => {
    const db = DatabaseService.getInstance();
    const deliverySourceId = db.getGlobalSettings().delivery_source_id!;

    const seq = recordRegistryDeliveryEvent({
      deliverySourceId,
      eventType: 'swept_local',
      tempDirId: 'local-old',
    });
    db.getDb().prepare(
      'UPDATE registry_delivery_events SET created_at = ? WHERE seq = ?',
    ).run(Date.now() - (120 * 24 * 60 * 60 * 1000), seq);

    const pruned = db.cleanupOldDeliveryEvents(90);
    expect(pruned).toBe(1);

    const gap = listRegistryDeliveryEvidencePage(deliverySourceId, seq - 1, 10);
    const retention = gap.events.find((event) => event.event_type === 'retention_gap');
    expect(retention?.pruned_through_seq).toBe(seq);
  });
});
