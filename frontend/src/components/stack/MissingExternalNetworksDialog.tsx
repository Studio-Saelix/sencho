import { useMemo, useState } from 'react';
import {
  Modal,
  ModalHeader,
  ModalBody,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import {
  buildExternalNetworksSnippet,
  canUseNetworkName,
} from '@/lib/networking';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';

export type MissingExternalNetworkDto = {
  name: string;
  keys: string[];
  declarations: Array<{
    key: string;
    driverKind: string;
    unsupportedFeatures: string[];
  }>;
  safe: boolean;
  blockReason?: string;
  unsupportedFeatures: string[];
  creationSpec: { driver: 'bridge'; options: 'default' } | null;
};

export type MissingExternalNetworksPayload = {
  status: 'ok' | 'render_unavailable' | 'runtime_unavailable';
  autoCreateEnabled: boolean;
  stackName: string;
  networks: MissingExternalNetworkDto[];
};

interface MissingExternalNetworksDialogProps {
  open: boolean;
  payload: MissingExternalNetworksPayload | null;
  isAdmin: boolean;
  creating?: boolean;
  onCancel: () => void;
  onOpenNetworking: () => void;
  onCreateAndContinue: () => void;
}

export function MissingExternalNetworksDialog({
  open,
  payload,
  isAdmin,
  creating = false,
  onCancel,
  onOpenNetworking,
  onCreateAndContinue,
}: MissingExternalNetworksDialogProps) {
  const [busyCopy, setBusyCopy] = useState<'cmd' | 'snippet' | null>(null);

  const networks = payload?.networks ?? [];
  const allSafe = networks.length > 0 && networks.every((n) => n.safe);
  const canCreate = isAdmin && allSafe && payload?.status === 'ok';

  const snippet = useMemo(
    () => buildExternalNetworksSnippet(
      networks.flatMap((n) => n.keys.map((key) => ({ key, name: n.name }))),
    ),
    [networks],
  );

  const dockerCommands = useMemo(() => {
    return networks
      .filter((n) => n.safe && canUseNetworkName(n.name))
      .map((n) => n.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => `docker network create ${name}`)
      .join('\n');
  }, [networks]);

  const copyText = async (kind: 'cmd' | 'snippet', text: string | null) => {
    if (!text) return;
    setBusyCopy(kind);
    try {
      await copyToClipboard(text);
      toast.success(kind === 'cmd' ? 'Docker command copied' : 'Compose snippet copied');
    } catch (error) {
      console.error('Failed to copy external-network text', error);
      toast.error('Copy failed');
    } finally {
      setBusyCopy(null);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onCancel(); }} size="xl">
      <ModalHeader
        kicker={`${(payload?.stackName ?? 'STACK').toUpperCase()} · EXTERNAL NETWORKS`}
        title="Missing external networks"
        description="Docker Compose will not create external networks. Create safe bridge networks here, or cancel the deploy."
      />
      <ModalBody>
        <div className="max-h-[min(50vh,28rem)] overflow-y-auto border border-glass-border bg-card/60 shadow-card-bevel divide-y divide-glass-border">
          {payload?.status !== 'ok' ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              {payload?.status === 'render_unavailable'
                ? 'Sencho could not render this stack\'s Compose model to check external networks.'
                : 'Sencho could not read Docker networking state on this node.'}
            </div>
          ) : networks.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">No missing external networks.</div>
          ) : (
            networks.map((net) => (
              <div key={net.name} className="px-4 py-3 space-y-1.5">
                <div className="font-mono text-sm">{net.name}</div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                  Compose keys: {net.keys.join(', ')}
                </div>
                {net.safe && net.creationSpec ? (
                  <div className="text-xs text-muted-foreground">
                    Sencho can create a {net.creationSpec.driver} network with {net.creationSpec.options} options.
                  </div>
                ) : (
                  <div className="text-xs text-destructive">
                    {[
                      net.blockReason === 'unsupported_driver'
                        ? `Driver kinds: ${[...new Set(net.declarations.map((d) => d.driverKind))].join(', ')}`
                        : null,
                      net.unsupportedFeatures.length > 0
                        ? `Unsupported: ${net.unsupportedFeatures.join(', ')}`
                        : null,
                      net.blockReason === 'invalid_name' ? 'Invalid Docker network name' : null,
                      net.blockReason === 'reserved_system' ? 'Reserved system network name' : null,
                    ].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ModalBody>
      {/* Dialog-specific responsive actions (avoid shared ModalFooter row overflow on phone). */}
      <div className="flex flex-col-reverse gap-2 border-t border-glass-border px-4 py-3 max-md:items-stretch md:flex-row md:flex-wrap md:items-center md:justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={creating}>
          Cancel deploy
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenNetworking} disabled={creating}>
          Open Networking
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!dockerCommands || creating || busyCopy === 'cmd'}
          onClick={() => void copyText('cmd', dockerCommands)}
        >
          Copy Docker command
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!snippet || creating || busyCopy === 'snippet'}
          onClick={() => void copyText('snippet', snippet)}
        >
          Copy Compose snippet
        </Button>
        <Button
          size="sm"
          disabled={!canCreate || creating}
          onClick={(e) => {
            e.preventDefault();
            onCreateAndContinue();
          }}
        >
          {creating ? 'Creating…' : 'Create and continue'}
        </Button>
      </div>
    </Modal>
  );
}
