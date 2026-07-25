/**
 * Unit tests for the §5 per-service reduction pure functions:
 * reduceServiceStatus, aggregateServiceCheckStatus, and
 * buildAvailabilityNotifyMessage. These operate on plain data (an
 * imageUpdateMap and a prior per-service snapshot), so they are tested
 * directly without mocking DatabaseService, Docker, or Compose.
 */
import { describe, it, expect } from 'vitest';
import {
  reduceServiceStatus,
  aggregateServiceCheckStatus,
  buildAvailabilityNotifyMessage,
  type ImageCheckResult,
} from '../services/ImageUpdateService';
import type { StackServiceStatus } from '../services/DatabaseService';

function ok(hasUpdate: boolean): ImageCheckResult {
  return { hasUpdate, checkStatus: 'ok', digestUpdate: hasUpdate, tagUpdate: false };
}
function errored(message: string): ImageCheckResult {
  return { hasUpdate: false, checkStatus: 'failed', error: message };
}
function notCheckable(): ImageCheckResult {
  return { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };
}
function partial(message: string, hasUpdate = false): ImageCheckResult {
  return { hasUpdate, checkStatus: 'partial', error: message };
}

describe('reduceServiceStatus', () => {
  it('marks a service not_checkable when it has no checkable ref (STATUS-NOT-CHECKABLE-3)', () => {
    const map = new Map([['app:latest', notCheckable()]]);
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('app', 'app:latest', [], map, undefined);
    expect(status).toEqual({ service: 'app', image: 'app:latest', hasUpdate: false, checkStatus: 'not_checkable', lastError: null });
    expect(confirmedUpdateThisRun).toBe(false);
  });

  it('marks a service not_checkable when it declares no image and has no running container', () => {
    const map = new Map<string, ImageCheckResult>();
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('worker', null, [], map, undefined);
    expect(status).toEqual({ service: 'worker', image: null, hasUpdate: false, checkStatus: 'not_checkable', lastError: null });
    expect(confirmedUpdateThisRun).toBe(false);
  });

  it('reports ok + hasUpdate=true when every checkable ref succeeds and one confirms an update', () => {
    const map = new Map([['app:latest', ok(true)]]);
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('app', 'app:latest', [], map, undefined);
    expect(status).toEqual({ service: 'app', image: 'app:latest', hasUpdate: true, checkStatus: 'ok', lastError: null });
    expect(confirmedUpdateThisRun).toBe(true);
  });

  it('reports ok + hasUpdate=false when every checkable ref succeeds with no update', () => {
    const map = new Map([['app:latest', ok(false)]]);
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('app', 'app:latest', [], map, undefined);
    expect(status.checkStatus).toBe('ok');
    expect(status.hasUpdate).toBe(false);
    expect(confirmedUpdateThisRun).toBe(false);
  });

  it('STATUS-CONFIRMATION-PARTIAL-5: one newly outdated success + one error -> partial, hasUpdate=true, confirmedUpdateThisRun=true', () => {
    // Two refs on the same declared service (declared image + a divergent runtime image).
    const map = new Map([
      ['app:latest', ok(true)],
      ['app:1.2.3', errored('Registry unreachable for app:1.2.3')],
    ]);
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('app', 'app:latest', ['app:1.2.3'], map, undefined);
    expect(status.checkStatus).toBe('partial');
    expect(status.hasUpdate).toBe(true);
    expect(status.lastError).toBe('Registry unreachable for app:1.2.3');
    expect(confirmedUpdateThisRun).toBe(true);
  });

  it('partial with only a preserved prior (no successful outdated check this run) -> confirmedUpdateThisRun=false', () => {
    const map = new Map([
      ['app:latest', ok(false)], // succeeds, but reports no update
      ['app:1.2.3', errored('timeout')],
    ]);
    const prior: StackServiceStatus = { service: 'app', image: 'app:latest', hasUpdate: true, checkStatus: 'ok', lastError: null };
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('app', 'app:latest', ['app:1.2.3'], map, prior);
    expect(status.checkStatus).toBe('partial');
    expect(status.hasUpdate).toBe(true); // preserved from prior, not newly confirmed
    expect(confirmedUpdateThisRun).toBe(false);
  });

  it('all checkable refs erroring -> failed, preserves prior hasUpdate, confirmedUpdateThisRun=false', () => {
    const map = new Map([['app:latest', errored('Registry unreachable')]]);
    const prior: StackServiceStatus = { service: 'app', image: 'app:latest', hasUpdate: true, checkStatus: 'ok', lastError: null };
    const { status, confirmedUpdateThisRun } = reduceServiceStatus('app', 'app:latest', [], map, prior);
    expect(status).toEqual({ service: 'app', image: 'app:latest', hasUpdate: true, checkStatus: 'failed', lastError: 'Registry unreachable' });
    expect(confirmedUpdateThisRun).toBe(false);
  });

  it('all checkable refs erroring with no prior row -> failed, hasUpdate=false', () => {
    const map = new Map([['app:latest', errored('boom')]]);
    const { status } = reduceServiceStatus('app', 'app:latest', [], map, undefined);
    expect(status.hasUpdate).toBe(false);
    expect(status.checkStatus).toBe('failed');
  });

  it('a shared image gets the same check result on every declared service that references it', () => {
    const map = new Map([['shared:latest', ok(true)]]);
    const web = reduceServiceStatus('web', 'shared:latest', [], map, undefined);
    const worker = reduceServiceStatus('worker', 'shared:latest', [], map, undefined);
    expect(web.status.hasUpdate).toBe(true);
    expect(worker.status.hasUpdate).toBe(true);
    expect(web.status.checkStatus).toBe(worker.status.checkStatus);
  });

  it('records sorted, deduplicated runtimeImages only when a runtime container was observed', () => {
    const map = new Map([['app:latest', ok(false)], ['app:1.0', ok(false)]]);
    const withRuntime = reduceServiceStatus('app', 'app:latest', ['app:1.0', 'app:1.0'], map, undefined);
    expect(withRuntime.status.runtimeImages).toEqual(['app:1.0']);

    const noRuntime = reduceServiceStatus('app', 'app:latest', [], map, undefined);
    expect(noRuntime.status.runtimeImages).toBeUndefined();
  });
});

