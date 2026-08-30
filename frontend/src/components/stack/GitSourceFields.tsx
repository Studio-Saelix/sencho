import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { GitComposeFilePicker, type GitBrowseResult } from './GitComposeFilePicker';

interface HostKeyRotationWarning {
  previous: string;
  current: string;
}

export type ApplyMode = 'review' | 'auto-write' | 'auto-deploy';

/**
 * Mirror of the backend's env-path default (see `/api/stacks/from-git` and
 * the git-source PUT handler): if the user ticks "Sync .env" without
 * specifying an explicit path, the service reads `<dirname>/.env`
 * alongside the primary compose file. Surfacing this in the form saves the
 * user a round-trip to figure out which directory the `.env` will come from.
 */
function computeDefaultEnvPath(composePath: string): string {
  const normalized = composePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return '.env';
  return `${normalized.slice(0, slash)}/.env`;
}

export interface GitSourceFieldsState {
  repoUrl: string;
  branch: string;
  composePaths: string[];
  contextDir: string;
  syncEnv: boolean;
  authType: 'none' | 'token' | 'deploy_key';
  token: string;
  deployKey: string;
  caBundle: string;
  sshKnownHostsEntry: string;
  sshHostKeyFingerprint: string;
  /** When editing an existing source, the server tells us whether a token is already stored. */
  hasStoredToken: boolean;
  hasStoredDeployKey: boolean;
  hasStoredCaBundle: boolean;
  storedHostKeyFingerprint: string | null;
  applyMode: ApplyMode;
}

export interface GitSourceFieldsProps extends GitSourceFieldsState {
  disabled?: boolean;
  /** When probing host keys from the edit panel, scopes the request to stack:edit. */
  stackName?: string;
  /** 'edit' for the per-stack panel, 'create' for the new-stack dialog. Changes apply-mode copy. */
  variant: 'edit' | 'create';
  onRepoUrlChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onComposePathsChange: (value: string[]) => void;
  onContextDirChange: (value: string) => void;
  onSyncEnvChange: (value: boolean) => void;
  onAuthTypeChange: (value: 'none' | 'token' | 'deploy_key') => void;
  onTokenChange: (value: string) => void;
  onDeployKeyChange: (value: string) => void;
  onCaBundleChange: (value: string) => void;
  /** Explicit revocation: the operator clicked "Remove stored CA". Sends `remove_ca_bundle: true` on the next save. */
  onRemoveCaBundle: () => void;
  onSshKnownHostsEntryChange: (value: string) => void;
  onSshHostKeyFingerprintChange: (value: string) => void;
  onApplyModeChange: (value: ApplyMode) => void;
  /** Runs the correct browse endpoint (create vs edit); returns the repo file list or null on failure. */
  onBrowse: () => Promise<GitBrowseResult | null>;
}

const APPLY_MODE_COPY: Record<'edit' | 'create', Record<ApplyMode, { title: string; description: string }>> = {
  edit: {
    'review': { title: 'Review only', description: 'Webhook fetches and flags a pending diff. You apply manually.' },
    'auto-write': { title: 'Auto-write files', description: 'Webhook writes to disk. You deploy manually.' },
    'auto-deploy': { title: 'Auto-deploy', description: 'Webhook writes and deploys in one step.' },
  },
  create: {
    'review': { title: 'Review only', description: 'Future webhook pulls surface a diff you apply manually.' },
    'auto-write': { title: 'Auto-write files', description: 'Future webhook pulls write to disk. You deploy manually.' },
    'auto-deploy': { title: 'Auto-deploy', description: 'Future webhook pulls write and redeploy automatically.' },
  },
};

