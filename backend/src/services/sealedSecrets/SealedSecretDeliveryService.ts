import crypto from 'crypto';
import axios from 'axios';

import { fingerprintOf, getOrCreateSealingKey, parseSealingKeyBase64 } from '../../helpers/registryEnvelopeSeal';
import { isResolvedTargetConfidential } from '../../helpers/registryDeliveryOutbound';
import { probeRemoteCapability } from '../../helpers/remoteCapabilities';
import { sealSecret } from '../../helpers/sealedSecretSeal';
import { getErrorMessage } from '../../utils/errors';
import { safeAxiosTransport } from '../../utils/outboundTarget';
import { sanitizeForLog } from '../../utils/safeLog';
import { SEALED_SECRET_DELIVERY_V1_CAPABILITY } from '../CapabilityRegistry';
import { DatabaseService, type NodeSealingPin, type SealedSecretDeliveryRow } from '../DatabaseService';
import { NodeRegistry, type ProxyTarget } from '../NodeRegistry';
import { recordSealedSecretAudit } from './audit';
import { isSealedSecretError, SealedSecretError, type SealedSecretNodeCode } from './errors';
import { isValidSlot, type SealedSecretPurposeId } from './purposes';
import { SealedSecretStore, type SealedSecretDescription } from './SealedSecretStore';

/** Whether a node can receive a sealed secret now, as this hub sees it. */
export type SealedSecretReadiness =
  | 'ready'
  | 'local'
  | 'unsupported'
  | 'unreachable'
  | 'pin_unconfirmed'
  | 'key_mismatch';

export interface SealingKeyReport {
  readiness: SealedSecretReadiness;
  pinned: NodeSealingPin | null;
  presented: { fingerprint: string } | null;
}

export interface DeliverInput {
  nodeId: number;
  purpose: SealedSecretPurposeId;
  slot: string;
  /** Held in memory for this call only. Never stored, logged or audited on the hub. */
  secret: string;
  actor: string;
}

export interface RemoveInput {
  nodeId: number;
  purpose: SealedSecretPurposeId;
  slot: string;
  actor: string;
}

export interface DeliveryResult {
  status: 'accepted' | 'already_accepted';
  generation: number;
}

export interface RemovalResult {
  status: 'deleted' | 'already_deleted' | 'not_current';
  generation: number;
  currentSlot: string | null;
}

export interface SealedSecretState {
  hub: SealedSecretDeliveryRow | null;
  node: SealedSecretDescription;
}

/** A node's answer to one request: its body, or its refusal. */
type NodeAnswer<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; code: string | null; message: string; purposeGeneration: number | null };

interface PresentedKey {
  publicKeyRaw: Buffer;
  fingerprint: string;
  deliverySourceId: string;
}

/**
 * One way to reach a node's store. The local node is called in process with no
 * sealing; a remote node (direct proxy or Pilot) through the one target this
 * operation resolved. Nothing else differs between transports.
 */
interface NodeChannel {
  readonly local: boolean;
  describe(purpose: SealedSecretPurposeId, slot: string): Promise<SealedSecretDescription>;
  accept(
    purpose: SealedSecretPurposeId,
    slot: string,
    generation: number,
    operationId: string,
    secret: string,
    actor: string,
  ): Promise<NodeAnswer<DeliveryResult>>;
  remove(
    purpose: SealedSecretPurposeId,
    slot: string,
    generation: number,
    operationId: string,
    actor: string,
  ): Promise<NodeAnswer<RemovalResult>>;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Responses are small JSON documents; anything larger is not a node's answer. */
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const DELIVERY_PATH = 'sealed-secret-delivery';

function hubError(code: SealedSecretError['code'], status: number, message: string, details: Record<string, string | number | null> = {}) {
  return new SealedSecretError(code, status, message, details);
}

function unreachable(): SealedSecretError {
  return hubError('SEALED_SECRET_TARGET_UNREACHABLE', 503, 'Sencho could not reach this node to deliver a sealed secret. Check that it is online, then retry.');
}

function deliveryFailed(): SealedSecretError {
  return hubError('SEALED_SECRET_DELIVERY_FAILED', 502, 'The node answered in a way Sencho could not use. Retry; if it keeps failing, check the node\'s logs.');
}

/** Reduce an axios failure to status and code for the log: never the request body. */
function describeTransportError(error: unknown): string {
  if (axios.isAxiosError(error)) return `${error.code ?? 'error'} ${error.response?.status ?? ''}`.trim();
  return getErrorMessage(error, 'unknown');
}

function toRefusal<T>(error: unknown): NodeAnswer<T> {
  if (isSealedSecretError(error)) {
    const generation = error.details.purposeGeneration;
    return {
      ok: false,
      status: error.status,
      code: error.code,
      message: error.message,
      purposeGeneration: typeof generation === 'number' ? generation : null,
    };
  }
  throw error;
}

class LocalChannel implements NodeChannel {
  readonly local = true;

