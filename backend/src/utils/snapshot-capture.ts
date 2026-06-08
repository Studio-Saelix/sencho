/**
 * Shared snapshot capture functions used by both the REST API (index.ts)
 * and the SchedulerService for fleet-wide snapshot operations.
 */

import type { NodeMode, StackDossierFields } from '../services/DatabaseService';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { formatNoTargetError } from './remoteTarget';
import { isDebugEnabled } from './debug';

// Presence map over every operator-authored dossier field. Typing it as
// Record<keyof StackDossierFields, true> makes the build fail if a field is
// added to StackDossierFields without being listed here, so capture can never
// silently start omitting a new field.
const DOSSIER_FIELD_PRESENCE: Record<keyof StackDossierFields, true> = {
  purpose: true, owner: true, access_urls: true, static_ip: true, vlan: true,
  firewall_notes: true, reverse_proxy_notes: true, backup_notes: true,
  upgrade_notes: true, recovery_notes: true, custom_notes: true,
};
const DOSSIER_FIELD_KEYS = Object.keys(DOSSIER_FIELD_PRESENCE) as Array<keyof StackDossierFields>;

/**
 * Project an arbitrary object (a DB row or a remote JSON payload) down to the
 * eleven operator-authored dossier fields, coercing anything non-string to ''.
 * Never carries identity, hashes, or timestamps into the snapshot.
 */
export function pickDossierFields(src: Partial<Record<keyof StackDossierFields, unknown>> | null | undefined): StackDossierFields {
  const out = {} as StackDossierFields;
  for (const key of DOSSIER_FIELD_KEYS) {
    const value = src?.[key];
    out[key] = typeof value === 'string' ? value : '';
  }
  return out;
}

/** True when the operator typed at least one non-blank dossier field. */
export function dossierHasContent(fields: StackDossierFields): boolean {
  return DOSSIER_FIELD_KEYS.some(key => fields[key].trim() !== '');
}

/** A single stack's preserved dossier notes inside a snapshot. */
export interface SnapshotDocumentationStack {
  nodeId: number;
  nodeName: string;
  stackName: string;
  dossier: StackDossierFields;
}

/** A non-fatal problem fetching a stack's dossier during capture. */
export interface SnapshotDocumentationWarning {
  nodeId: number;
  nodeName: string;
  stackName: string;
  reason: string;
}

/**
 * Stack Dossier metadata preserved alongside a fleet snapshot's files. Captured
 * only when the `snapshot_documentation` setting is on; absent (and the column
 * left empty) otherwise, so existing snapshots stay byte-for-byte unchanged.
 */
export interface SnapshotDocumentation {
  generated_at: string;
  stacks: SnapshotDocumentationStack[];
  warnings: SnapshotDocumentationWarning[];
}

export interface SnapshotNodeData {
  nodeId: number;
  nodeName: string;
  stacks: Array<{
    stackName: string;
    files: Array<{ filename: string; content: string }>;
    /** Operator dossier notes for this stack, present only when documentation
     *  capture is on and the stack has at least one non-blank field. */
    dossier?: StackDossierFields;
  }>;
  /**
   * Per-stack capture problems that did not fail the whole node: a stack whose
   * compose file could not be read (so it is absent from `stacks`), a `.env`
   * dropped on a read error, or a file skipped for exceeding the size cap.
   * Surfaced on the snapshot so an operator never mistakes a partial capture
   * for a complete backup.
   */
  warnings: Array<{ stackName: string; reason: string }>;
  /**
   * Per-stack dossier-fetch problems during documentation capture. Distinct
   * from `warnings`: the stack's files captured fine, only its notes did not.
   * Empty unless documentation capture was requested.
   */
  docWarnings: Array<{ stackName: string; reason: string }>;
}

/**
 * Per-file capture ceiling. compose.yaml and .env are normally a few KB; this
 * generous 1 MB bound stops a pathological or hostile file from bloating the
 * snapshot DB and the GET-detail payload. An oversize compose.yaml skips the
 * whole stack; an oversize .env drops only that file and keeps the stack. Both
 * are recorded as a warning, never silently dropped.
 */
export const MAX_SNAPSHOT_FILE_BYTES = 1_000_000;
/** The cap rendered in MB for operator-facing warning text. */
const MAX_SNAPSHOT_FILE_MB = MAX_SNAPSHOT_FILE_BYTES / 1_000_000;

