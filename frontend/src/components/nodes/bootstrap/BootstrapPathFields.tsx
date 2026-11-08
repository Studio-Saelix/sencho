import { useId } from 'react';
import { ChevronRight } from 'lucide-react';
import { AutoHeight } from '@/components/animate-ui/primitives/effects/auto-height';
import { useReducedTransition } from '@/components/animate-ui/primitives/use-reduced-transition';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BootstrapCapabilities } from './types';

/**
 * The primary Compose directory field and the one Advanced configuration
 * disclosure that holds the Agent installation directory.
 *
 * One collapsed disclosure, one level only. When the advanced value differs
 * from the default, the trigger shows the current path so a non-default value
 * is never hidden.
 */

interface BootstrapPathFieldsProps {
  composeDir: string;
  agentDir: string;
  defaultAgentDir: string;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  onChange: (field: 'composeDir' | 'agentDir', value: string) => void;
  onResetAgentDir: () => void;
  composeError: string | null;
  agentError: string | null;
  capabilities: BootstrapCapabilities;
}

export function BootstrapPathFields({
  composeDir,
  agentDir,
  defaultAgentDir,
  advancedOpen,
  onAdvancedOpenChange,
  onChange,
  onResetAgentDir,
  composeError,
  agentError,
  capabilities,
}: BootstrapPathFieldsProps) {
  const composeErrorId = useId();
  const agentErrorId = useId();
  const advancedId = useId();
  const heightTransition = useReducedTransition({ type: 'spring', stiffness: 300, damping: 30, bounce: 0, restDelta: 0.01 } as const);
  const agentIsCustom = agentDir !== defaultAgentDir;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="bootstrap-compose-dir" className="font-mono text-[10px] uppercase tracking-[0.18em]">
          Compose stacks directory
        </Label>
        <Input
          id="bootstrap-compose-dir"
          value={composeDir}
          onChange={(event) => onChange('composeDir', event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={composeError ? true : undefined}
          aria-describedby={composeError ? composeErrorId : undefined}
        />
        {composeError ? (
          <p id={composeErrorId} role="alert" className="text-xs text-destructive">{composeError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Holds the Compose project folders Sencho manages. Existing folders are preserved, never rewritten or chowned. The Pilot mounts this directory at the same path inside its container.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-card-border bg-card/30">
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls={advancedOpen ? advancedId : undefined}
          onClick={() => onAdvancedOpenChange(!advancedOpen)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 shrink-0 text-stat-subtitle transition-transform', advancedOpen && 'rotate-90')}
            strokeWidth={1.5}
            aria-hidden
          />
          <span className="text-xs font-medium">Advanced configuration</span>
          {agentIsCustom && !advancedOpen ? (
            <code className="ml-auto break-all font-mono text-[10px] text-stat-subtitle">{agentDir}</code>
          ) : (
            <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
              {advancedOpen ? 'Hide' : 'Show'}
            </span>
          )}
        </button>
        <AutoHeight deps={[advancedOpen]} transition={heightTransition}>
          {advancedOpen && (
            <div id={advancedId} className="space-y-2 border-t border-card-border/60 px-3 py-3">
              <Label htmlFor="bootstrap-agent-dir" className="font-mono text-[10px] uppercase tracking-[0.18em]">
                Pilot Agent installation directory
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="bootstrap-agent-dir"
                  value={agentDir}
                  onChange={(event) => onChange('agentDir', event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={agentError ? true : undefined}
                  aria-describedby={agentError ? agentErrorId : undefined}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 shrink-0 text-xs"
                  onClick={onResetAgentDir}
                  disabled={!agentIsCustom}
                >
                  Reset
                </Button>
              </div>
              {agentError ? (
                <p id={agentErrorId} role="alert" className="text-xs text-destructive">{agentError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Separate from the stacks directory, so the agent is never listed as a stack. Holds the Pilot's compose file and, when the hub uses native TLS, its CA. Persistent agent data stays in the {capabilities.fixed.dataVolume} volume.
                </p>
              )}
            </div>
          )}
        </AutoHeight>
      </div>
    </div>
  );
}