  async describe(purpose: SealedSecretPurposeId, slot: string): Promise<SealedSecretDescription> {
    return SealedSecretStore.getInstance().describe(purpose, slot);
  }

  async accept(purpose: SealedSecretPurposeId, slot: string, generation: number, _operationId: string, secret: string, actor: string) {
    try {
      const result = await SealedSecretStore.getInstance().accept(purpose, slot, generation, secret, {
        actor, path: DELIVERY_PATH, method: 'POST',
      });
      return { ok: true as const, body: { status: result.status, generation: result.generation } };
    } catch (error: unknown) {
      return toRefusal<DeliveryResult>(error);
    }
  }

  async remove(purpose: SealedSecretPurposeId, slot: string, generation: number, _operationId: string, actor: string) {
    try {
      const body = await SealedSecretStore.getInstance().remove(purpose, slot, generation, {
        actor, path: DELIVERY_PATH, method: 'DELETE',
      });
      return { ok: true as const, body };
    } catch (error: unknown) {
      return toRefusal<RemovalResult>(error);
    }
  }
}

class RemoteChannel implements NodeChannel {
  readonly local = false;

  constructor(private readonly target: ProxyTarget, private readonly key: PresentedKey | null) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, data?: unknown): Promise<NodeAnswer<T>> {
    const base = this.target.apiUrl.replace(/\/$/, '');
    let res;
    try {
      res = await axios.request({
        method,
        url: `${base}/api/sealed-secrets${path}`,
        data,
        ...safeAxiosTransport(this.target.trustedLoopback),
        // No forwarded role header: the node serves these routes only to the
        // hub's own background call.
        headers: { Authorization: `Bearer ${this.target.apiToken}` },
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: RESPONSE_LIMIT_BYTES,
        maxRedirects: 0,
        validateStatus: () => true,
      });
    } catch (error: unknown) {
      console.warn('[SealedSecretDelivery] Request to node failed:', sanitizeForLog(describeTransportError(error)));
      throw unreachable();
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, body: res.data as T };
    const body = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
    return {
      ok: false,
      status: res.status,
      code: typeof body.code === 'string' ? body.code : null,
      message: typeof body.error === 'string' ? body.error : `The node answered HTTP ${res.status}.`,
      purposeGeneration: typeof body.purposeGeneration === 'number' ? body.purposeGeneration : null,
    };
  }

  async fetchKey(): Promise<PresentedKey> {
    const answer = await this.call<Record<string, unknown>>('GET', '/key');
    if (!answer.ok) {
      console.warn('[SealedSecretDelivery] Node refused the key read:', answer.status, sanitizeForLog(answer.code ?? ''));
      throw deliveryFailed();
    }
    return parsePresentedKey(answer.body);
  }

  async describe(purpose: SealedSecretPurposeId, slot: string): Promise<SealedSecretDescription> {
    const answer = await this.call<SealedSecretDescription>('GET', `/${encodeURIComponent(purpose)}/${encodeURIComponent(slot)}`);
    if (!answer.ok || !isDescription(answer.body)) {
      console.warn('[SealedSecretDelivery] Node state read failed:', answer.ok ? 'bad shape' : answer.status);
      throw deliveryFailed();
    }
    return answer.body;
  }

