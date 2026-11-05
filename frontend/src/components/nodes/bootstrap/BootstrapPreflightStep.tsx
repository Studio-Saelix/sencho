import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { StatusPath, type StatusPathStage } from '@/components/ui/status-path';
import type { StatusTone } from '@/lib/statusTone';
import { BootstrapPathSummary } from './BootstrapPathSummary';
import type { BootstrapCheck, BootstrapInspection, BootstrapStatus } from './types';

const STATUS_TONE: Record<BootstrapStatus, StatusTone> = {
  pass: 'success',
  warn: 'warning',
  blocked: 'destructive',
  unknown: 'neutral',
};

const STATUS_WORD: Record<BootstrapStatus, string> = {
  pass: 'ok',
  warn: 'warning',
  blocked: 'blocked',
  unknown: 'unknown',
};

const CATEGORY_STAGES: Array<{ id: string; label: string; ids: string[] }> = [
  { id: 'identity', label: 'host key', ids: ['ssh_host_key', 'ssh_auth'] },
  { id: 'host', label: 'system', ids: ['os_supported', 'arch_supported', 'clock_skew'] },
  { id: 'docker', label: 'docker', ids: ['docker_cli', 'docker_daemon', 'compose_plugin', 'docker_socket', 'apt_source'] },
  { id: 'paths', label: 'directories', ids: ['compose_dir', 'agent_dir', 'path_separation', 'path_persistence'] },
  { id: 'conflicts', label: 'conflicts', ids: ['agent_conflict', 'existing_workloads', 'node_name'] },
  { id: 'network', label: 'network', ids: ['hub_url', 'hub_reachable', 'sudo'] },
];

const SEVERITY_ORDER: BootstrapStatus[] = ['blocked', 'unknown', 'warn', 'pass'];

function worst(statuses: BootstrapStatus[]): BootstrapStatus {
  for (const candidate of SEVERITY_ORDER) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'pass';
}

function stagesFromChecks(checks: BootstrapCheck[]): StatusPathStage[] {
  return CATEGORY_STAGES.map((stage) => {
    const rows = checks.filter((check) => stage.ids.includes(check.id));
    const status = worst(rows.map((row) => row.status));
    const blocking = rows.find((row) => row.status === 'blocked');
    return {
      id: stage.id,
      label: stage.label,
      tone: STATUS_TONE[status],
      word: STATUS_WORD[status],
      line: blocking ? blocking.summary : undefined,
      status,
    };
  }).filter((stage) => stage.word !== 'ok' || true);
}

function CheckRow({ check }: { check: BootstrapCheck }) {
  return (
    <li className="flex flex-col gap-1 border-t border-muted py-2 first:border-t-0" data-testid={`bootstrap-check-${check.id}`} data-status={check.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={check.status === 'blocked' ? 'destructive' : check.status === 'pass' ? 'secondary' : 'outline'}
          className="font-mono text-[9px] uppercase tracking-[0.14em]"
        >
          {check.status}
        </Badge>
        <span className="text-xs font-medium text-foreground/80">{check.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">{check.summary}</p>
      {check.remediation && (
        <p className="text-xs text-stat-subtitle">{check.remediation}</p>
      )}
    </li>
  );
}

export function BootstrapPreflightStep({
  inspection,
  blocked,
  hostKeyTrust,
  pinnedFingerprint,
  trusted,
  onTrustedChange,
  replacing,
  onReplaceRequest,
}: {
  inspection: BootstrapInspection;
  blocked: boolean;
  hostKeyTrust: 'trusted' | 'unknown' | 'changed';
  pinnedFingerprint: string | null;
  trusted: boolean;
  onTrustedChange: (trusted: boolean) => void;
  replacing: boolean;
  onReplaceRequest: () => void;
}) {
  const tone: StatusTone = blocked ? 'destructive' : 'success';
  const stages = stagesFromChecks(inspection.checks);
  const blockers = inspection.checks.filter((check) => check.status === 'blocked');
  const answers = blocked
    ? `${inspection.blockers} blocker${inspection.blockers === 1 ? '' : 's'} must be resolved before a plan can be generated.`
    : `The host can be prepared. ${inspection.warnings} warning${inspection.warnings === 1 ? '' : 's'} will be carried into the plan.`;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-muted bg-card/40 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-stat-icon" strokeWidth={1.5} aria-hidden />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Host key</span>
          </div>
          <code className="break-all font-mono text-[11px] text-stat-value">{inspection.hostKey.fingerprint}</code>
        </div>
        <p className="mt-1 font-mono text-[10px] text-stat-subtitle">
          {inspection.hostKey.algorithm} · dialed {inspection.target.address}
        </p>

        {hostKeyTrust === 'changed' && (
          <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
            <p className="text-xs text-destructive">
              This key differs from the pinned key. Only replace it if you know the host was rebuilt.
            </p>
            {pinnedFingerprint && (
              <p className="mt-1 break-all font-mono text-[10px] text-stat-subtitle">Pinned: {pinnedFingerprint}</p>
            )}
            {!replacing ? (
              <button
                type="button"
                className="mt-2 text-xs font-medium text-brand underline-offset-2 hover:underline"
                onClick={onReplaceRequest}
              >
                Replace the pinned key
              </button>
            ) : (
              <p className="mt-2 text-xs text-destructive">
                The replacement is confirmed when you run the preflight.
              </p>
            )}
          </div>
        )}

        {hostKeyTrust === 'unknown' && (
          <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={trusted}
              onChange={(event) => onTrustedChange(event.target.checked)}
            />
            I trust this host key. Compare it with <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server.
          </label>
        )}

        {hostKeyTrust === 'trusted' && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-stat-subtitle">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            This key matches the pin for this host.
          </p>
        )}
      </div>

      <StatusPath
        answer={{
          tone,
          title: blocked ? 'Blocked' : 'Ready to plan',
          line: answers,
          icon: blocked ? AlertTriangle : CheckCircle2,
          status: blocked ? 'blocked' : 'pass',
        }}
        stages={stages}
        proof={{
          label: `${inspection.checks.length} checks`,
          children: (
            <ul className="rounded-lg border border-muted bg-card/40 px-3 py-1">
              {inspection.checks.map((check) => <CheckRow key={check.id} check={check} />)}
            </ul>
          ),
        }}
      />

      <BootstrapPathSummary composeDir={inspection.paths.composeDir} agentDir={inspection.paths.agentDir} />

      {blockers.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Blockers</h4>
          <ul className="space-y-2">
            {blockers.map((check) => (
              <li key={check.id} className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                <p className="font-medium text-destructive">{check.label}</p>
                <p className="mt-1 text-foreground/80">{check.summary}</p>
                {check.remediation && <p className="mt-1 text-stat-subtitle">{check.remediation}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
