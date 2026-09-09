import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { setupTestDb } from './helpers/setupTestDb';
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

    let resolveProbe: ((value: 'supported' | null) => void) | undefined;
    mockWouldAttempt.mockImplementation(() => new Promise<'supported' | null>((resolve) => {
      resolveProbe = resolve;
    }));

    ensureRegistryDeliveryHopAbortController(req, res);
    const probe = mockWouldAttempt(
      NodeRegistry.getInstance().getDefaultNodeId(),
      'POST',
      '/api/blueprints/apply-local',
    );

    req.emit('aborted');
    resolveProbe?.('supported');

    await probe;
    expect(req.registryDeliveryAbortController?.signal.aborted).toBe(true);
  });

  it('returns aborted from decideRegistryDeliveryProxyHop when disconnected during the probe', async () => {
    const { decideRegistryDeliveryProxyHop } = await import('../helpers/registryDeliveryProxy');
    const { req, res } = mockReqRes();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

    let resolveProbe: ((value: 'supported' | null) => void) | undefined;
    mockWouldAttempt.mockImplementation(() => new Promise<'supported' | null>((resolve) => {
      resolveProbe = resolve;
    }));

    const decision = decideRegistryDeliveryProxyHop(
      req,
      res,
      nodeId,
      'POST',
      '/api/blueprints/apply-local',
    );

    req.emit('aborted');
    resolveProbe?.('supported');

    await expect(decision).resolves.toEqual({ action: 'aborted' });
  });

  it('maps aborted decisions to stop at the proxy gate', async () => {
    const { evaluateRegistryDeliveryProxyGate } = await import('../helpers/registryDeliveryProxy');
    const { req, res } = mockReqRes();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

    Object.defineProperty(req, 'aborted', { value: true, configurable: true });

    await expect(
      evaluateRegistryDeliveryProxyGate(
        req,
        res,
        nodeId,
        'POST',
        '/api/blueprints/apply-local',
      ),
    ).resolves.toEqual({ outcome: 'stop' });
  });

  it('maps capability miss to continue at the proxy gate', async () => {
    const { evaluateRegistryDeliveryProxyGate } = await import('../helpers/registryDeliveryProxy');
    const { req, res } = mockReqRes();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

    mockWouldAttempt.mockResolvedValue('unsupported');

    await expect(
      evaluateRegistryDeliveryProxyGate(
        req,
        res,
        nodeId,
        'POST',
        '/api/blueprints/apply-local',
      ),
    ).resolves.toEqual({ outcome: 'continue' });
  });

  it('maps a supported probe to run-delivery carrying the probe', async () => {
    const { evaluateRegistryDeliveryProxyGate } = await import('../helpers/registryDeliveryProxy');
    const { req, res } = mockReqRes();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

    mockWouldAttempt.mockResolvedValue('supported');

    await expect(
      evaluateRegistryDeliveryProxyGate(
        req,
        res,
        nodeId,
        'POST',
        '/api/blueprints/apply-local',
      ),
    ).resolves.toEqual({ outcome: 'run-delivery', probe: 'supported' });
  });
});