  async accept(purpose: SealedSecretPurposeId, slot: string, generation: number, operationId: string, secret: string, actor: string) {
    if (!this.key) throw deliveryFailed();
    const sealed = sealSecret(this.key.publicKeyRaw, {
      purpose, deliverySourceId: this.key.deliverySourceId, slot, generation, operationId,
    }, secret);
    const answer = await this.call<DeliveryResult>('POST', `/${encodeURIComponent(purpose)}`, {
      slot, generation, operationId, actor, sealed,
    });
    if (answer.ok && !(answer.body?.status === 'accepted' || answer.body?.status === 'already_accepted')) throw deliveryFailed();
    return answer;
  }

  async remove(purpose: SealedSecretPurposeId, slot: string, generation: number, operationId: string, actor: string) {
    const answer = await this.call<RemovalResult>('DELETE', `/${encodeURIComponent(purpose)}/${encodeURIComponent(slot)}`, {
      generation, operationId, actor,
    });
    if (answer.ok && !['deleted', 'already_deleted', 'not_current'].includes(answer.body?.status)) throw deliveryFailed();
    return answer;
  }
}

function isDescription(value: unknown): value is SealedSecretDescription {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.purposeGeneration === 'number'
    && Number.isSafeInteger(raw.purposeGeneration)
    && raw.purposeGeneration >= 0
    && (raw.state === 'present' || raw.state === 'deleted' || raw.state === 'absent');
}

/** Validate a node's key answer the way registry discovery does, and recompute its fingerprint here. */
function parsePresentedKey(body: Record<string, unknown>): PresentedKey {
  let raw: Buffer | null;
  try {
    raw = parseSealingKeyBase64(body.publicKey);
  } catch {
    raw = null;
  }
  const deliverySourceId = body.deliverySourceId;
  if (!raw || typeof deliverySourceId !== 'string' || deliverySourceId === '') throw deliveryFailed();
  const fingerprint = fingerprintOf(raw);
  if (body.fingerprint !== fingerprint) throw deliveryFailed();
  return { publicKeyRaw: raw, fingerprint, deliverySourceId };
}

/** What one operation learned about a remote node, from one resolved target. */
interface RemoteContact {
  channel: RemoteChannel;
  key: PresentedKey;
  /** Whether the hop this operation uses is confidential. */
  confidential: boolean;
}

/**
 * Hub side of sealed secret delivery. Callers (the edge tunnel slice first)
 * deliver, remove and read state per node and purpose. A node that cannot
 * receive a sealed secret is refused with a named code; there is no plaintext
 * path and no pass-through.
 */
export class SealedSecretDeliveryService {
  private static instance: SealedSecretDeliveryService | null = null;
  private readonly queues = new Map<string, Promise<unknown>>();

  static getInstance(): SealedSecretDeliveryService {
    if (!SealedSecretDeliveryService.instance) SealedSecretDeliveryService.instance = new SealedSecretDeliveryService();
    return SealedSecretDeliveryService.instance;
  }

  /** Test helper. */
  static resetForTests(): void {
    SealedSecretDeliveryService.instance = null;
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }

  private isLocal(nodeId: number): boolean {
    const node = DatabaseService.getInstance().getNode(nodeId);
    if (!node) throw hubError('SEALED_SECRET_TARGET_UNREACHABLE', 503, 'That node does not exist.');
    return node.type !== 'remote';
  }

  /**
   * Probe the capability, resolve the target once, and fetch the key through
   * it. Confidentiality is read from that same target, so a reconnect or an
   * address edit between two steps cannot make a plaintext fetch look safe.
   */
  private async contact(nodeId: number): Promise<RemoteContact> {
    const probe = await probeRemoteCapability(nodeId, SEALED_SECRET_DELIVERY_V1_CAPABILITY);
    if (probe.kind === 'unsupported') {
      throw hubError(
        'SEALED_SECRET_TARGET_UNSUPPORTED',
        409,
        'This node runs a Sencho version that cannot receive sealed secrets. Update Sencho on the node, then retry.',
      );
    }
    if (probe.kind === 'unreachable') throw unreachable();
    const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
    if (!target) throw unreachable();
    const confidential = isResolvedTargetConfidential(nodeId, target);
    const keyChannel = new RemoteChannel(target, null);
    const key = await keyChannel.fetchKey();
    return { channel: new RemoteChannel(target, key), key, confidential };
  }

