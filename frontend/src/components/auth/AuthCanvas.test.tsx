import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthCanvas } from './AuthCanvas';

describe('AuthCanvas', () => {
  it('caps card height and scrolls overflowing body content', () => {
    render(
      <AuthCanvas footer={<span>Footer copy</span>}>
        <p>Tall content</p>
      </AuthCanvas>,
    );

    const card = screen.getByRole('group');
    expect(card.className).toContain('max-h-[calc(100svh-5rem)]');
    expect(card.className).toContain('flex-col');

    const body = screen.getByText('Tall content').parentElement;
    expect(body?.className).toContain('overflow-y-auto');
    expect(body?.className).toContain('min-h-0');
    expect(body?.className).toContain('flex-1');
  });

  it('keeps header and footer outside the scroll region', () => {
    render(
      <AuthCanvas footer={<span>Footer copy</span>}>
        <p>Body</p>
      </AuthCanvas>,
    );

    const header = screen.getByText('SENCHO').parentElement;
    const footer = screen.getByText('Footer copy').parentElement;

    expect(header?.className).toContain('shrink-0');
    expect(footer?.className).toContain('shrink-0');
  });
});
