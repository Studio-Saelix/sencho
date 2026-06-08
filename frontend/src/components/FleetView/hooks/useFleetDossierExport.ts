import { useCallback, useState } from 'react';
import { zipSync, strToU8 } from 'fflate';
import { apiFetch, fetchForNode } from '@/lib/api';
import { assembleAnatomyInput, type GitSourceInfo } from '@/lib/anatomy';
import {
  buildFleetDossier,
  type FleetDossierNode,
  type FleetDossierStack,
} from '@/lib/fleetDossier';
import { EMPTY_DOSSIER_FIELDS, type StackDossierFields } from '@/lib/dossierMarkdown';
import { downloadBlob } from '@/lib/download';
import { toast } from '@/components/ui/toast-store';

interface OverviewNode {
  id: number;
  name: string;
  type: 'local' | 'remote';
  status: 'online' | 'offline' | 'unknown';
}

// Cap concurrent per-stack collection so a large fleet cannot fire hundreds of
// requests through the proxy at once.
const STACK_CONCURRENCY = 6;

async function getText(endpoint: string, nodeId: number): Promise<string> {
  const res = await fetchForNode(endpoint, nodeId);
  if (!res.ok) throw new Error(`${endpoint} -> ${res.status}`);
  return res.text();
}

async function getJson<T>(endpoint: string, nodeId: number): Promise<T> {
  const res = await fetchForNode(endpoint, nodeId);
  if (!res.ok) throw new Error(`${endpoint} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// fetchForNode throws this sentinel on a 401 and fires a global logout. A 401 is
// not a per-item degrade condition: it invalidates the whole export, so the
// per-item catches rethrow it to abort rather than silently producing a partial
// dossier that looks complete.
function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message === 'Unauthorized';
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch the git source for a stack, or null when unlinked/unavailable. */
async function loadGitSource(stackName: string, nodeId: number): Promise<GitSourceInfo | null> {
  try {
    const data = await getJson<{ linked?: boolean; repo_url?: string; branch?: string; compose_path?: string }>(
      `/stacks/${encodeURIComponent(stackName)}/git-source`,
      nodeId,
    );
    if (!data || data.linked === false || !data.repo_url || !data.branch) return null;
    return { repo_url: data.repo_url, branch: data.branch, compose_path: data.compose_path };
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    console.warn(`[FleetDossier] git-source load failed for "${stackName}" on node ${nodeId}:`, err);
    return null;
  }
}

async function loadDossier(stackName: string, nodeId: number): Promise<StackDossierFields> {
  try {
    const data = await getJson<Record<string, unknown>>(`/stacks/${encodeURIComponent(stackName)}/dossier`, nodeId);
    const out = { ...EMPTY_DOSSIER_FIELDS };
    for (const k of Object.keys(EMPTY_DOSSIER_FIELDS) as Array<keyof StackDossierFields>) {
      if (typeof data[k] === 'string') out[k] = data[k] as string;
    }
    return out;
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    console.warn(`[FleetDossier] dossier load failed for "${stackName}" on node ${nodeId}:`, err);
    return { ...EMPTY_DOSSIER_FIELDS };
  }
}

async function collectStack(stackName: string, nodeId: number): Promise<FleetDossierStack> {
  const dossier = await loadDossier(stackName, nodeId);
  let content: string;
  try {
    content = await getText(`/stacks/${encodeURIComponent(stackName)}`, nodeId);
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    // Compose unreadable: emit a stub page from the operator notes alone.
    console.warn(`[FleetDossier] compose read failed for "${stackName}" on node ${nodeId}:`, err);
    return { stackName, anatomy: null, dossier };
  }

  let envContent = '';
  let firstEnvFile: string | null = null;
  try {
    const { envFiles } = await getJson<{ envFiles: string[] }>(`/stacks/${encodeURIComponent(stackName)}/envs`, nodeId);
    firstEnvFile = envFiles[0] ?? null;
    if (firstEnvFile) {
      envContent = await getText(`/stacks/${encodeURIComponent(stackName)}/env?file=${encodeURIComponent(firstEnvFile)}`, nodeId);
    }
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    // No env data: anatomy still renders, just without env-file facts.
    console.warn(`[FleetDossier] env read failed for "${stackName}" on node ${nodeId}:`, err);
  }

  const gitSource = await loadGitSource(stackName, nodeId);
  const anatomy = assembleAnatomyInput({ stackName, content, envContent, selectedEnvFile: firstEnvFile, gitSource });
  return { stackName, anatomy, dossier };
}

async function collectNode(node: OverviewNode): Promise<FleetDossierNode> {
  const base = { id: node.id, name: node.name, type: node.type };
  if (node.status !== 'online') {
    return { ...base, reachable: false, skipReason: node.status === 'offline' ? 'node offline' : 'node status unknown' };
  }
  let stackNames: string[];
  try {
    stackNames = await getJson<string[]>('/stacks', node.id);
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    console.warn(`[FleetDossier] stack list failed for node ${node.id}:`, err);
    return { ...base, reachable: false, skipReason: 'stack list unavailable' };
  }
  const stacks = await mapWithConcurrency(stackNames, STACK_CONCURRENCY, name => collectStack(name, node.id));
  return { ...base, reachable: true, stacks };
}

/**
 * Drives the whole-fleet dossier export: enumerate nodes, fan per-stack data
 * collection out across each node's API (`x-node-id`, dispatched locally or
 * forwarded to remote nodes by the backend), render the Markdown with the
 * shared generators, zip it, and trigger a download. Unreachable nodes are
 * recorded with a reason and never block the rest of the export.
 */
export function useFleetDossierExport(): { exporting: boolean; exportDossier: () => Promise<void> } {
  const [exporting, setExporting] = useState(false);

  const exportDossier = useCallback(async () => {
    setExporting(true);
    try {
      const [nodes, meta] = await Promise.all([
        apiFetch('/fleet/overview', { localOnly: true }).then(r => {
          if (!r.ok) throw new Error(`overview -> ${r.status}`);
          return r.json() as Promise<OverviewNode[]>;
        }),
        apiFetch('/meta', { localOnly: true })
          .then(r => (r.ok ? (r.json() as Promise<{ version: string | null }>) : { version: null }))
          .catch(() => ({ version: null })),
      ]);

      const collected = await mapWithConcurrency(nodes, 2, collectNode);

      const files = buildFleetDossier({
        generatedAt: new Date().toISOString(),
        senchoVersion: meta.version ?? 'unknown',
        nodes: collected,
      });

      // Nest under a single top-level folder so unzipping yields one
      // `homelab-dossier/` directory rather than scattering files into the cwd.
      const zippable: Record<string, Uint8Array> = {};
      for (const [path, content] of Object.entries(files)) zippable[`homelab-dossier/${path}`] = strToU8(content);
      const archive = zipSync(zippable);
      downloadBlob('homelab-dossier.zip', new Blob([archive], { type: 'application/zip' }));

      const skipped = collected.filter(n => !n.reachable).length;
      toast.success(skipped > 0
        ? `Fleet dossier exported. ${skipped} node${skipped === 1 ? '' : 's'} skipped (unreachable).`
        : 'Fleet dossier exported.');
    } catch (err) {
      console.error('[FleetDossier] export failed:', err);
      toast.error('Failed to export the fleet dossier. Check your connection and try again.');
    } finally {
      setExporting(false);
    }
  }, []);

  return { exporting, exportDossier };
}
