import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  Modal,
  ModalHeader,
  ModalBody,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { canUseNetworkName } from '@/lib/networking';
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
  renderError?: string;
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

function buildCreateCommands(networks: MissingExternalNetworkDto[]): string {
  return networks
    .filter((n) => n.safe && canUseNetworkName(n.name))
    .map((n) => n.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `docker network create ${name}`)
    .join('\n');
}

function formatUnsafeReason(net: MissingExternalNetworkDto): string {
  const parts: string[] = [];
  if (net.blockReason === 'unsupported_driver') {
    const kinds = [...new Set(net.declarations.map((d) => d.driverKind))];
    parts.push(`Driver kinds: ${kinds.join(', ')}`);
  }
  if (net.unsupportedFeatures.length > 0) {
    parts.push(`Unsupported: ${net.unsupportedFeatures.join(', ')}`);
  }
  if (net.blockReason === 'invalid_name') {
    parts.push('Invalid Docker network name');
  }
  if (net.blockReason === 'reserved_system') {
    parts.push('Reserved system network name');
  }
  return parts.join(' · ');
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
  const [copying, setCopying] = useState(false);

  const networks = payload?.networks ?? [];
  const allSafe = networks.length > 0 && networks.every((n) => n.safe);
  const canCreate = isAdmin && allSafe && payload?.status === 'ok';
  const createCommands = buildCreateCommands(networks);

  const copyCreateCommand = async () => {
    if (!createCommands) return;
    setCopying(true);
    try {
      await copyToClipboard(createCommands);
      toast.success('Create command copied');
    } catch (error) {
      console.error('Failed to copy network create command', error);
      toast.error('Copy failed');
    } finally {
      setCopying(false);
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
                    {formatUnsafeReason(net)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ModalBody>
      {/* Primary Cancel / Create pair; secondary actions live under More. */}
      <div className="flex flex-col-reverse gap-2 border-t border-glass-border px-4 py-3 max-md:items-stretch md:flex-row md:items-center md:justify-between">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={creating} className="max-md:w-full md:w-auto">
              <MoreHorizontal className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={onOpenNetworking}>
              Open Networking
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!createCommands || copying}
              onSelect={() => { void copyCreateCommand(); }}
            >
              Copy create command
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex flex-col-reverse gap-2 max-md:w-full md:flex-row md:items-center md:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={creating} className="max-md:w-full">
            Cancel deploy
          </Button>
          <Button
            size="sm"
            disabled={!canCreate || creating}
            className="max-md:w-full"
            onClick={(e) => {
              e.preventDefault();
              onCreateAndContinue();
            }}
          >
            {creating ? 'Creating…' : 'Create and continue'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
