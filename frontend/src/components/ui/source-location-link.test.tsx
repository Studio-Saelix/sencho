import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mobile = { value: false };
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile.value }));

import { SourceLocationLink } from './source-location-link';

const location = {
  file: 'compose.override.yaml',
  path: 'services.api.ports',
  line: 14,
  column: 3,
  endLine: 14,
  endColumn: 20,
};

describe('SourceLocationLink', () => {
  beforeEach(() => {
    mobile.value = false;
  });

  it('renders a keyboard-reachable button with the exact accessible name', async () => {
    const onOpen = vi.fn();
    render(<SourceLocationLink location={location} onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: 'Open compose.override.yaml at line 14' });
    expect(button).toHaveTextContent('compose.override.yaml:14');
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('adds the dot path to the tooltip only when present', async () => {
    render(<SourceLocationLink location={location} onOpen={vi.fn()} />);
    await userEvent.hover(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('services.api.ports')).toBeInTheDocument());
  });

  it('renders plain text with no control below md', () => {
    mobile.value = true;
    const onOpen = vi.fn();
    render(<SourceLocationLink location={location} onOpen={onOpen} />);
    expect(screen.queryByRole('button')).toBeNull();
    const text = screen.getByTestId('source-location-text');
    expect(text).toHaveTextContent('compose.override.yaml:14');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
