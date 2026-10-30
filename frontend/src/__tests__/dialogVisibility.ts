import { screen } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * Assert a confirmation dialog shows `text` to a sighted operator.
 *
 * `ConfirmModal.description` renders into a screen-reader-only element, so a
 * plain text match passes even when the visible body is missing. This walks up
 * from every match and fails when they all live inside the sr-only
 * description.
 */
export function expectVisibleInDialog(text: RegExp): void {
    const dialog = screen.getByRole('alertdialog');
    const matches = screen.getAllByText(text);
    const hidden = matches.filter((el) => {
        for (let cur: HTMLElement | null = el; cur && cur !== dialog; cur = cur.parentElement) {
            if (/\bsr-only\b/.test(cur.className)) return true;
        }
        return false;
    });
    expect(matches.length - hidden.length, `visible copy of ${text}`).toBeGreaterThan(0);
}
