import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
import { Command } from '@/components/ui/command';
import { SidebarSearch } from '../SidebarSearch';

function renderInsideCommand(props: { value: string; onValueChange: (v: string) => void }) {
  return render(
    <Command shouldFilter={false}>
      <SidebarSearch {...props} />
    </Command>,
  );
}

describe('SidebarSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('reflects typing immediately in the input but does not emit until the debounce window closes', () => {
    const onValueChange = vi.fn();
    const { getByPlaceholderText } = renderInsideCommand({ value: '', onValueChange });
    const input = getByPlaceholderText('Search stacks...') as HTMLInputElement;

    act(() => {
      fireEvent.input(input, { target: { value: 'n' } });
      fireEvent.input(input, { target: { value: 'ng' } });
      fireEvent.input(input, { target: { value: 'ngi' } });
      fireEvent.input(input, { target: { value: 'ngin' } });
      fireEvent.input(input, { target: { value: 'nginx' } });
    });

    expect(input.value).toBe('nginx');
    expect(onValueChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenLastCalledWith('nginx');
  });

  it('does not clobber in-flight typing when the parent value echoes back the previous debounced emit', () => {
    const onValueChange = vi.fn();
    const { getByPlaceholderText, rerender } = renderInsideCommand({ value: '', onValueChange });
    const input = getByPlaceholderText('Search stacks...') as HTMLInputElement;

    act(() => {
      fireEvent.input(input, { target: { value: 'web' } });
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onValueChange).toHaveBeenLastCalledWith('web');

    // Parent now propagates 'web' back as the controlled value.
    rerender(
      <Command shouldFilter={false}>
        <SidebarSearch value="web" onValueChange={onValueChange} />
      </Command>,
    );

    // User keeps typing before the parent's echo settles.
    act(() => {
      fireEvent.input(input, { target: { value: 'web-api' } });
    });

    // The echo of 'web' must not overwrite 'web-api' on the input.
    expect(input.value).toBe('web-api');
  });

  it('adopts an external reset of the parent value (e.g., clear)', () => {
    const onValueChange = vi.fn();
    const { getByPlaceholderText, rerender } = renderInsideCommand({ value: 'old-query', onValueChange });
    const input = getByPlaceholderText('Search stacks...') as HTMLInputElement;
    expect(input.value).toBe('old-query');

    rerender(
      <Command shouldFilter={false}>
        <SidebarSearch value="" onValueChange={onValueChange} />
      </Command>,
    );

    expect(input.value).toBe('');
  });

  it('cancels the pending debounce emit when the parent resets the value mid-window', () => {
    const onValueChange = vi.fn();
    // Start at a non-empty initial so the later reset to '' is a real prop
    // transition; rerendering with the same string would no-op in React.
    const { getByPlaceholderText, rerender } = renderInsideCommand({ value: 'initial', onValueChange });
    const input = getByPlaceholderText('Search stacks...') as HTMLInputElement;
    expect(input.value).toBe('initial');

    act(() => {
      fireEvent.input(input, { target: { value: 'web' } });
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onValueChange).not.toHaveBeenCalled();

    rerender(
      <Command shouldFilter={false}>
        <SidebarSearch value="" onValueChange={onValueChange} />
      </Command>,
    );

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // The stale timer must not fire and re-emit 'web', undoing the reset.
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });
});
