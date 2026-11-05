import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/lib/clipboard';
import { downloadTextFile } from '@/lib/download';
import { toast } from '@/components/ui/toast-store';
import { BootstrapPathSummary } from './BootstrapPathSummary';
import { formatBootstrapPlanText } from './planText';
import type { BootstrapInspection, BootstrapPlan, BootstrapPlanStep } from './types';

function stepMeta(step: BootstrapPlanStep): string {
  const parts: string[] = [step.privilege];
  if (step.target?.mode) parts.push(`mode ${step.target.mode}`);
  if (step.target?.owner) parts.push(`${step.target.owner}:${step.target.group ?? step.target.owner}`);
  return parts.join(' · ');
}

function StepRow({ step }: { step: BootstrapPlanStep }) {
  return (
    <li className="flex flex-col gap-1 border-t border-muted py-2 first:border-t-0" data-testid={`plan-step-${step.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">{step.title}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">{stepMeta(step)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{step.rationale}</p>
      {step.target && (
        <code className="break-all font-mono text-[11px] text-stat-value">{step.target.path}</code>
      )}
      {step.command && (
        <pre className="overflow-x-auto rounded-md border border-card-border bg-muted/40 p-2 font-mono text-[11px] text-foreground/90">{step.command}</pre>
      )}
      {step.file && (
        <details className="rounded-md border border-card-border bg-muted/30">
          <summary className="cursor-pointer px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
            {step.file.path} ({step.file.mode}) · view content
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-card-border p-2 font-mono text-[11px] text-foreground/90">{step.file.content}</pre>
        </details>
      )}
    </li>
  );
}

function Group({ title, steps }: { title: string; steps: BootstrapPlanStep[] }) {
  if (steps.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={title}>
      <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{title}</h4>
      <ul className="rounded-lg border border-muted bg-card/40 px-3 py-1">
        {steps.map((step) => <StepRow key={step.id} step={step} />)}
      </ul>
    </section>
  );
}

export function BootstrapPlanStep({
  plan,
  inspection,
}: {
  plan: BootstrapPlan;
  inspection: BootstrapInspection;
}) {
  const [copied, setCopied] = useState(false);
  const text = formatBootstrapPlanText(plan);

  const copy = async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      toast.success('Plan copied to clipboard');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy the plan. Select the text and copy it manually.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[10px]">{plan.projectName}</Badge>
          <span className="font-mono text-[10px] text-stat-subtitle">
            {plan.containerName} · volume {plan.dataVolume} · image {plan.image.ref}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" strokeWidth={1.5} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />}
            {copied ? 'Copied' : 'Copy plan'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => downloadTextFile(`sencho-bootstrap-${plan.targetName}.txt`, text, 'text/plain')}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
            Download
          </Button>
        </div>
      </div>

      <BootstrapPathSummary composeDir={inspection.paths.composeDir} agentDir={inspection.paths.agentDir} />

      <div className="grid gap-1 rounded-lg border border-muted bg-card/30 px-3 py-2 font-mono text-[10px] text-stat-subtitle">
        <span>Generated {new Date(plan.generatedAt).toISOString()} · hub {plan.hubUrl}</span>
        <span>Image {plan.image.ref} · digest {plan.image.digest ?? 'resolved at execution'}</span>
        <span className="break-all">Evidence digest sha256:{plan.evidenceDigest}</span>
      </div>

      {plan.stages.map((stage, index) => (
        <Group key={stage.id} title={`${index + 1}. ${stage.title}`} steps={stage.steps} />
      ))}

      <div className="rounded-lg border border-muted bg-card/30 px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Not changed</p>
        <ul className="mt-1 space-y-1">
          {plan.skipped.length === 0 && <li className="text-xs text-muted-foreground">Nothing</li>}
          {plan.skipped.map((entry) => (
            <li key={entry.id} className="text-xs text-muted-foreground">{entry.reason}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-muted bg-card/30 px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Redactions</p>
        <ul className="mt-1 space-y-1">
          {plan.redactions.map((redaction) => (
            <li key={redaction.placeholder} className="text-xs text-muted-foreground">{redaction.placeholder}: {redaction.purpose}</li>
          ))}
        </ul>
      </div>

      <section className="space-y-2" aria-label="Expected after execution">
        <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Expected after execution</h4>
        <ul className="rounded-lg border border-muted bg-card/30 px-3 py-1">
          {plan.verification.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-2 border-t border-muted py-2 text-xs first:border-t-0">
              <Badge variant="outline" className="font-mono text-[9px]">{item.slice}</Badge>
              <span className="text-foreground/80">{item.title}</span>
              <span className="font-mono text-[10px] text-stat-subtitle">{item.expected}</span>
            </li>
          ))}
        </ul>
      </section>

      {plan.notices.length > 0 && (
        <ul className="space-y-1">
          {plan.notices.map((notice) => (
            <li key={notice} className="font-mono text-[10px] text-stat-subtitle">{notice}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-card-border pt-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Plan digest</span>
        <code className="break-all font-mono text-[10px] text-stat-value">sha256:{plan.digest}</code>
      </div>
    </div>
  );
}
