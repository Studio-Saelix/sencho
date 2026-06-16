import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { GitComposeFilePicker, type GitBrowseResult } from './GitComposeFilePicker';

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
  authType: 'none' | 'token';
  token: string;
  /** When editing an existing source, the server tells us whether a token is already stored. */
  hasStoredToken: boolean;
  applyMode: ApplyMode;
}

export interface GitSourceFieldsProps extends GitSourceFieldsState {
  disabled?: boolean;
  /** 'edit' for the per-stack panel, 'create' for the new-stack dialog. Changes apply-mode copy. */
  variant: 'edit' | 'create';
  onRepoUrlChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onComposePathsChange: (value: string[]) => void;
  onContextDirChange: (value: string) => void;
  onSyncEnvChange: (value: boolean) => void;
  onAuthTypeChange: (value: 'none' | 'token') => void;
  onTokenChange: (value: string) => void;
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
  hasStoredToken,
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
  onApplyModeChange,
  onBrowse,
}: GitSourceFieldsProps) {
  const copy = APPLY_MODE_COPY[variant];
  const primaryComposePath = composePaths[0] ?? '';
  const canBrowse = repoUrl.trim() !== '' && branch.trim() !== '';

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
          placeholder="https://github.com/org/repo.git"
          value={repoUrl}
          onChange={(e) => onRepoUrlChange(e.target.value)}
          disabled={disabled}
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="git-source-branch">Branch</Label>
        <Input
          id="git-source-branch"
          placeholder="main"
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
      </div>

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