/**
 * Minimal node shape accepted by capture functions.
 * `mode` is required so remote dispatch can emit a tunnel-aware error when
 * the pilot-agent proxy target is null.
 */
export interface CaptureNode {
  id: number;
  name: string;
  mode: NodeMode;
}

/**
 * Read compose.yaml and .env files for every stack on a local node.
 * A stack whose compose file cannot be read is omitted from `stacks` and
 * recorded in `warnings`, so a partial capture is never mistaken for complete.
 */
export async function captureLocalNodeFiles(node: CaptureNode, captureDocs = false): Promise<SnapshotNodeData> {
  const start = Date.now();
  const fsService = FileSystemService.getInstance(node.id);
  const stackNames = await fsService.getStacks();
  const stacks: SnapshotNodeData['stacks'] = [];
  const warnings: SnapshotNodeData['warnings'] = [];
  const docWarnings: SnapshotNodeData['docWarnings'] = [];

  for (const stackName of stackNames) {
    const files: Array<{ filename: string; content: string }> = [];

    let composeContent: string;
    try {
      composeContent = await fsService.getStackContent(stackName);
    } catch (e) {
      const reason = `compose.yaml could not be read: ${(e as Error).message}`;
      console.warn(`[Fleet Snapshot] Skipping stack "${stackName}" on "${node.name}": ${reason}`);
      warnings.push({ stackName, reason });
      continue;
    }
    if (Buffer.byteLength(composeContent, 'utf-8') > MAX_SNAPSHOT_FILE_BYTES) {
      const reason = `compose.yaml exceeds the ${MAX_SNAPSHOT_FILE_MB} MB capture limit; stack skipped`;
      console.warn(`[Fleet Snapshot] ${reason} ("${stackName}" on "${node.name}")`);
      warnings.push({ stackName, reason });
      continue;
    }
    files.push({ filename: 'compose.yaml', content: composeContent });

    try {
      const envContent = await fsService.getEnvContent(stackName);
      if (Buffer.byteLength(envContent, 'utf-8') > MAX_SNAPSHOT_FILE_BYTES) {
        warnings.push({ stackName, reason: `.env exceeds the ${MAX_SNAPSHOT_FILE_MB} MB capture limit; captured without it` });
      } else {
        files.push({ filename: '.env', content: envContent });
      }
    } catch (e) {
      // A missing .env is normal; surface only genuine read errors so a stack
      // is not silently restored without its secrets.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push({ stackName, reason: `.env could not be read: ${(e as Error).message}; captured without it` });
      }
    }

    let dossier: StackDossierFields | undefined;
    if (captureDocs) {
      try {
        const fields = pickDossierFields(DatabaseService.getInstance().getStackDossier(node.id, stackName));
        if (dossierHasContent(fields)) dossier = fields;
      } catch (e) {
        docWarnings.push({ stackName, reason: `dossier could not be read: ${(e as Error).message}` });
      }
    }
    stacks.push({ stackName, files, dossier });
  }

  if (isDebugEnabled()) {
    const fileCount = stacks.reduce((sum, s) => sum + s.files.length, 0);
    console.debug(`[Fleet:debug] Local capture "${node.name}": ${stacks.length} stack(s), ${fileCount} file(s), ${warnings.length} warning(s) in ${Date.now() - start}ms`);
  }

  return { nodeId: node.id, nodeName: node.name, stacks, warnings, docWarnings };
}

/**
 * Fetch compose.yaml and .env files for every stack on a remote node
 * via the Distributed API proxy. A stack whose compose file cannot be
 * fetched is omitted from `stacks` and recorded in `warnings`, so a partial
 * capture is never mistaken for complete.
 */
