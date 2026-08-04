import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { TakeDownStackDialog } from '../TakeDownStackDialog';

function renderDialog(
    open: boolean,
    overrides: Partial<ComponentProps<typeof TakeDownStackDialog>> = {},
) {
    return render(
        <TakeDownStackDialog
            open={open}
            onOpenChange={vi.fn()}
            stackName="plex"
            showVolumeOption
            onConfirm={vi.fn()}
            {...overrides}
        />,
    );
}

describe('TakeDownStackDialog', () => {
    it('resets removeVolumes after parent-driven close and reopen', async () => {
        const user = userEvent.setup();
        const { rerender } = renderDialog(true);

        const checkbox = screen.getByTestId('take-down-remove-volumes');
        await user.click(checkbox);
        expect(checkbox.getAttribute('data-state')).toBe('checked');

        // Parent closes after async success without routing through onOpenChange(false).
        rerender(
            <TakeDownStackDialog
                open={false}
                onOpenChange={vi.fn()}
                stackName="plex"
                showVolumeOption
                onConfirm={vi.fn()}
            />,
        );
        rerender(
            <TakeDownStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="plex"
                showVolumeOption
                onConfirm={vi.fn()}
            />,
        );

        expect(screen.getByTestId('take-down-remove-volumes').getAttribute('data-state')).toBe('unchecked');
    });

    it('passes removeVolumes=false on confirm after parent-driven reopen', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        const { rerender } = render(
            <TakeDownStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="plex"
                showVolumeOption
                onConfirm={onConfirm}
            />,
        );

        await user.click(screen.getByTestId('take-down-remove-volumes'));
        rerender(
            <TakeDownStackDialog
                open={false}
                onOpenChange={vi.fn()}
                stackName="plex"
                showVolumeOption
                onConfirm={onConfirm}
            />,
        );
        rerender(
            <TakeDownStackDialog
                open
                onOpenChange={vi.fn()}
                stackName="plex"
                showVolumeOption
                onConfirm={onConfirm}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Take down' }));
        expect(onConfirm).toHaveBeenCalledWith(false);
    });

    it('disables Take down, Cancel, and volume checkbox while confirming', () => {
        renderDialog(true, { confirming: true });
        expect(screen.getByRole('button', { name: /Take down/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByTestId('take-down-remove-volumes')).toBeDisabled();
    });
});
