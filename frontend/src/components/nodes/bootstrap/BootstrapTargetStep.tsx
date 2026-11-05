import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BootstrapPathFields } from './BootstrapPathFields';
import { useNodeBootstrap } from './useNodeBootstrap';

/** Step 1: connection details and both directories. */
export function BootstrapTargetStep({ wizard }: { wizard: ReturnType<typeof useNodeBootstrap> }) {
  const { form, setField, fieldError, capabilities, advancedOpen, setAdvancedOpen, resetAgentDir } = wizard;
  const insecure = typeof window !== 'undefined' && window.location.protocol !== 'https:';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="bootstrap-name" className="font-mono text-[10px] uppercase tracking-[0.18em]">Node name</Label>
          <Input
            id="bootstrap-name"
            placeholder="e.g., Media server"
            value={form.targetName}
            onChange={(event) => setField('targetName', event.target.value)}
          />
          {fieldError('targetName') && <p role="alert" className="text-xs text-destructive">{fieldError('targetName')}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="bootstrap-host" className="font-mono text-[10px] uppercase tracking-[0.18em]">Host</Label>
          <Input
            id="bootstrap-host"
            placeholder="server.example.com"
            value={form.host}
            onChange={(event) => setField('host', event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          {fieldError('host') && <p role="alert" className="text-xs text-destructive">{fieldError('host')}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="bootstrap-port" className="font-mono text-[10px] uppercase tracking-[0.18em]">SSH port</Label>
          <Input
            id="bootstrap-port"
            inputMode="numeric"
            value={form.port}
            onChange={(event) => setField('port', event.target.value)}
            className="font-mono"
          />
          {fieldError('port') && <p role="alert" className="text-xs text-destructive">{fieldError('port')}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="bootstrap-user" className="font-mono text-[10px] uppercase tracking-[0.18em]">SSH user</Label>
          <Input
            id="bootstrap-user"
            value={form.username}
            onChange={(event) => setField('username', event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          {fieldError('username') && <p role="alert" className="text-xs text-destructive">{fieldError('username')}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="bootstrap-key" className="font-mono text-[10px] uppercase tracking-[0.18em]">Private key</Label>
        <textarea
          id="bootstrap-key"
          value={form.privateKey}
          onChange={(event) => setField('privateKey', event.target.value)}
          autoComplete="off"
          spellCheck={false}
          rows={4}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-invalid={fieldError('privateKey') ? true : undefined}
        />
        {fieldError('privateKey') ? (
          <p role="alert" className="text-xs text-destructive">{fieldError('privateKey')}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Used for this preflight only. It is never stored, logged or included in the plan.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="bootstrap-passphrase" className="font-mono text-[10px] uppercase tracking-[0.18em]">Key passphrase</Label>
        <Input
          id="bootstrap-passphrase"
          type="password"
          value={form.passphrase}
          onChange={(event) => setField('passphrase', event.target.value)}
          autoComplete="off"
          placeholder="Only if the key is encrypted"
        />
      </div>

      {insecure && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" strokeWidth={1.5} aria-hidden />
            <p className="text-xs text-warning">
              This page is not using HTTPS. The private key travels over the network in cleartext. Serve Sencho over HTTPS before using a real key.
            </p>
          </div>
        </div>
      )}

      <BootstrapPathFields
        composeDir={form.composeDir}
        agentDir={form.agentDir}
        defaultAgentDir={capabilities.defaults.agentDir}
        advancedOpen={advancedOpen}
        onAdvancedOpenChange={setAdvancedOpen}
        onChange={setField}
        onResetAgentDir={resetAgentDir}
        composeError={fieldError('composeDir')}
        agentError={fieldError('agentDir')}
        capabilities={capabilities}
      />
    </div>
  );
}