  /** The readiness rule, without side effects: what a delivery would decide now. */
  private judge(pin: NodeSealingPin | null, presented: string, confidential: boolean): SealedSecretReadiness {
    if (pin && pin.fingerprint !== presented) return 'key_mismatch';
    if (confidential) return 'ready';
    return pin?.confidential ? 'ready' : 'pin_unconfirmed';
  }

  /**
   * Status for the Sealing key sheet and for callers that want to explain a
   * refusal ahead of time. Makes one capability probe and one key fetch, and
   * writes nothing.
   */
  async evaluateReadiness(nodeId: number): Promise<SealingKeyReport> {
    if (this.isLocal(nodeId)) return { readiness: 'local', pinned: null, presented: null };
    const pinned = DatabaseService.getInstance().getNodeSealingPin(nodeId);
    let contact: RemoteContact;
    try {
      contact = await this.contact(nodeId);
    } catch (error: unknown) {
      if (!isSealedSecretError(error)) throw error;
      if (error.code === 'SEALED_SECRET_TARGET_UNSUPPORTED') return { readiness: 'unsupported', pinned, presented: null };
      return { readiness: 'unreachable', pinned, presented: null };
    }
    return {
      readiness: this.judge(pinned, contact.key.fingerprint, contact.confidential),
      pinned,
      presented: { fingerprint: contact.key.fingerprint },
    };
  }

  /**
   * Apply the pin rule for a delivery: pin on first contact (trusted only when
   * that contact was confidential), re-confirm a matching pin seen over a
   * confidential hop, refuse a changed key or an unconfirmed one.
   */
  private applyPin(nodeId: number, contact: RemoteContact): void {
    const db = DatabaseService.getInstance();
    const presented = contact.key.fingerprint;
    if (!db.getNodeSealingPin(nodeId)) {
      // Loses quietly to a concurrent registry pin; the re-read below decides.
      db.pinNodeSealingKey(nodeId, contact.key.publicKeyRaw.toString('base64'), presented, contact.confidential);
    }
    let pin = db.getNodeSealingPin(nodeId);
    if (pin && pin.fingerprint === presented && contact.confidential && !pin.confidential) {
      db.markSealingPinConfidential(nodeId, presented);
      pin = db.getNodeSealingPin(nodeId);
    }
    const readiness = this.judge(pin, presented, contact.confidential);
    if (readiness === 'key_mismatch') {
      throw hubError(
        'SEAL_KEY_MISMATCH',
        409,
        'This node presents a different sealing key than the one pinned for it, so nothing was sent. '
          + 'If the node was reinstalled, reset its sealing key pin in Settings, Nodes, then confirm the new fingerprint.',
      );
    }
    if (readiness !== 'ready') {
      throw hubError(
        'SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL',
        409,
        'This node\'s sealing key was never seen over a confidential connection, so nothing was sent. '
          + 'An Admin can confirm its fingerprint in Settings, Nodes, Sealing key.',
      );
    }
  }

  private async channelFor(nodeId: number, needsPin: boolean): Promise<NodeChannel> {
    if (this.isLocal(nodeId)) return new LocalChannel();
    const contact = await this.contact(nodeId);
    if (needsPin) this.applyPin(nodeId, contact);
    return contact.channel;
  }

  private audit(action: string, nodeId: number, facts: Record<string, string | number | null | undefined>, actor: string, statusCode: number): void {
    recordSealedSecretAudit(action, { node: nodeId, ...facts }, {
      username: actor, path: DELIVERY_PATH, method: 'POST', nodeId, statusCode,
    });
  }

