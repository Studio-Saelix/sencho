import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServiceUrlModal } from './ServiceUrlModal';

const CLEAR_BLOCKED = 'This URL is also set in another compose file, so clearing it here cannot take effect.';

function setup(overrides: Partial<Parameters<typeof ServiceUrlModal>[0]> = {}) {
  const onSave = vi.fn();
  const props: Parameters<typeof ServiceUrlModal>[0] = {
    open: true,
    serviceName: 'web',
    initialUrl: 'https://app.example.com',
    dirty: false,
    saving: false,
    verifyMessage: null,
    clearBlockedMessage: null,
    editBlockedMessage: null,
    editBlockId: 0,
    onOpenChange: vi.fn(),
    onSave,
    onRetryVerify: vi.fn(),
    ...overrides,
  };
  render(<ServiceUrlModal {...props} />);
  return { onSave };
}

const input = () => screen.getByPlaceholderText('https://app.example.com') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save URL' }) as HTMLButtonElement;

describe('ServiceUrlModal clear gate', () => {
  it('disables Save and explains when the empty field cannot clear the URL', () => {
    setup({ clearBlockedMessage: CLEAR_BLOCKED });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(CLEAR_BLOCKED)).toBeNull();

    fireEvent.change(input(), { target: { value: '' } });
    expect(screen.getByText(CLEAR_BLOCKED)).toBeTruthy();
    expect(save().disabled).toBe(true);

    // Typing a new URL switches to the set path, which the same service allows.
    fireEvent.change(input(), { target: { value: 'https://new.example.com' } });
    expect(screen.queryByText(CLEAR_BLOCKED)).toBeNull();
    expect(save().disabled).toBe(false);
  });

  it('keeps Save disabled until the URL field changes, then accepts the next refusal', () => {
    const refused = 'The URL cannot be changed here without changing other parts of this compose file. Edit the label in the editor instead.';
    const onSave = vi.fn();
    const props: Parameters<typeof ServiceUrlModal>[0] = {
      open: true,
      serviceName: 'web',
      initialUrl: 'https://app.example.com',
      dirty: false,
      saving: false,
      verifyMessage: null,
      clearBlockedMessage: null,
      editBlockedMessage: refused,
      editBlockId: 1,
      onOpenChange: vi.fn(),
      onSave,
      onRetryVerify: vi.fn(),
    };
    const { rerender } = render(<ServiceUrlModal {...props} />);
    expect(screen.getByText(refused)).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.click(save());
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: 'https://new.example.com' } });
    expect(screen.queryByText(refused)).toBeNull();
    expect(save().disabled).toBe(false);

    rerender(<ServiceUrlModal {...props} editBlockId={2} />);
    expect(screen.getByText(refused)).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('saves an empty field as a clear when clearing is allowed', () => {
    const { onSave } = setup();
    fireEvent.change(input(), { target: { value: '' } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