export function GitSourceFields({
  repoUrl,
  branch,
  composePaths,
  contextDir,
  syncEnv,
  authType,
  token,
  deployKey,
  caBundle,
  sshHostKeyFingerprint,
  hasStoredToken,
  hasStoredDeployKey,
  hasStoredCaBundle,
  storedHostKeyFingerprint,
  applyMode,
  disabled = false,
  variant,
  onRepoUrlChange,
  onBranchChange,
  onComposePathsChange,
  onContextDirChange,
  onSyncEnvChange,
  onAuthTypeChange,
  onTokenChange,
  onDeployKeyChange,
  onCaBundleChange,
  onRemoveCaBundle,
  onSshKnownHostsEntryChange,
  onSshHostKeyFingerprintChange,
  onApplyModeChange,
  onBrowse,
  stackName,
}: GitSourceFieldsProps) {
  const copy = APPLY_MODE_COPY[variant];
  const primaryComposePath = composePaths[0] ?? '';
  const canBrowse = !!repoUrl?.trim() && !!branch?.trim();
  const isHttpsRepo = /^https:\/\//i.test(repoUrl.trim());
  const [hostKeyRotation, setHostKeyRotation] = useState<HostKeyRotationWarning | null>(null);

  useEffect(() => {
    setHostKeyRotation(null);
  }, [repoUrl]);

  const probeHostKey = async () => {
    if (!repoUrl.trim()) {
      toast.error('Enter a repository URL first.');
      return;
    }
    try {
      const res = await apiFetch('/git-sources/ssh-host-key', {
        method: 'POST',
        body: JSON.stringify({
          repo_url: repoUrl.trim(),
          ...(stackName ? { stack_name: stackName } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to fetch host key.');
        return;
      }
      const data = await res.json() as { keys?: Array<{ fingerprint: string; line: string }> };
      const first = data.keys?.[0];
      if (!first) {
        toast.error('No host keys returned.');
        return;
      }
      const previousFingerprint = (storedHostKeyFingerprint ?? sshHostKeyFingerprint).trim();
      if (previousFingerprint && previousFingerprint !== first.fingerprint) {
        setHostKeyRotation({ previous: previousFingerprint, current: first.fingerprint });
        toast.warning('Host key fingerprint changed. Review the new fingerprint before saving.');
      } else {
        setHostKeyRotation(null);
        if (!previousFingerprint) {
          toast.success(`Trusted host key fingerprint: ${first.fingerprint}`);
        }
      }
      onSshHostKeyFingerprintChange(first.fingerprint);
      onSshKnownHostsEntryChange(first.line);
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    }
  };

  const radioOption = (mode: ApplyMode) => (
    <button
      type="button"
      key={mode}
      onClick={() => !disabled && onApplyModeChange(mode)}
      disabled={disabled}
      className={cn(
        'w-full text-left rounded-md border px-3 py-2 transition-colors',
        applyMode === mode
          ? 'border-brand/60 bg-brand/5'
          : 'border-glass-border hover:border-card-border-hover',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        <div className={cn(
          'w-3.5 h-3.5 rounded-full border mt-0.5 shrink-0 transition-colors',
          applyMode === mode ? 'border-brand bg-brand' : 'border-stat-subtitle',
        )} />
        <div>
          <p className="text-xs font-medium">{copy[mode].title}</p>
          <p className="text-[11px] text-stat-subtitle mt-0.5">{copy[mode].description}</p>
        </div>
      </div>
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="git-source-repo">Repository URL</Label>
        <Input
          id="git-source-repo"
          placeholder="https://github.com/org/repo.git or user@host:org/repo.git"
          value={repoUrl}
          onChange={(e) => onRepoUrlChange(e.target.value)}
          disabled={disabled}
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="git-source-branch">Ref</Label>
        <Input
          id="git-source-branch"
          placeholder="main, v1.0, or commit SHA"
          value={branch}
          onChange={(e) => onBranchChange(e.target.value)}
          disabled={disabled}
          className="font-mono text-xs"
        />
      </div>

      <GitComposeFilePicker
        composePaths={composePaths}
        contextDir={contextDir}
        onComposePathsChange={onComposePathsChange}
        onContextDirChange={onContextDirChange}
        onBrowse={onBrowse}
        canBrowse={canBrowse}
        disabled={disabled}
      />

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id="git-source-sync-env"
            checked={syncEnv}
            onCheckedChange={(c) => onSyncEnvChange(c === true)}
            disabled={disabled}
          />
          <Label htmlFor="git-source-sync-env" className="text-xs cursor-pointer">
            Also sync sibling <span className="font-mono">.env</span> file
          </Label>
        </div>
        {syncEnv && primaryComposePath.trim() !== '' && (
          <p className="text-[11px] text-stat-subtitle pl-6">
            Will read{' '}
            <span className="font-mono">
              {computeDefaultEnvPath(primaryComposePath)}
            </span>{' '}
            from the repository.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Authentication</Label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => !disabled && onAuthTypeChange('none')}
            disabled={disabled}
            className={cn(
              'flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors',
              authType === 'none'
                ? 'border-brand/60 bg-brand/5'
                : 'border-glass-border hover:border-card-border-hover',
            )}
          >
            Public (no auth)
          </button>
          <button
            type="button"
            onClick={() => !disabled && onAuthTypeChange('token')}
            disabled={disabled}
            className={cn(
              'flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors',
              authType === 'token'
                ? 'border-brand/60 bg-brand/5'
                : 'border-glass-border hover:border-card-border-hover',
            )}
          >
            Personal Access Token
          </button>
          <button
            type="button"
            onClick={() => !disabled && onAuthTypeChange('deploy_key')}
            disabled={disabled}
            className={cn(
              'flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors',
              authType === 'deploy_key'
                ? 'border-brand/60 bg-brand/5'
                : 'border-glass-border hover:border-card-border-hover',
            )}
          >
            Deploy key (SSH)
          </button>
        </div>
        {authType === 'token' && (
          <div className="space-y-1.5">
            <Input
              type="password"
              placeholder={hasStoredToken ? '••••••••  (leave blank to keep current)' : 'ghp_xxx... or glpat-xxx...'}
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              disabled={disabled}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-[11px] text-stat-subtitle">
              Token is encrypted at rest and never returned from the API.
            </p>
          </div>
        )}
        {authType === 'deploy_key' && (
          <div className="space-y-2">
            {hostKeyRotation && (
              <div
                data-testid="ssh-host-key-rotation-warning"
                className="rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[12px] leading-relaxed text-warning"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                  <div>
                    <p className="font-medium">Host key fingerprint changed</p>
                    <p className="mt-1">
                      The server presented a different key than the one you trusted. Confirm this is an expected rotation before saving.
                    </p>
                    <p className="mt-2 font-mono text-[11px]">
                      <span className="text-stat-subtitle">Previously trusted: </span>
                      {hostKeyRotation.previous}
                    </p>
                    <p className="mt-1 font-mono text-[11px]">
                      <span className="text-stat-subtitle">New fingerprint: </span>
                      {hostKeyRotation.current}
                    </p>
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => void probeHostKey()}>
                Fetch host key fingerprint
              </Button>
              {(sshHostKeyFingerprint || storedHostKeyFingerprint) && (
                <span
                  className={cn(
                    'text-[11px] font-mono',
                    hostKeyRotation ? 'text-warning' : 'text-stat-subtitle',
                  )}
                >
                  {sshHostKeyFingerprint || storedHostKeyFingerprint}
                </span>
              )}
            </div>
            <textarea
              placeholder={hasStoredDeployKey ? 'Private key stored (paste to replace)' : 'Paste PEM private key'}
              value={deployKey}
              onChange={(e) => onDeployKeyChange(e.target.value)}
              disabled={disabled}
              className="w-full min-h-[88px] rounded-md border border-glass-border bg-transparent px-3 py-2 font-mono text-xs"
            />
            <p className="text-[11px] text-stat-subtitle">
              Deploy keys are encrypted at rest. Host keys are verified strictly; fetch the fingerprint before saving a new SSH URL.
            </p>
          </div>
        )}
      </div>

      {isHttpsRepo && (
        <div className="space-y-2">
          <Label htmlFor="git-source-ca-bundle">Custom CA certificate (optional)</Label>
          <textarea
            id="git-source-ca-bundle"
            placeholder={hasStoredCaBundle ? 'CA bundle stored (paste to replace)' : 'Paste PEM certificate(s) for a private CA'}
            value={caBundle}
            onChange={(e) => onCaBundleChange(e.target.value)}
            disabled={disabled}
            className="w-full min-h-[72px] rounded-md border border-glass-border bg-transparent px-3 py-2 font-mono text-xs"
          />
          <p className="text-[11px] text-stat-subtitle">
            By default Sencho trusts the system certificate store. Add a custom CA when your git server uses a private certificate authority. The bundle is encrypted at rest and never returned from the API.
          </p>
          {hasStoredCaBundle && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={onRemoveCaBundle}
              >
                Remove stored CA
              </Button>
              <span className="text-[11px] text-stat-subtitle">
                Revokes trust for this CA on the next save. The textarea starts empty, so saving without changes will keep the stored CA.
              </span>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label>Apply behavior</Label>
        <div className="space-y-1.5">
          {radioOption('review')}
          {radioOption('auto-write')}
          {radioOption('auto-deploy')}
        </div>
      </div>
    </div>
  );
}
