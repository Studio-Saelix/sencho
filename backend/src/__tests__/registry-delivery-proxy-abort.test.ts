import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { setupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';

const mockWouldAttempt = vi.fn();

vi.mock('../helpers/registryDeliveryOutbound', () => ({
  wouldAttemptRegistryDelivery: (...args: unknown[]) => mockWouldAttempt(...args),
}));

describe('registry delivery proxy hop abort', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  function mockReqRes(): { req: Request; res: Response } {
    const req = new EventEmitter() as Request;
    const res = new EventEmitter() as Response;
    Object.defineProperty(res, 'writableEnded', { value: false, writable: true });
    return { req, res };
  }

  it('aborts the hop signal when the client disconnects during capability probing', async () => {
    const { ensureRegistryDeliveryHopAbortController } = await import('../helpers/registryDeliveryProxy');
    const { req, res } = mockReqRes();

    let resolveProbe: ((value: boolean) => void) | undefined;
    mockWouldAttempt.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    }));

    ensureRegistryDeliveryHopAbortController(req, res);
    const probe = mockWouldAttempt(
      NodeRegistry.getInstance().getDefaultNodeId(),
      DatabaseService.getInstance().getNode(NodeRegistry.getInstance().getDefaultNodeId())!,
      'POST',
      '/api/blueprints/apply-local',
    );

    req.emit('aborted');
    resolveProbe?.(true);

    await probe;
    expect(req.registryDeliveryAbortController?.signal.aborted).toBe(true);
  });

  it('returns false from shouldAttemptRegistryDeliveryProxyHop when aborted before probe completes', async () => {
    const { shouldAttemptRegistryDeliveryProxyHop } = await import('../helpers/registryDeliveryProxy');
    const { req, res } = mockReqRes();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    let resolveProbe: ((value: boolean) => void) | undefined;
    mockWouldAttempt.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    }));

    const decision = shouldAttemptRegistryDeliveryProxyHop(
      req,
      res,
      nodeId,
      node,
      'POST',
      '/api/blueprints/apply-local',
    );

    req.emit('aborted');
    resolveProbe?.(true);

    await expect(decision).resolves.toBe(false);
  });
});
