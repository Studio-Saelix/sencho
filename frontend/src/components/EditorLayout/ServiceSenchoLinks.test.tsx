import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ServiceSenchoLinks } from './ServiceSenchoLinks';
import { readSenchoLabels } from '@/lib/senchoLabels';

function resolution(services: Record<string, unknown>, entries: unknown[] = []) {
  return readSenchoLabels({ renderable: true, services, entries });
}

describe('ServiceSenchoLinks', () => {
  it('opens each link at the address the label declared, never rewritten to a host the hub knows', () => {
    // A hostless remote node has no address of its own; the declared URL is all there is.
    render(
      <ServiceSenchoLinks
        resolution={resolution({
          web: { links: [{ name: null, url: 'https://app.example.com/x?y=1' }, { name: 'docs', url: 'http://docs.internal:8080/' }], order: null, hidden: false },
        })}
        service="web"
        applicationLinkShown={false}
      />,
    );
    expect(screen.getByRole('link', { name: 'app.example.com' })).toHaveAttribute('href', 'https://app.example.com/x?y=1');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'http://docs.internal:8080/');
  });

  it('renders link names as text, so markup in a name from a node is never interpreted', () => {
    const { container } = render(
      <ServiceSenchoLinks
        resolution={resolution({ web: { links: [{ name: 'docs', url: 'https://docs.example.com' }], order: null, hidden: false } },
          [{ service: 'web', key: 'io.sencho.x', state: 'unsupported', reason: '<img src=x onerror=alert(1)>' }])}
        service="web"
        applicationLinkShown
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('service-sencho-ignored').getAttribute('title')).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders nothing for a service without links or ignored labels', () => {
    const { container } = render(
      <ServiceSenchoLinks resolution={resolution({ web: { links: [], order: null, hidden: false } })} service="web" applicationLinkShown={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