describe('aggregateServiceCheckStatus', () => {
  const svc = (checkStatus: StackServiceStatus['checkStatus'], hasUpdate = false): StackServiceStatus => ({
    service: `svc-${checkStatus}-${hasUpdate}`, image: null, hasUpdate, checkStatus, lastError: null,
  });

  it('is ok for an empty services array (empty effective model)', () => {
    expect(aggregateServiceCheckStatus([])).toBe('ok');
  });

  it('is ok when every service is not_checkable (nothing checkable)', () => {
    expect(aggregateServiceCheckStatus([svc('not_checkable'), svc('not_checkable')])).toBe('ok');
  });

  it('is ok when every checkable service succeeded', () => {
    expect(aggregateServiceCheckStatus([svc('ok'), svc('ok'), svc('not_checkable')])).toBe('ok');
  });

  it('is failed when every checkable service failed, even with a preserved hasUpdate=true', () => {
    expect(aggregateServiceCheckStatus([svc('failed', true), svc('failed', true)])).toBe('failed');
  });

  it('is partial when checkable services mix ok and failed', () => {
    expect(aggregateServiceCheckStatus([svc('ok'), svc('failed')])).toBe('partial');
  });

  it('is partial when a checkable service is itself partial', () => {
    expect(aggregateServiceCheckStatus([svc('ok'), svc('partial')])).toBe('partial');
  });

  it('is not failed when only some (not all) checkable services failed', () => {
    expect(aggregateServiceCheckStatus([svc('ok'), svc('failed'), svc('not_checkable')])).not.toBe('failed');
  });
});

describe('aggregate invariant: has_update === services.some(hasUpdate)', () => {
  it('holds for an empty services array', () => {
    const services: StackServiceStatus[] = [];
    expect(services.some(s => s.hasUpdate)).toBe(false);
  });

  it('holds when every checkable service failed but one preserves hasUpdate=true', () => {
    const map = new Map([['app:latest', errored('unreachable')]]);
    const prior: StackServiceStatus = { service: 'app', image: 'app:latest', hasUpdate: true, checkStatus: 'ok', lastError: null };
    const { status } = reduceServiceStatus('app', 'app:latest', [], map, prior);
    const services = [status];
    expect(services.some(s => s.hasUpdate)).toBe(true);
    expect(aggregateServiceCheckStatus(services)).toBe('failed');
  });

  it('holds when one service confirms an update and a sibling service fails outright', () => {
    const map = new Map([
      ['web:latest', ok(true)],
      ['worker:latest', errored('timeout')],
    ]);
    const web = reduceServiceStatus('web', 'web:latest', [], map, undefined);
    const worker = reduceServiceStatus('worker', 'worker:latest', [], map, undefined);
    const services = [web.status, worker.status];
    // web confirmed an update; worker's sole ref errored, so worker alone is 'failed'.
    expect(services.some(s => s.hasUpdate)).toBe(true);
    expect(worker.status.checkStatus).toBe('failed');
    // At the stack level, one ok service and one failed service is a mix, not a unanimous failure.
    expect(aggregateServiceCheckStatus(services)).toBe('partial');
  });
});

describe('buildAvailabilityNotifyMessage', () => {
  it('uses the generic line for a single-service (or model-unavailable) stack', () => {
    expect(buildAvailabilityNotifyMessage('stackA', [])).toBe('Stack "stackA" has image updates available.');
    const single: StackServiceStatus[] = [{ service: 'app', image: 'app:latest', hasUpdate: true, checkStatus: 'ok', lastError: null }];
    expect(buildAvailabilityNotifyMessage('stackA', single)).toBe('Stack "stackA" has image updates available.');
  });

  it('names sorted services with hasUpdate for a multi-service stack', () => {
    const services: StackServiceStatus[] = [
      { service: 'worker', image: 'worker:latest', hasUpdate: true, checkStatus: 'ok', lastError: null },
      { service: 'api', image: 'api:latest', hasUpdate: true, checkStatus: 'ok', lastError: null },
      { service: 'db', image: 'db:latest', hasUpdate: false, checkStatus: 'ok', lastError: null },
    ];
    expect(buildAvailabilityNotifyMessage('stackA', services)).toBe('Stack "stackA" has image updates available for services: api, worker.');
  });

  it('falls back to the generic line for a multi-service stack with no service currently showing hasUpdate', () => {
    const services: StackServiceStatus[] = [
      { service: 'api', image: 'api:latest', hasUpdate: false, checkStatus: 'ok', lastError: null },
      { service: 'db', image: 'db:latest', hasUpdate: false, checkStatus: 'ok', lastError: null },
    ];
    expect(buildAvailabilityNotifyMessage('stackA', services)).toBe('Stack "stackA" has image updates available.');
  });

  it('uses singular wording for exactly one named service', () => {
    const services: StackServiceStatus[] = [
      { service: 'api', image: 'api:latest', hasUpdate: true, checkStatus: 'ok', lastError: null },
      { service: 'db', image: 'db:latest', hasUpdate: false, checkStatus: 'ok', lastError: null },
    ];
    expect(buildAvailabilityNotifyMessage('stackA', services)).toBe('Stack "stackA" has image updates available for service: api.');
  });
});
