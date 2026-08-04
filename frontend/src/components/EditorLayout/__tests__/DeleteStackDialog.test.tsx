import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeleteStackDialog } from '../DeleteStackDialog';

const LONG_STACK_NAME = 'this-is-a-very-long-stack-name-that-should-not-push-actions-off-screen';

function renderLongNameDialog() {
    render(
        <DeleteStackDialog
            open
            onOpenChange={vi.fn()}
            stackName={LONG_STACK_NAME}
            onConfirm={vi.fn()}
        />,
    );
}

describe('DeleteStackDialog', () => {
    it('keeps Delete and Cancel visible when the stack name is very long', () => {
        renderLongNameDialog();

        expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    });

    it('exposes the full stack name on hover via title', () => {
        renderLongNameDialog();

        expect(screen.getByTitle(LONG_STACK_NAME)).toHaveTextContent(LONG_STACK_NAME);
    });

    it('disables Delete, Cancel, and volume checkbox while confirming', () => {
        render(
            <DeleteStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="web"
                showVolumeOption={true}
                onConfirm={vi.fn()}
                confirming
            />,
        );

        expect(screen.getByRole('button', { name: /Delete/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByRole('checkbox')).toBeDisabled();
    });
});
