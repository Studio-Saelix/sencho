import axios from 'axios';

import {
  importRegistryDeliveryEvidencePage,
} from '../helpers/registryDeliveryEvidence';
import type { RegistryDeliveryEvidencePage } from '../types/registryDeliveryEvidence';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { DatabaseService } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import { PilotTunnelManager } from './PilotTunnelManager';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_INITIAL_DELAY_MS = 30_000;
const EVIDENCE_PAGE_LIMIT = 100;
const NODE_FAILURE_BACKOFF_MS = 15 * 60 * 1000;

interface NodeBackoffState {
  until: number;
  failures: number;
}

export class RegistryDeliveryReconciler {
  private static instance: RegistryDeliveryReconciler | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly nodeBackoff = new Map<number, NodeBackoffState>();
  private readonly lastSourceIdByNode = new Map<number, string>();

  static getInstance(): RegistryDeliveryReconciler {
    if (!this.instance) this.instance = new RegistryDeliveryReconciler();
    return this.instance;
  }

  static resetForTests(): void {
    this.instance?.stop();
    this.instance = null;
  }

  private constructor() { /* singleton */ }

  start(): void {
    if (this.intervalHandle || this.initialTimer) return;
    this.stopped = false;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (this.stopped) return;
      void this.tick();
      this.intervalHandle = setInterval(() => void this.tick(), RECONCILE_INTERVAL_MS);
      if (typeof this.intervalHandle.unref === 'function') {
        this.intervalHandle.unref();
      }
    }, RECONCILE_INITIAL_DELAY_MS);
    if (typeof this.initialTimer.unref === 'function') {
      this.initialTimer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const nodes = DatabaseService.getInstance().getNodes()
        .filter((node) => node.type === 'remote');
      for (const node of nodes) {
        if (node.mode === 'pilot_agent' && !PilotTunnelManager.getInstance().hasActiveTunnel(node.id!)) {
          continue;
        }
        await this.reconcileNode(node.id!);
      }
    } finally {
      this.running = false;
    }
  }

  async reconcileNode(nodeId: number): Promise<void> {
    const backoff = this.nodeBackoff.get(nodeId);
    if (backoff && Date.now() < backoff.until) {
      return;
    }

    const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
    if (!target) {
      this.markNodeFailure(nodeId);
      return;
    }

    try {
      let deliverySourceId = this.lastSourceIdByNode.get(nodeId);
      let cursor = deliverySourceId
        ? DatabaseService.getInstance().getRegistryDeliveryImportCursor(deliverySourceId)
        : 0;
      let pages = 0;

      while (pages < 50) {
        const page = await this.fetchEvidencePage(target, cursor, EVIDENCE_PAGE_LIMIT);
        deliverySourceId = page.deliverySourceId;
        this.lastSourceIdByNode.set(nodeId, deliverySourceId);
        if (page.events.length === 0) {
          break;
        }

        const hubNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        importRegistryDeliveryEvidencePage(hubNodeId, deliverySourceId, page.events);

        cursor = page.nextCursor;
        pages += 1;
        if (page.events.length < EVIDENCE_PAGE_LIMIT) {
          break;
        }
      }

      this.nodeBackoff.delete(nodeId);
      if (isDebugEnabled() && deliverySourceId) {
        console.log(
          `[RegistryDeliveryReconciler:diag] imported evidence from node ${nodeId} source=${deliverySourceId} cursor=${cursor}`,
        );
      }
    } catch (error) {
      this.markNodeFailure(nodeId);
      console.warn(
        `[RegistryDeliveryReconciler] evidence import failed for node ${nodeId}:`,
        getErrorMessage(error, 'unknown'),
      );
    }
  }

  private async fetchEvidencePage(
    target: { apiUrl: string; apiToken: string },
    cursor: number,
    limit: number,
  ): Promise<RegistryDeliveryEvidencePage> {
    const base = target.apiUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (target.apiToken) {
      headers.Authorization = `Bearer ${target.apiToken}`;
    }

    const res = await axios.get(`${base}/api/registry-delivery/evidence`, {
      headers,
      params: { cursor, limit },
      timeout: 30_000,
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      const message = typeof res.data?.error === 'string'
        ? res.data.error
        : 'Registry delivery evidence fetch failed';
      throw Object.assign(new Error(message), { status: res.status });
    }

    return res.data as RegistryDeliveryEvidencePage;
  }

  private markNodeFailure(nodeId: number): void {
    const existing = this.nodeBackoff.get(nodeId);
    const failures = (existing?.failures ?? 0) + 1;
    const backoffMs = Math.min(NODE_FAILURE_BACKOFF_MS * failures, 60 * 60 * 1000);
    this.nodeBackoff.set(nodeId, {
      failures,
      until: Date.now() + backoffMs,
    });
  }
}
