import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { TogglePill } from '@/components/ui/toggle-pill';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { canManageNode } from '@/lib/canManageNode';
import { GITOPS_SOURCE_CONTROLLER_CAPABILITY } from '@/lib/capabilities';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { NumberChip } from './SystemControls';

const DEFAULT_ON_MINS = 5;

function parsePollMins(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export function GitPollingControl() {
  const { can } = useAuth();
  const { activeNode, activeNodeMeta, hasCapability } = useNodes();
  const canEdit = canManageNode(can, activeNode?.id);
  const metaReady = !activeNode || activeNodeMeta != null;
  const hasController = metaReady && hasCapability(GITOPS_SOURCE_CONTROLLER_CAPABILITY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mins, setMins] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/git-sources/polling');
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        toast.error(err.error || 'Could not load Git polling settings.');
        return;
      }
      const data = await res.json() as { poll_interval_mins?: unknown };
      setMins(parsePollMins(data.poll_interval_mins));
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasController) return;
    void load();
  }, [load, activeNode?.id, hasController]);

  const save = async (next: number) => {
    setSaving(true);
    try {
      const res = await apiFetch('/git-sources/polling', {
        method: 'PATCH',
        body: JSON.stringify({ poll_interval_mins: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        toast.error(err.error || 'Could not save Git polling settings.');
        return;
      }
      const data = await res.json() as { poll_interval_mins?: unknown };
      const value = parsePollMins(data.poll_interval_mins);
      setMins(value);
      toast.success(value === 0 ? 'Git polling is off.' : `Git polling set to ${value} minutes.`);
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setSaving(false);
    }
  };

  if (!hasController) return null;

  return (
    <SettingsSection title="Git sources" kicker="this node">
      {loading ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <>
          <SettingsField
            label="Poll Git sources"
            helper="When on, this node fetches linked Git sources on a schedule. Off means polling is off (interval 0); sources still pull on demand, on webhook, and on retry. Linked sources with no override inherit this interval. Off by default."
          >
            <TogglePill
              checked={mins > 0}
              disabled={!canEdit || saving}
              onChange={(on) => { void save(on ? (mins > 0 ? mins : DEFAULT_ON_MINS) : 0); }}
              aria-label="Poll Git sources"
            />
          </SettingsField>
          {mins > 0 && (
            <SettingsField
              label="Poll interval"
              helper="Minutes between unattended fetches. Linked sources with no override inherit this interval."
            >
              <NumberChip
                value={String(mins)}
                onChange={(v) => {
                  const parsed = Number(v);
                  if (!Number.isInteger(parsed) || parsed < 1) return;
                  void save(Math.min(parsed, 10080));
                }}
                suffix="min"
                min={1}
                max={10080}
                disabled={!canEdit || saving}
              />
            </SettingsField>
          )}
        </>
      )}
    </SettingsSection>
  );
}
