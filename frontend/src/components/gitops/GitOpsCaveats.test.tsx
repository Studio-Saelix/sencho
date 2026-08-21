import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { absentRevision, liveRevision, missingApplicationLimitation } from '@/__tests__/gitopsFixtures';
import { GITOPS_LIMITATION_COPY } from '@/lib/gitopsLimitations';
import GitOpsCaveats from './GitOpsCaveats';
import type { GitOpsLimitation } from '@/types/gitops';

const limitation = (code: string): GitOpsLimitation => ({ code, message: 'log wording', evidence: null });

describe('GitOpsCaveats', () => {
  it('renders nothing when the state has nothing to qualify', () => {
    render(<GitOpsCaveats revision={liveRevision({ limitations: [] })} />);
    expect(screen.queryByTestId('gitops-caveats')).toBeNull();
  });

  it('renders nothing when there is no projection at all', () => {
    render(<GitOpsCaveats revision={null} />);
    expect(screen.queryByTestId('gitops-caveats')).toBeNull();
  });

  it('shows the operator wording for each caveat', () => {
    render(<GitOpsCaveats revision={liveRevision({
      limitations: [limitation('legacy_pending'), limitation('lkg_generation_missing')],
    })} />);

    expect(screen.getByText(GITOPS_LIMITATION_COPY.legacy_pending)).toBeInTheDocument();
    expect(screen.getByText(GITOPS_LIMITATION_COPY.lkg_generation_missing)).toBeInTheDocument();
    expect(screen.queryByText('log wording')).toBeNull();
  });

  it('counts the caveats in the heading', () => {
    render(<GitOpsCaveats revision={liveRevision({ limitations: [limitation('legacy_pending')] })} />);
    expect(screen.getByText('one thing could not be proven')).toBeInTheDocument();
  });

  it('pluralizes the heading', () => {
    render(<GitOpsCaveats revision={liveRevision({
      limitations: [limitation('legacy_pending'), limitation('manifest_absent')],
    })} />);
    expect(screen.getByText('2 things could not be proven')).toBeInTheDocument();
  });

  it('shows one condition once however many times it was recorded', () => {
    // The same condition is recorded per target and again per application, so
    // both the heading count and the list keys depend on the dedup happening
    // here rather than only in the map builder.
    render(<GitOpsCaveats revision={liveRevision({
      limitations: [limitation('lkg_generation_missing'), limitation('lkg_generation_missing')],
    })} />);

    expect(screen.getByText('one thing could not be proven')).toBeInTheDocument();
    expect(screen.getAllByText(GITOPS_LIMITATION_COPY.lkg_generation_missing)).toHaveLength(1);
  });

  it('says nothing for a fault on the absent arm', () => {
    // A fault means the state could not be reported at all, so rendering it
    // here would present an unavailable projection as a qualified one. The
    // fault card owns that case.
    render(<GitOpsCaveats revision={absentRevision([missingApplicationLimitation])} />);
    expect(screen.queryByTestId('gitops-caveats')).toBeNull();
  });
});
