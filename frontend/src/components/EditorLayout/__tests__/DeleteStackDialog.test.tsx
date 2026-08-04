import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
                volumePreservation="supported"
                onConfirm={vi.fn()}
                confirming
            />,
        );

        expect(screen.getByRole('button', { name: /Delete/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByRole('checkbox')).toBeDisabled();
    });

    it('warns instead of offering a checkbox when the node is confirmed unable to preserve volumes', () => {
        render(
            <DeleteStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="web"
                volumePreservation="unsupported"
                onConfirm={vi.fn()}
            />,
        );

        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.getByText(/can't preserve volumes on delete/i)).toBeVisible();
        expect(screen.getByText('VOLUMES WILL BE REMOVED')).toBeVisible();
    });

    it('confirms with pruneVolumes: true on a node confirmed unable to preserve volumes, without the operator opting in', () => {
        const onConfirm = vi.fn();
        render(
            <DeleteStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="web"
                volumePreservation="unsupported"
                onConfirm={onConfirm}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(onConfirm).toHaveBeenCalledWith(true);
    });

    it('confirms with pruneVolumes: false by default when the node can preserve volumes', () => {
        const onConfirm = vi.fn();
        render(
            <DeleteStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="web"
                volumePreservation="supported"
                onConfirm={onConfirm}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(onConfirm).toHaveBeenCalledWith(false);
    });

    it('requests preservation (pruneVolumes: false) and shows no destructive warning when node support is not yet confirmed', () => {
        const onConfirm = vi.fn();
        render(
            <DeleteStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="web"
                volumePreservation="unknown"
                onConfirm={onConfirm}
            />,
        );

        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.queryByText(/can't preserve volumes on delete/i)).not.toBeInTheDocument();
        expect(screen.getByText('VOLUMES KEPT')).toBeVisible();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(onConfirm).toHaveBeenCalledWith(false);
    });
});