export async function captureRemoteNodeFiles(node: CaptureNode, captureDocs = false): Promise<SnapshotNodeData> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target) {
    throw new Error(formatNoTargetError(node));
  }

  const start = Date.now();
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;

  const stacksRes = await fetch(`${baseUrl}/api/stacks`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!stacksRes.ok) throw new Error('Failed to fetch stacks from remote node');
  const stackNames = await stacksRes.json() as string[];

  const stacks: SnapshotNodeData['stacks'] = [];
  const warnings: SnapshotNodeData['warnings'] = [];
  const docWarnings: SnapshotNodeData['docWarnings'] = [];

  for (const stackName of stackNames) {
    const files: Array<{ filename: string; content: string }> = [];

    let composeContent: string;
    try {
      const composeRes = await fetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!composeRes.ok) {
        const reason = `compose.yaml fetch failed (HTTP ${composeRes.status}); stack skipped`;
        console.warn(`[Fleet Snapshot] ${reason} ("${stackName}" on "${node.name}")`);
        warnings.push({ stackName, reason });
        continue;
      }
      composeContent = await composeRes.text();
    } catch (e) {
      const reason = `compose.yaml fetch error: ${(e as Error).message}; stack skipped`;
      console.warn(`[Fleet Snapshot] ${reason} ("${stackName}" on "${node.name}")`);
      warnings.push({ stackName, reason });
      continue;
    }
    if (Buffer.byteLength(composeContent, 'utf-8') > MAX_SNAPSHOT_FILE_BYTES) {
      warnings.push({ stackName, reason: `compose.yaml exceeds the ${MAX_SNAPSHOT_FILE_MB} MB capture limit; stack skipped` });
      continue;
    }
    files.push({ filename: 'compose.yaml', content: composeContent });

    try {
      const envRes = await fetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/env`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      // The remote replies 200 with an empty body and X-Env-Exists: false when a
      // stack has no .env. Treat that as absent (matching the local ENOENT path)
      // so restore does not write a spurious empty .env. An older remote that
      // predates the header falls back to capturing whatever the 200 returned.
      if (envRes.ok && envRes.headers.get('X-Env-Exists') !== 'false') {
        const content = await envRes.text();
        if (Buffer.byteLength(content, 'utf-8') > MAX_SNAPSHOT_FILE_BYTES) {
          warnings.push({ stackName, reason: `.env exceeds the ${MAX_SNAPSHOT_FILE_MB} MB capture limit; captured without it` });
        } else {
          files.push({ filename: '.env', content });
        }
      } else if (!envRes.ok && envRes.status !== 404) {
        warnings.push({ stackName, reason: `.env fetch failed (HTTP ${envRes.status}); captured without it` });
      }
    } catch (e) {
      warnings.push({ stackName, reason: `.env fetch error: ${(e as Error).message}; captured without it` });
    }

    let dossier: StackDossierFields | undefined;
    if (captureDocs) {
      try {
        const dossierRes = await fetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/dossier`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (dossierRes.ok) {
          const fields = pickDossierFields(await dossierRes.json() as Record<string, unknown>);
          if (dossierHasContent(fields)) dossier = fields;
        } else if (dossierRes.status !== 404) {
          docWarnings.push({ stackName, reason: `dossier fetch failed (HTTP ${dossierRes.status})` });
        }
      } catch (e) {
        docWarnings.push({ stackName, reason: `dossier fetch error: ${(e as Error).message}` });
      }
    }
    stacks.push({ stackName, files, dossier });
  }

  if (isDebugEnabled()) {
    const fileCount = stacks.reduce((sum, s) => sum + s.files.length, 0);
    console.debug(`[Fleet:debug] Remote capture "${node.name}": ${stacks.length} stack(s), ${fileCount} file(s), ${warnings.length} warning(s) in ${Date.now() - start}ms`);
  }

  return { nodeId: node.id, nodeName: node.name, stacks, warnings, docWarnings };
}

/**
 * Collapse captured per-node dossier notes and dossier-fetch warnings into a
 * single snapshot documentation record. Returns `null` when nothing was
 * captured (no stack carried notes and nothing failed), so the caller stores an
 * empty documentation column and `has_documentation` stays 0.
 */
export function buildSnapshotDocumentation(capturedNodes: SnapshotNodeData[], generatedAt: string): SnapshotDocumentation | null {
  const stacks: SnapshotDocumentationStack[] = [];
  const warnings: SnapshotDocumentationWarning[] = [];
  for (const node of capturedNodes) {
    for (const stack of node.stacks) {
      if (stack.dossier) {
        stacks.push({ nodeId: node.nodeId, nodeName: node.nodeName, stackName: stack.stackName, dossier: stack.dossier });
      }
    }
    for (const warning of node.docWarnings) {
      warnings.push({ nodeId: node.nodeId, nodeName: node.nodeName, stackName: warning.stackName, reason: warning.reason });
    }
  }
  if (stacks.length === 0 && warnings.length === 0) return null;
  return { generated_at: generatedAt, stacks, warnings };
}
