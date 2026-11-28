import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { Express } from 'express';
import request from 'supertest';
import { vi, type MockInstance } from 'vitest';

/** One request the hub client sent, as the node received it. */
export interface InProcessCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The Authorization header the hub client sent, before the transport swapped in the node-side bearer. */
  sentAuthorization: string | null;
  data: unknown;
  /** The node's answer, once it arrived. */
  response?: { status: number; body: unknown };
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
  /**
   * Throw (or reject) to fail the request before the node sees it (a transport
   * error); return a promise to hold the request until it settles.
   */
  beforeSend?: (call: InProcessCall) => void | Promise<void>;
  /** Throw to lose the node's answer after it was applied (a dropped response). */
  afterAnswer?: (call: InProcessCall, status: number) => void;
  /**
   * Answer in place of the node (a bridge or proxy that answered on its own, or
   * an older node without the route). Return undefined to let the node answer.
   */
  respond?: (call: InProcessCall) => { status: number; body: unknown } | undefined;
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
    let sentAuthorization: string | null = null;
    for (const [key, value] of Object.entries((config.headers ?? {}) as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      if (key.toLowerCase() === 'authorization') sentAuthorization = value;
      else headers[key.toLowerCase()] = value;
    }
    headers.authorization = `Bearer ${options.bearer()}`;
    const call: InProcessCall = { method, path: url.pathname, headers, sentAuthorization, data: config.data };
    calls.push(call);
    if (options.beforeSend) {
      try {
        await options.beforeSend(call);
      } catch (error: unknown) {
        throw transportError(error instanceof Error ? error.message : 'request failed');
      }
    }
    const scripted = options.respond?.(call);
    if (scripted) {
      call.response = scripted;
      return {
        status: scripted.status,
        statusText: '',
        data: scripted.body,
        headers: {},
        config: config as AxiosResponse['config'],
      } as AxiosResponse;
    }
    const agent = request(options.app);
    let pending = method === 'POST' ? agent.post(url.pathname)
      : method === 'DELETE' ? agent.delete(url.pathname)
        : agent.get(url.pathname);
    for (const [key, value] of Object.entries(headers)) pending = pending.set(key, value);
    const res = config.data === undefined ? await pending : await pending.send(config.data as object);
    call.response = { status: res.status, body: res.body as unknown };
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
