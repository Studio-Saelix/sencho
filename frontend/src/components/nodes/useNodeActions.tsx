import { useCallback, useState, type ReactNode } from 'react';
import { Check, Copy, AlertTriangle, Globe, Monitor, RefreshCw } from 'lucide-react';
import { useNodes, type Node, type NodeMode } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import { SettingsPrimaryButton } from '@/components/settings/SettingsActions';
import { formatTimeUntil } from '@/lib/relativeTime';

export interface NodeTestInfo {
  serverVersion?: string;
  senchoVersion?: string;
  os?: string;
  architecture?: string;
  containers?: number;
  images?: number;
  cpus?: number;
}

interface PilotEnrollment {
  token: string;
  expiresAt: number;
  composeYaml: string;
}

interface NodeFormData {
  name: string;
  type: 'local' | 'remote';
  mode: NodeMode;
  api_url: string;
  api_token: string;
  compose_dir: string;
  is_default: boolean;
}

const DEFAULT_COMPOSE_DIR = '/app/compose';
const DEFAULT_PILOT_COMPOSE_DIR = '/opt/docker/sencho';

function defaultComposeDir(type: NodeFormData['type'], mode: NodeMode): string {
  return type === 'remote' && mode === 'pilot_agent'
    ? DEFAULT_PILOT_COMPOSE_DIR
    : DEFAULT_COMPOSE_DIR;
}

const defaultFormData: NodeFormData = {
  name: '',
  type: 'remote',
  mode: 'pilot_agent',
  api_url: '',
  api_token: '',
  compose_dir: DEFAULT_PILOT_COMPOSE_DIR,
  is_default: false,
};

interface UseNodeActionsOptions {
  onNodeChange?: () => void;
  onTestResult?: (result: { nodeId: number; info: NodeTestInfo }) => void;
}

interface UseNodeActionsReturn {
  openCreate: () => void;
  openEdit: (node: Node) => void;
  openDelete: (node: Node) => void;
  NodeActionModals: ReactNode;
}

async function runConnectionTest(
  nodeId: number,
  nodeName: string,
  onTestResult?: (result: { nodeId: number; info: NodeTestInfo }) => void,
): Promise<void> {
  try {
    const res = await apiFetch(`/nodes/${nodeId}/test`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      toast.success(`Connected to "${nodeName}" successfully`);
      onTestResult?.({ nodeId, info: data.info });
    } else {
      toast.warning(`Node saved, but connection test failed: ${data.error}`);
    }
  } catch (err) {
    // Node is saved; the test result is supplementary. Log so connectivity issues are debuggable.
    console.warn(`Auto connection test failed for node ${nodeId}:`, err);
  }
}

