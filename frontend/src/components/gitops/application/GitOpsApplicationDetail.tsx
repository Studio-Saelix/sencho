import type { ReactNode } from 'react';
import { CircleSlash } from 'lucide-react';

import GitOpsApprovalChips from '@/components/gitops/GitOpsApprovalChips';
import GitOpsCaveats from '@/components/gitops/GitOpsCaveats';
import GitOpsDriftRow from '@/components/gitops/GitOpsDriftRow';
import { GitOpsFacetCards } from '@/components/gitops/GitOpsFacetCards';
import { IdentityRow } from '@/components/gitops/GitOpsIdentityRow';
import GitOpsStateCard, { GitOpsFaultCard } from '@/components/gitops/GitOpsStateCard';
import { ShortId } from '@/components/gitops/GitOpsShortId';
import { GitOpsTargetCard } from '@/components/gitops/GitOpsTargetCard';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import {
  absentFault,
  liveArtifactFacet,
  livePlacementFacet,
  liveRolloutFacet,
  liveSourceFacet,
} from '@/lib/gitopsState';
import { cn } from '@/lib/utils';
import type { GitOpsPortfolioDetailResponse, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

const SECTION_LABEL = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const CARD_SHELL = 'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel';

const TARGET_MODE_LABEL: Partial<Record<string, string>> & Record<GitOpsPortfolioRow['targetMode'], string> = {
  direct: 'Direct node',
  blueprint: 'Blueprint',
  inline_blueprint: 'Inline Blueprint',
};

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={SECTION_LABEL}>{label}</h2>
      {children}
    </section>
  );
}

function evidenceLine(evidence: GitOpsPortfolioRow['evidence'], nodeName: (id: number) => string): string {
  if (!evidence.partial) return 'The evidence behind this application\'s state could not be established.';
  const who = evidence.unreachableNodes.length > 0
    ? `${evidence.unreachableNodes.map(nodeName).join(', ')} could not be reached`
    : 'not every target could report';
  return `Evidence is partial: ${who}, so their target state may not be current.`;
}

/**
 * One GitOps application, in full: identity, attention, decomposed authority,
 * the four application facets, every target, classified drift, and caveats.
 *
 * Presentation only: every status comes from the projection the endpoint
 * returned, and facet and runtime statuses read through the same lookups and
 * cards the Git source panel, Drift tab and Blueprint sheet use. No status is
 * inferred here; one this build does not recognize is labelled unrecognized
 * rather than guessed. Health, connectivity and last known good are shown as
 * their raw status words.
 * Application-level facts precede per-node facts, and caveats come last.
 */
export default function GitOpsApplicationDetail({ detail }: { detail: GitOpsPortfolioDetailResponse }) {
  const { application: row, projection } = detail;
  const live = projection.targetMode === 'not_applicable' ? null : projection;
  const faults = absentFault(projection);
  const source = liveSourceFacet(projection);
  const artifact = liveArtifactFacet(projection);
  const placement = livePlacementFacet(projection);
  const rollout = liveRolloutFacet(projection);
  const nodeNames = new Map(row.targets.map(t => [t.nodeId, t.nodeName]));
  const nodeName = (id: number) => nodeNames.get(id) ?? (row.nodeId === id ? row.nodeName : null) ?? `node ${id}`;

  return (
    <div data-testid="gitops-application-detail" className="grid gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        <Section label="Identity">
          <dl className={cn(CARD_SHELL, 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-3 py-2.5')}>
            <IdentityRow term="Target">{TARGET_MODE_LABEL[row.targetMode] ?? `unrecognized (${row.targetMode})`}</IdentityRow>
            {row.targetMode === 'direct'
              ? <IdentityRow term="Node">{row.nodeId === null ? 'none' : nodeName(row.nodeId)}</IdentityRow>
              : <IdentityRow term="Blueprint">{row.blueprintId === null ? 'none' : `#${row.blueprintId}`}</IdentityRow>}
            {row.repository ? (
              <>
                <IdentityRow term="Repository">
                  <span title={row.repository.configuredRepoUrl}>{row.repository.host}{row.repository.pathname}</span>
                </IdentityRow>
                <IdentityRow term="Ref">{row.repository.configuredRef}</IdentityRow>
              </>
            ) : (
              <IdentityRow term="Repository">none</IdentityRow>
            )}
            <IdentityRow term="Desired commit"><ShortId value={row.desiredCommitSha} length={7} /></IdentityRow>
            <IdentityRow term="Fetched commit"><ShortId value={row.fetchedCommitSha} length={7} /></IdentityRow>
            <IdentityRow term="Candidate generation"><ShortId value={row.candidateGenerationId} /></IdentityRow>
            <IdentityRow term="Accepted generation"><ShortId value={row.acceptedGenerationId} /></IdentityRow>
            {live && live.targetMode !== 'direct' && (
              <IdentityRow term="Rollout generation"><ShortId value={live.rolloutGenerationId} /></IdentityRow>
            )}
          </dl>
        </Section>

        {row.attention.length > 0 && (
          <Section label={`Attention · ${row.attention.length}`}>
            <ul data-testid="gitops-application-attention" className={cn(CARD_SHELL, 'divide-y divide-card-border/60')}>
              {row.attention.map(reason => {
                const label = attentionLabel(reason);
                return (
                  <li key={reason} className="flex items-start gap-3 px-3 py-2">
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
                        POSTURE_TONE_CLASS[label.tone],
                      )}
                    >
                      {label.label}
                    </span>
                    <span className="min-w-0 flex-1 text-xs text-stat-subtitle">{label.line}</span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <Section label="Application state">
          <div className="flex flex-col gap-2">
            {faults.length > 0 && <GitOpsFaultCard message={faults[0].message} />}
            {!live && faults.length === 0 && (
              <GitOpsStateCard
                data-testid="gitops-no-revision"
                stateKey="not_applicable"
                state={{
                  label: 'no revision state',
                  tone: 'neutral',
                  line: 'Sencho has no revision state recorded for this source, so no facet is reported.',
                  icon: CircleSlash,
                }}
              />
            )}
            {live && (
              <GitOpsApprovalChips approvals={live.approvals} placement={placement} rollout={rollout} />
            )}
            <GitOpsFacetCards source={source} artifact={artifact} placement={placement} rollout={rollout} />
          </div>
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {(row.evidence.partial || row.evidence.unknown) && (
          <div data-testid="gitops-application-evidence" className="rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2">
            <p className="font-mono text-[11px] text-warning">{evidenceLine(row.evidence, nodeName)}</p>
          </div>
        )}

        {live && live.targets.length > 0 && (
          <Section label={`Targets · ${live.targets.length}`}>
            <div className="flex flex-col gap-2">
              {live.targets.map(t => <GitOpsTargetCard key={t.nodeId} target={t} nodeName={nodeName(t.nodeId)} />)}
            </div>
          </Section>
        )}

        {live && live.drift.length > 0 && (
          <Section label="Drift">
            <div className={cn(CARD_SHELL, 'px-3 py-1')}>
              {live.drift.map((d, i) => <GitOpsDriftRow key={`${d.class}-${d.owner}-${i}`} item={d} />)}
            </div>
          </Section>
        )}

        <GitOpsCaveats revision={projection} />
      </div>
    </div>
  );
}
