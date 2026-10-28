import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';

import { AutoHeight } from '@/components/animate-ui/primitives/effects/auto-height';
import { useReducedTransition } from '@/components/animate-ui/primitives/use-reduced-transition';
import { STATUS_CARD_CLASS, STATUS_DOT_CLASS, type StatusTone } from '@/lib/statusTone';
import { cn } from '@/lib/utils';

const WORD_TONE_CLASS: Record<StatusTone, string> = {
  brand: 'text-brand',
  success: 'text-stat-subtitle',
  warning: 'text-warning',
  destructive: 'text-destructive',
  neutral: 'text-stat-subtitle',
};

/**
 * Some state words already lead with their stage ("artifact unavailable",
 * "rollout paused"). Printing the stage label first would stutter, so the label
 * is dropped when the word carries it.
 */
function wordCarriesLabel(stage: Pick<StatusPathStage, 'label' | 'word'>): boolean {
  return stage.word.toLowerCase().startsWith(`${stage.label.toLowerCase()} `);
}

export interface StatusPathAnswer {
  tone: StatusTone;
  /** Short state name, rendered in tracked mono. */
  title: string;
  /** One sentence saying what is true and what is waiting. */
  line: string;
  /** Specifics the sentence does not carry, such as a commit or a retry wait. */
  detail?: string | null;
  /** The raw status key, exposed as data-state so a surface can be asserted without matching copy. */
  status?: string;
  icon?: LucideIcon;
  /** The resolving verb(s). Apart from the Evidence toggle, the only controls the status itself adds. */
  action?: ReactNode;
  /** A quiet qualifier for an answer whose evidence is partial or unknown. */
  marker?: string;
  'data-testid'?: string;
}

export interface StatusPathStage {
  id: string;
  /** Names the stage ("source", "rollout"). */
  label: string;
  tone: StatusTone;
  /** The stage's state in two or three words. */
  word: string;
  /** Rendered under the row. Callers pass one only for a stage that is blocking and not already the Answer. */
  line?: string;
  /** The raw status key, exposed as data-state so a surface can be asserted without matching copy. */
  status?: string;
  /** Full sentence as the native hover title. Never the only place a blocker is stated. */
  title?: string;
  'data-testid'?: string;
}

export interface StatusPathProps {
  answer: StatusPathAnswer;
  /** Stages that apply to this object, in order. A stage that does not apply is left out, never passed. */
  stages: readonly StatusPathStage[];
  /** Evidence behind the answer. Collapsed until opened. */
  proof?: { label: string; children: ReactNode };
  className?: string;
  'data-testid'?: string;
}

/**
 * Layered status for a multi-stage system: one Answer, a quiet Path, collapsed
 * Proof. See DESIGN.md section 1.1 (Principle 2).
 *
 * The Answer is the only toned block, so the eye lands on one thing. The Path
 * is a single row of dots and words; only a stage the caller gave a `line`
 * speaks, and only the blocking ones should. The Proof holds everything that
 * backs the answer up, closed by default and one click away, so unknown or
 * partial evidence is never hidden: the Answer carries a marker for it.
 */
export function StatusPath({ answer, stages, proof, className, 'data-testid': testId }: StatusPathProps) {
  const [open, setOpen] = useState(false);
  const proofId = useId();
  const AnswerIcon = answer.icon;
  // AutoHeight springs the height, which the MotionConfig reduced-motion path does not cover.
  const heightTransition = useReducedTransition({ type: 'spring', stiffness: 300, damping: 30, bounce: 0, restDelta: 0.01 } as const);
  const speaking = stages.filter(stage => stage.line);

  return (
    <div data-testid={testId} className={cn('flex flex-col gap-2', className)}>
      <div
        data-testid={answer['data-testid'] ?? 'status-answer'}
        data-tone={answer.tone}
        data-state={answer.status}
        className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-card-bevel', STATUS_CARD_CLASS[answer.tone])}
      >
        {AnswerIcon && <AnswerIcon className="mt-px h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[11px] uppercase tracking-wide">{answer.title}</span>
            {answer.marker && (
              <span data-testid="status-marker" className="font-mono text-[10px] tracking-wide text-stat-subtitle">
                {answer.marker}
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{answer.line}</div>
          {answer.detail && (
            <div data-testid="status-answer-detail" className="mt-1 font-mono text-[11px] text-stat-subtitle">{answer.detail}</div>
          )}
        </div>
        {answer.action && <div className="flex shrink-0 items-center gap-2 max-md:flex-wrap">{answer.action}</div>}
      </div>

      {stages.length > 0 && (
        <ol data-testid="status-path" aria-label="Stages" className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1">
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              data-testid={stage['data-testid'] ?? `status-stage-${stage.id}`}
              data-tone={stage.tone}
              data-state={stage.status}
              title={stage.title}
              className="flex items-center gap-1"
            >
              {index > 0 && <span aria-hidden className="mr-1 h-px w-3 bg-card-border" />}
              <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[stage.tone])} />
              {!wordCarriesLabel(stage) && (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">{stage.label}</span>
              )}
              <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', WORD_TONE_CLASS[stage.tone])}>
                {stage.word}
              </span>
            </li>
          ))}
        </ol>
      )}

      {speaking.length > 0 && (
        <ul className="space-y-0.5 px-1">
          {speaking.map(stage => (
            <li key={stage.id} data-testid={`status-stage-line-${stage.id}`} className="font-mono text-[11px] leading-relaxed text-stat-subtitle">
              {/* The path row above already names this stage's state; here only the sentence behind it. */}
              <span className={cn('uppercase tracking-wide', WORD_TONE_CLASS[stage.tone])}>{stage.label}</span>
              {' · '}
              {stage.line}
            </li>
          ))}
        </ul>
      )}

      {proof && (
        <div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={proofId}
            onClick={() => setOpen(value => !value)}
            className="flex items-center gap-1 rounded-sm px-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11"
          >
            <ChevronRight
              className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
              strokeWidth={1.5}
              aria-hidden
            />
            {proof.label}
          </button>
          <AutoHeight deps={[open]} transition={heightTransition}>
            {open && (
              <div id={proofId} data-testid="status-proof" className="flex flex-col gap-3 pt-2">
                {proof.children}
              </div>
            )}
          </AutoHeight>
        </div>
      )}
    </div>
  );
}