export function useNodeActions(opts: UseNodeActionsOptions = {}): UseNodeActionsReturn {
  const { onNodeChange, onTestResult } = opts;
  const { nodes, refreshNodes } = useNodes();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formData, setFormData] = useState<NodeFormData>(defaultFormData);
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [originalEditValues, setOriginalEditValues] = useState<{ api_url: string; api_token: string } | null>(null);
  const [deletingNode, setDeletingNode] = useState<Node | null>(null);

  const [activeEnrollment, setActiveEnrollment] = useState<{ nodeId: number; nodeName: string; enrollment: PilotEnrollment } | null>(null);
  const [enrollmentCopied, setEnrollmentCopied] = useState(false);

  const refresh = useCallback(async () => {
    await refreshNodes();
    onNodeChange?.();
  }, [refreshNodes, onNodeChange]);

  const handleCreate = async () => {
    try {
      const res = await apiFetch('/nodes', {
        method: 'POST',
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create node');
      }
      const body = await res.json();
      const newNodeId: number | undefined = body.id;
      const enrollment: PilotEnrollment | undefined = body.enrollment;
      toast.success(`Node "${formData.name}" created successfully`);

      const isPilot = formData.type === 'remote' && formData.mode === 'pilot_agent';
      if (isPilot && newNodeId && enrollment) {
        setActiveEnrollment({ nodeId: newNodeId, nodeName: formData.name, enrollment });
      } else {
        setCreateOpen(false);
        setFormData(defaultFormData);
      }

      const isProxy = formData.type === 'remote' && formData.mode === 'proxy';
      if (newNodeId && isProxy) {
        await runConnectionTest(newNodeId, formData.name, onTestResult);
      }

      await refresh();
    } catch (error) {
      toast.error((error as Error).message || 'Failed to create node');
    }
  };

  const handleEdit = async () => {
    if (editingNodeId === null) return;
    try {
      // A blank token means "keep the existing credential": the stored token is
      // never sent to the browser, so an untouched field must not overwrite it.
      // Only a non-empty value rotates the token on the backend.
      const { api_token, ...rest } = formData;
      const payload = api_token.trim() ? formData : rest;
      const res = await apiFetch(`/nodes/${editingNodeId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update node');
      }
      toast.success(`Node "${formData.name}" updated`);

      const isProxy = formData.type === 'remote' && formData.mode === 'proxy';
      const connectionFieldsChanged = originalEditValues !== null && (
        formData.api_url !== originalEditValues.api_url ||
        formData.api_token !== originalEditValues.api_token
      );
      const savedNodeId = editingNodeId;
      const savedName = formData.name;

      setEditOpen(false);
      setEditingNodeId(null);
      setOriginalEditValues(null);
      setFormData(defaultFormData);

      if (isProxy && connectionFieldsChanged) {
        await runConnectionTest(savedNodeId, savedName, onTestResult);
      }

      await refresh();
    } catch (error) {
      toast.error((error as Error).message || 'Failed to update node');
    }
  };

  const handleDelete = async () => {
    if (!deletingNode) return;
    try {
      const res = await apiFetch(`/nodes/${deletingNode.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete node');
      }
      toast.success(`Node "${deletingNode.name}" deleted`);
      await refresh();
    } catch (error) {
      toast.error((error as Error).message || 'Failed to delete node');
    } finally {
      setDeleteOpen(false);
      setDeletingNode(null);
    }
  };

  const regenerateEnrollment = async (node: Node) => {
    try {
      const res = await apiFetch(`/nodes/${node.id}/pilot/enroll`, { method: 'POST', localOnly: true });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to regenerate enrollment');
      }
      const { enrollment } = (await res.json()) as { enrollment: PilotEnrollment };
      setActiveEnrollment({ nodeId: node.id, nodeName: node.name, enrollment });
      toast.success('New enrollment token generated');
    } catch (error) {
      toast.error((error as Error).message || 'Failed to regenerate enrollment');
    }
  };

  const copyEnrollment = async () => {
    if (!activeEnrollment) return;
    try {
      await copyToClipboard(activeEnrollment.enrollment.composeYaml);
      setEnrollmentCopied(true);
      toast.success('Compose file copied to clipboard');
      setTimeout(() => setEnrollmentCopied(false), 2000);
    } catch {
      toast.error('Could not copy automatically. Please select and copy the compose file manually.');
    }
  };

  const openCreate = useCallback(() => {
    setFormData(defaultFormData);
    setCreateOpen(true);
  }, []);

  const openEdit = useCallback((node: Node) => {
    // The stored api_token is never returned to the browser, so the token field
    // always opens blank. A blank value on save keeps the existing credential;
    // typing a new value rotates it.
    setFormData({
      name: node.name,
      type: node.type,
      mode: (node.mode === 'pilot_agent' ? 'pilot_agent' : 'proxy'),
      api_url: node.api_url || '',
      api_token: '',
      compose_dir: node.compose_dir,
      is_default: node.is_default,
    });
    setOriginalEditValues({
      api_url: node.api_url || '',
      api_token: '',
    });
    setEditingNodeId(node.id);
    setEditOpen(true);
  }, []);

  const openDelete = useCallback((node: Node) => {
    setDeletingNode(node);
    setDeleteOpen(true);
  }, []);

  const renderFormFields = (isEdit: boolean) => (
    <div className="space-y-4 py-4">
      <div className="space-y-2">
        <Label htmlFor="node-name">Name</Label>
        <Input
          id="node-name"
          placeholder="e.g., Production VPS"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="node-type">Type</Label>
        <Select
          value={formData.type}
          onValueChange={(val) => {
            const type = val as NodeFormData['type'];
            const currentDefault = defaultComposeDir(formData.type, formData.mode);
            setFormData({
              ...formData,
              type,
              api_url: '',
              api_token: '',
              compose_dir: formData.compose_dir === currentDefault
                ? defaultComposeDir(type, formData.mode)
                : formData.compose_dir,
            });
          }}
        >
          <SelectTrigger id="node-type">
            <SelectValue placeholder="Select type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4" />
                Local - Docker socket on this machine
              </div>
            </SelectItem>
            <SelectItem value="remote">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Remote - another Sencho instance
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {formData.type === 'remote' && (
        <div className="space-y-2">
          <Label htmlFor="node-mode">Mode</Label>
          <Combobox
            id="node-mode"
            value={formData.mode}
            onValueChange={(val) => {
              const mode = val as NodeMode;
              const currentDefault = defaultComposeDir(formData.type, formData.mode);
              setFormData({
                ...formData,
                mode,
                api_url: '',
                api_token: '',
                compose_dir: formData.compose_dir === currentDefault
                  ? defaultComposeDir(formData.type, mode)
                  : formData.compose_dir,
              });
            }}
            options={[
              { value: 'pilot_agent', label: 'Pilot Agent - outbound tunnel from remote host' },
              { value: 'proxy', label: 'Distributed API Proxy - primary dials the remote' },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Pilot Agent requires only outbound HTTPS from the remote host. Distributed API Proxy requires the remote host to expose an inbound port. Sencho Mesh works with both modes.
          </p>
        </div>
      )}

      {formData.type === 'remote' && formData.mode === 'proxy' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="node-api-url">Sencho API URL</Label>
            <Input
              id="node-api-url"
              placeholder="http://192.168.1.50:1852"
              value={formData.api_url}
              onChange={(e) => setFormData({ ...formData, api_url: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              The base URL of the Sencho instance running on the remote machine.
            </p>
            {formData.api_url.startsWith('http://') && (
              <div className="rounded-xl border border-warning/30 bg-warning/5 p-3 mt-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" strokeWidth={1.5} />
                  <p className="text-xs text-warning">
                    This URL uses plain HTTP. If this node is reachable over the public internet, use HTTPS
                    or a VPN to prevent token interception. HTTP is fine for private networks (LAN, VPN, VPC).
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="node-api-token">API Token</Label>
            <Input
              id="node-api-token"
              type="password"
              placeholder={isEdit
                ? 'Leave blank to keep the current token'
                : 'Paste token from remote Sencho → Settings → Nodes → Generate Token'}
              value={formData.api_token}
              onChange={(e) => setFormData({ ...formData, api_token: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {isEdit ? (
                'Leave blank to keep the existing token. Paste a new one only to rotate it.'
              ) : (
                <>Generate this token on the <strong>remote</strong> Sencho instance using the "Generate Node Token" button in its Settings → Nodes panel.</>
              )}
            </p>
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="node-compose-dir">Compose Directory</Label>
        <Input
          id="node-compose-dir"
          placeholder={defaultComposeDir(formData.type, formData.mode)}
          value={formData.compose_dir}
          onChange={(e) => setFormData({ ...formData, compose_dir: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {formData.type === 'remote' && formData.mode === 'pilot_agent'
            ? 'Absolute host path for compose stacks. The generated agent mounts this same path inside the container.'
            : 'The root directory where compose stack folders live on this node.'}
        </p>
      </div>
    </div>
  );

  const NodeActionModals = (
    <>
      <Modal
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (open) setFormData(defaultFormData);
        }}
        size="lg"
      >
        <ModalHeader
          kicker={formData.type === 'local' ? 'NODES · ADD LOCAL' : 'NODES · ADD REMOTE'}
          title={formData.type === 'local' ? 'Add local node' : 'Add remote node'}
          description="Register a Sencho node so you can manage it from this console."
        />
        <ModalBody>{renderFormFields(false)}</ModalBody>
        <ModalFooter
          secondary={
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
          }
          primary={
            <SettingsPrimaryButton
              size="sm"
              onClick={handleCreate}
              disabled={
                !formData.name ||
                (formData.type === 'remote' && formData.mode === 'proxy' && (!formData.api_url || !formData.api_token))
              }
            >
              Add node
            </SettingsPrimaryButton>
          }
        />
      </Modal>

      <Modal
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) {
            setEditingNodeId(null);
            setOriginalEditValues(null);
          }
        }}
        size="lg"
      >
        <ModalHeader kicker="NODES · EDIT" title="Edit node" description="Update the connection details for this node." />
        <ModalBody>
          {renderFormFields(true)}
          {formData.type === 'remote' && formData.mode === 'pilot_agent' && editingNodeId !== null && (
            <div className="rounded-md border border-card-border bg-card/50 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                Re-enroll the agent if the container was lost or the enrollment token expired. The previous tunnel is disconnected automatically.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const node = nodes.find((n) => n.id === editingNodeId);
                  if (node) regenerateEnrollment(node);
                }}
                className="gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                Regenerate enrollment token
              </Button>
            </div>
          )}
        </ModalBody>
        <ModalFooter
          secondary={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditOpen(false);
                setEditingNodeId(null);
                setOriginalEditValues(null);
              }}
            >
              Cancel
            </Button>
          }
          primary={
            <Button
              size="sm"
              onClick={handleEdit}
              disabled={
                !formData.name ||
                (formData.type === 'remote' && formData.mode === 'proxy' && !formData.api_url)
              }
            >
              Save changes
            </Button>
          }
        />
      </Modal>

      <Modal
        open={activeEnrollment !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveEnrollment(null);
            setEnrollmentCopied(false);
            setCreateOpen(false);
            setFormData(defaultFormData);
          }
        }}
        size="xl"
      >
        <ModalHeader
          kicker="NODES · PILOT ENROLLMENT"
          title="Enroll the pilot agent"
          description="Save the compose file on the remote host, then bring up the pilot agent."
        />
        <ModalBody>
          {activeEnrollment && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Deploy the pilot agent on <strong>{activeEnrollment.nodeName}</strong> with the Compose file below. The token is valid for 15 minutes and can only be used once.
              </p>

              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground/80">Step 1: save the file as <code className="font-mono text-[0.7rem] px-1 py-0.5 rounded bg-muted">compose.yaml</code></p>
                <div className="rounded-md border border-card-border bg-muted/50 p-3">
                  <pre className="text-xs font-mono whitespace-pre overflow-x-auto text-foreground/90">{activeEnrollment.enrollment.composeYaml}</pre>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground/80">Step 2: start the agent on the remote host</p>
                <div className="rounded-md border border-card-border bg-muted/50 p-3">
                  <code className="text-xs font-mono text-foreground/90">docker compose -f compose.yaml up -d</code>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Expires <span className="font-mono tabular-nums">{formatTimeUntil(activeEnrollment.enrollment.expiresAt)}</span> from now.
                </p>
                <Button size="sm" variant="outline" className="gap-1" onClick={copyEnrollment}>
                  {enrollmentCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  {enrollmentCopied ? 'Copied' : 'Copy compose file'}
                </Button>
              </div>
            </div>
          )}
        </ModalBody>
        <ModalFooter
          primary={
            <Button
              size="sm"
              onClick={() => {
                setActiveEnrollment(null);
                setEnrollmentCopied(false);
                setCreateOpen(false);
                setEditOpen(false);
                setFormData(defaultFormData);
              }}
            >
              Done
            </Button>
          }
        />
      </Modal>

      <ConfirmModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        kicker="NODES · DELETE · IRREVERSIBLE"
        title="Delete node"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      >
        <p className="text-sm text-stat-subtitle">
          Removes <span className="font-medium text-stat-value">{deletingNode?.name}</span> from this console. The remote instance and its containers are not affected.
        </p>
      </ConfirmModal>
    </>
  );

  return {
    openCreate,
    openEdit,
    openDelete,
    NodeActionModals,
  };
}
