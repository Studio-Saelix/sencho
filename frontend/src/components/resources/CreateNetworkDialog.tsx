import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TogglePill } from '@/components/ui/toggle-pill';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

const NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan', 'host', 'none'] as const;
type NetworkDriver = (typeof NETWORK_DRIVERS)[number];

interface CreateNetworkForm {
  name: string;
  driver: NetworkDriver;
  subnet: string;
  gateway: string;
  internal: boolean;
  attachable: boolean;
}

const EMPTY_FORM: CreateNetworkForm = {
  name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: false,
};

interface CreateNetworkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a network is created so the caller can refresh its view. */
  onCreated?: () => void | Promise<void>;
}

/**
 * Self-contained "Create network" modal. Owns its form state and posts to
 * `/system/networks`, so it can be reused from the Resources Networks tab and
 * the stack-detail Networking tab without sharing parent state.
 */
export function CreateNetworkDialog({ open, onOpenChange, onCreated }: CreateNetworkDialogProps) {
  const [form, setForm] = useState<CreateNetworkForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await apiFetch('/system/networks', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          driver: form.driver,
          subnet: form.subnet || undefined,
          gateway: form.gateway || undefined,
          internal: form.internal,
          attachable: form.attachable,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Failed to create network (${res.status})`);
      }
      toast.success(`Network "${form.name}" created`);
      onOpenChange(false);
      setForm(EMPTY_FORM);
      await onCreated?.();
    } catch (error) {
      const err = error as Record<string, unknown>;
      toast.error(String(err?.message || err?.error || 'Something went wrong.'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      <ModalHeader
        kicker="NETWORKS · NEW"
        title="Create network"
        description="Create a new Docker network for inter-container communication."
      />
      <ModalBody>
        <div className="space-y-2">
          <Label htmlFor="net-name" className="text-xs font-medium">Name</Label>
          <Input
            id="net-name"
            placeholder="my-network"
            className="font-mono text-sm"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="net-driver" className="text-xs font-medium">Driver</Label>
          <Combobox
            options={NETWORK_DRIVERS.map(d => ({ value: d, label: d }))}
            value={form.driver}
            onValueChange={v => setForm(f => ({ ...f, driver: (v || 'bridge') as NetworkDriver }))}
            placeholder="Select driver..."
            searchPlaceholder="Search drivers..."
            emptyText="No matching driver."
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="net-subnet" className="text-xs font-medium">Subnet <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="net-subnet"
              placeholder="172.20.0.0/16"
              className="font-mono text-sm"
              value={form.subnet}
              onChange={e => setForm(f => ({ ...f, subnet: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="net-gateway" className="text-xs font-medium">Gateway <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="net-gateway"
              placeholder="172.20.0.1"
              className="font-mono text-sm"
              value={form.gateway}
              onChange={e => setForm(f => ({ ...f, gateway: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex items-center gap-6 pt-1">
          <div className="flex items-center gap-2">
            <TogglePill
              id="net-internal"
              checked={form.internal}
              onChange={v => setForm(f => ({ ...f, internal: v }))}
            />
            <Label htmlFor="net-internal" className="text-xs cursor-pointer">Internal <span className="text-muted-foreground">(no external access)</span></Label>
          </div>
          <div className="flex items-center gap-2">
            <TogglePill
              id="net-attachable"
              checked={form.attachable}
              onChange={v => setForm(f => ({ ...f, attachable: v }))}
            />
            <Label htmlFor="net-attachable" className="text-xs cursor-pointer">Attachable</Label>
          </div>
        </div>
      </ModalBody>
      <ModalFooter
        hint={`DRIVER ${form.driver}`}
        secondary={
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
        }
        primary={
          <Button size="sm" onClick={handleCreate} disabled={!form.name.trim() || creating}>
            {creating ? 'Creating...' : 'Create network'}
          </Button>
        }
      />
    </Modal>
  );
}
