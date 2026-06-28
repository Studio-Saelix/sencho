import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownContent } from '../MarkdownContent';

describe('MarkdownContent', () => {
  it('does not render raw HTML from the source as live markup', () => {
    const { container } = render(
      <MarkdownContent>{'Hello <img src=x onerror="alert(1)"> <script>alert(2)</script> world'}</MarkdownContent>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders standard markdown structures', () => {
    const { container, getByRole } = render(
      <MarkdownContent>{'# Title\n\n* one\n* two\n\n[link](https://example.com)'}</MarkdownContent>,
    );
    expect(getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(getByRole('link', { name: 'link' })).toHaveAttribute('href', 'https://example.com');
  });
});