  private refuse(nodeId: number, input: { purpose: string; slot: string; actor: string }, error: unknown, action: string): never {
    if (isSealedSecretError(error)) {
      this.audit(action, nodeId, { purpose: input.purpose, slot: input.slot, actor: input.actor, code: error.code }, input.actor, error.status);
      throw error;
    }
    console.error('[SealedSecretDelivery] Unexpected failure:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    this.audit(action, nodeId, { purpose: input.purpose, slot: input.slot, actor: input.actor, code: 'SEALED_SECRET_DELIVERY_FAILED' }, input.actor, 502);
    throw deliveryFailed();
  }

  /** Map a node's refusal to the hub's vocabulary; the node's code travels along. */
  private nodeRefused(answer: Extract<NodeAnswer<unknown>, { ok: false }>): SealedSecretError {
    if (answer.status >= 500 && answer.code === null) return deliveryFailed();
    return hubError('SEALED_SECRET_TARGET_REFUSED', 409, `The node refused the request: ${answer.message}`, {
      nodeCode: answer.code,
      nodeStatus: answer.status,
    });
  }

  /**
   * Choose the generation for an operation. A pending row for the same slot
   * the node has not moved past is a retry and reuses its generation and
   * operation id; anything else moves past both the hub's and the node's.
   */
  private nextGeneration(
    row: SealedSecretDeliveryRow | null,
    pendingState: 'sending' | 'removing',
    slot: string,
    nodeGeneration: number,
  ): { generation: number; operationId: string } {
    if (row && row.state === pendingState && row.slot === slot && nodeGeneration <= row.generation) {
      return { generation: row.generation, operationId: row.operationId };
    }
    return { generation: Math.max(row?.generation ?? 0, nodeGeneration) + 1, operationId: crypto.randomUUID() };
  }

  async deliver(input: DeliverInput): Promise<DeliveryResult> {
    if (!isValidSlot(input.purpose, input.slot)) {
      throw hubError('SEALED_SECRET_DELIVERY_FAILED', 400, 'The secret id is not valid for this purpose.');
    }
    return this.serialize(`${input.nodeId}:${input.purpose}`, async () => {
      try {
        const channel = await this.channelFor(input.nodeId, true);
        return await this.runDelivery(channel, input);
      } catch (error: unknown) {
        this.refuse(input.nodeId, input, error, 'sealed_secret.delivery_refused');
      }
    });
  }

  private async runDelivery(channel: NodeChannel, input: DeliverInput): Promise<DeliveryResult> {
    const db = DatabaseService.getInstance();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const node = await channel.describe(input.purpose, input.slot);
      const row = db.getSealedSecretDelivery(input.nodeId, input.purpose);
      const { generation, operationId } = attempt === 0
        ? this.nextGeneration(row, 'sending', input.slot, node.purposeGeneration)
        : { generation: Math.max(row?.generation ?? 0, node.purposeGeneration) + 1, operationId: crypto.randomUUID() };
      // Persist before sending, so a lost response or a hub crash still knows
      // which generation may have landed.
      db.upsertSealedSecretDelivery({
        nodeId: input.nodeId,
        purpose: input.purpose,
        slot: input.slot,
        generation,
        state: 'sending',
        operationId,
        requestedBy: input.actor,
        updatedAt: Date.now(),
      });
      const answer = await channel.accept(input.purpose, input.slot, generation, operationId, input.secret, input.actor);
      if (answer.ok) {
        db.setSealedSecretDeliveryState(input.nodeId, input.purpose, operationId, 'delivered');
        this.audit('sealed_secret.delivered', input.nodeId, {
          purpose: input.purpose, slot: input.slot, generation, actor: input.actor, operation: operationId, status: answer.body.status,
        }, input.actor, 200);
        return { status: answer.body.status, generation };
      }
      if (answer.code !== 'SEALED_SECRET_GENERATION_STALE' || attempt === 1) throw this.nodeRefused(answer);
      // The node moved (or the reused generation held other content): re-read once and move past it.
    }
    throw deliveryFailed();
  }

  async remove(input: RemoveInput): Promise<RemovalResult> {
    if (!isValidSlot(input.purpose, input.slot)) {
      throw hubError('SEALED_SECRET_DELIVERY_FAILED', 400, 'The secret id is not valid for this purpose.');
    }
    return this.serialize(`${input.nodeId}:${input.purpose}`, async () => {
      try {
        // No pin is needed to delete: nothing sealed is sent.
        const channel = await this.channelFor(input.nodeId, false);
        return await this.runRemoval(channel, input);
      } catch (error: unknown) {
        this.refuse(input.nodeId, input, error, 'sealed_secret.removal_refused');
      }
    });
  }

