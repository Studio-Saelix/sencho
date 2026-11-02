import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ServiceSenchoLinks } from './ServiceSenchoLinks';
import { serviceUpdateButtonState, updatePolicyChip } from './serviceUpdatePolicy';
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

describe('update policy', () => {
  const policy = (update: string | null) => resolution({
    web: { links: [], order: null, hidden: false, update, notifyRoute: null },
  });

  it.each([
    ['manual', 'Updates: manual'],
    ['disabled', 'Updates: off'],
    ['invalid', 'Updates: unattended off'],
  ])('shows the %s chip with a tooltip naming the label', (value, label) => {
    render(<ServiceSenchoLinks resolution={policy(value)} service="web" applicationLinkShown={false} />);
    const chip = screen.getByTestId('service-update-policy');
    expect(chip).toHaveTextContent(label);
    expect(chip.getAttribute('title')).toContain('io.sencho.update');
  });

  it('shows no chip for an auto or absent policy', () => {
    const { container } = render(<ServiceSenchoLinks resolution={policy('auto')} service="web" applicationLinkShown={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(updatePolicyChip(policy('auto'), 'web')).toBeNull();
    expect(updatePolicyChip(policy(null), 'web')).toBeNull();
  });

  it('reads the policy for the given service only', () => {
    expect(updatePolicyChip(policy('manual'), 'db')).toBeNull();
    expect(updatePolicyChip(null, 'web')).toBeNull();
  });

  it('disables the service Update affordance for disabled, and only for disabled', () => {
    expect(serviceUpdateButtonState(policy('disabled'), 'web')).toEqual({
      disabled: true,
      title: expect.stringContaining('io.sencho.update'),
    });
    expect(serviceUpdateButtonState(policy('manual'), 'web')).toEqual({ disabled: false });
    expect(serviceUpdateButtonState(policy('invalid'), 'web')).toEqual({ disabled: false });
    expect(serviceUpdateButtonState(policy('auto'), 'web')).toEqual({ disabled: false });
    expect(serviceUpdateButtonState(policy('disabled'), 'db')).toEqual({ disabled: false });
  });
});
