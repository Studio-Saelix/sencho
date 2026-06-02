/**
 * The fresh-deploy action triggers a remote deploy that can take several seconds.
 * The dialog must show an in-progress indicator while it runs, otherwise the click
 * looks like it did nothing.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StateReviewDialog } from './StateReviewDialog';

const baseProps = {
    open: true,
    onOpenChange: () => {},
    blueprintName: 'heimdall',
    nodeName: 'sencho-test-01',
    onAccept: () => {},
};

describe('StateReviewDialog', () => {
    it('offers the fresh deploy action when idle', () => {
        render(<StateReviewDialog {...baseProps} busy={false} />);
        expect(screen.getByText('Deploy fresh')).toBeInTheDocument();
        expect(screen.queryByText(/deploying/i)).not.toBeInTheDocument();
    });

    it('shows an in-progress indicator and disables the action while deploying', () => {
        render(<StateReviewDialog {...baseProps} busy />);
        expect(screen.getByText(/deploying/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /deploying/i })).toBeDisabled();
    });
});
