import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { Express } from 'express';
import request from 'supertest';
import { vi, type MockInstance } from 'vitest';

/** One request the hub client sent, as the node received it. */
export interface InProcessCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  data: unknown;
}

export interface InProcessNodeTransportOptions {
  /** The node's Express app (in a unit test, the same app the hub runs). */
  app: Express;
  /**
   * The bearer the node sees. Direct proxy: the node_proxy token the hub
   * stored for the node. Pilot: the pilot_tunnel token the agent's loopback
   * injects in place of whatever the hub sent.
   */
  bearer: () => string;
  /** Throw to fail the request before the node sees it (a transport error). */
  beforeSend?: (call: InProcessCall) => void;
  /** Throw to lose the node's answer after it was applied (a dropped response). */
  afterAnswer?: (call: InProcessCall, status: number) => void;
}

export interface InProcessNodeTransport {
  calls: InProcessCall[];
  spy: MockInstance;
}

function transportError(message: string): Error {
  return Object.assign(new Error(message), { isAxiosError: true, code: 'ECONNRESET' });
}

/**
 * Route the hub client's real axios requests into a node's Express app
 * through supertest, so the hub's sealing, the node's authentication, the
 * route and the store all run for real. It replaces only the network hop.
 * Restore with `vi.restoreAllMocks()`.
 */
export function installInProcessNodeTransport(options: InProcessNodeTransportOptions): InProcessNodeTransport {
  const calls: InProcessCall[] = [];
  const spy = vi.spyOn(axios, 'request').mockImplementation(async (config: AxiosRequestConfig) => {
    const url = new URL(config.url ?? '');
    const method = (config.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((config.headers ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string' && key.toLowerCase() !== 'authorization') headers[key.toLowerCase()] = value;
    }
    headers.authorization = `Bearer ${options.bearer()}`;
    const call: InProcessCall = { method, path: url.pathname, headers, data: config.data };
    calls.push(call);
    if (options.beforeSend) {
      try {
        options.beforeSend(call);
      } catch (error: unknown) {
        throw transportError(error instanceof Error ? error.message : 'request failed');
      }
    }
    const agent = request(options.app);
    let pending = method === 'POST' ? agent.post(url.pathname)
      : method === 'DELETE' ? agent.delete(url.pathname)
        : agent.get(url.pathname);
    for (const [key, value] of Object.entries(headers)) pending = pending.set(key, value);
    const res = config.data === undefined ? await pending : await pending.send(config.data as object);
    if (options.afterAnswer) {
      try {
        options.afterAnswer(call, res.status);
      } catch (error: unknown) {
        throw transportError(error instanceof Error ? error.message : 'response lost');
      }
    }
    const response: AxiosResponse = {
      status: res.status,
      statusText: '',
      data: res.body as unknown,
      headers: res.headers as AxiosResponse['headers'],
      config: config as AxiosResponse['config'],
    };
    return response;
  });
  return { calls, spy };
}