  private async runRemoval(channel: NodeChannel, input: RemoveInput): Promise<RemovalResult> {
    const db = DatabaseService.getInstance();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const node = await channel.describe(input.purpose, input.slot);
      const row = db.getSealedSecretDelivery(input.nodeId, input.purpose);
      const { generation, operationId } = attempt === 0
        ? this.nextGeneration(row, 'removing', input.slot, node.purposeGeneration)
        : { generation: Math.max(row?.generation ?? 0, node.purposeGeneration) + 1, operationId: crypto.randomUUID() };
      // A hub row that already names a newer slot is the live delivery; a
      // removal of an old slot must not overwrite it.
      const ownsRow = !row || row.slot === input.slot;
      if (ownsRow) {
        db.upsertSealedSecretDelivery({
          nodeId: input.nodeId,
          purpose: input.purpose,
          slot: input.slot,
          generation,
          state: 'removing',
          operationId,
          requestedBy: input.actor,
          updatedAt: Date.now(),
        });
      }
      const answer = await channel.remove(input.purpose, input.slot, generation, operationId, input.actor);
      if (answer.ok) {
        if (ownsRow) db.setSealedSecretDeliveryState(input.nodeId, input.purpose, operationId, 'removed');
        this.audit('sealed_secret.removed', input.nodeId, {
          purpose: input.purpose, slot: input.slot, generation, actor: input.actor, operation: operationId, status: answer.body.status,
        }, input.actor, 200);
        return answer.body;
      }
      if (answer.code !== 'SEALED_SECRET_GENERATION_STALE' || attempt === 1) throw this.nodeRefused(answer);
    }
    throw deliveryFailed();
  }

  /** The hub's last operation and the node's own record, for a consumer that shows progress. */
  async readState(nodeId: number, purpose: SealedSecretPurposeId, slot: string): Promise<SealedSecretState> {
    const channel = await this.channelFor(nodeId, false);
    return {
      hub: DatabaseService.getInstance().getSealedSecretDelivery(nodeId, purpose),
      node: await channel.describe(purpose, slot),
    };
  }

  /**
   * An Admin vouches for a node's key out of band. The node's key is fetched
   * again; the fingerprint must match it, and the pin when one exists.
   */
  async confirmFingerprint(nodeId: number, fingerprint: string, admin: string): Promise<SealingKeyReport> {
    if (this.isLocal(nodeId)) {
      throw hubError('SEALED_SECRET_TARGET_REFUSED', 400, 'This instance\'s own key needs no confirmation.');
    }
    const db = DatabaseService.getInstance();
    const contact = await this.contact(nodeId);
    const presented = contact.key.fingerprint;
    const pin = db.getNodeSealingPin(nodeId);
    if (fingerprint !== presented || (pin && pin.fingerprint !== presented)) {
      this.audit('sealing_key.confirm_refused', nodeId, { by: admin, code: 'SEAL_KEY_MISMATCH' }, admin, 409);
      throw hubError(
        'SEAL_KEY_MISMATCH',
        409,
        pin && pin.fingerprint !== presented
          ? 'This node presents a different key than the one pinned for it. Reset the pin first if the node was reinstalled.'
          : 'That fingerprint is not the one this node presents now. Compare it again with the node\'s own fingerprint.',
      );
    }
    if (!pin) db.pinNodeSealingKey(nodeId, contact.key.publicKeyRaw.toString('base64'), presented);
    if (!db.markSealingPinConfidential(nodeId, presented, admin)) {
      // A concurrent pin of another key won the insert.
      throw hubError('SEAL_KEY_MISMATCH', 409, 'The pinned key changed while confirming. Open the sheet again.');
    }
    this.audit('sealing_key.confirmed', nodeId, { by: admin }, admin, 200);
    const pinned = db.getNodeSealingPin(nodeId);
    return { readiness: this.judge(pinned, presented, contact.confidential), pinned, presented: { fingerprint: presented } };
  }

  /** This instance's own fingerprint (the key exists from startup). */
  localFingerprint(): string {
    return getOrCreateSealingKey().fingerprint;
  }
}

export type { SealedSecretNodeCode };
