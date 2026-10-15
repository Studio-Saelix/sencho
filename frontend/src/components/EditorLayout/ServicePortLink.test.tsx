import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));

import { ServicePortLink } from './ServicePortLink';
import { copyToClipboard } from '@/lib/clipboard';
import type { ServiceUrlEntry } from '@/lib/serviceUrlResolve';
import type { Node } from '@/context/NodeContext';

const entry: ServiceUrlEntry = {
  status: 'ready',
  nodeId: 1,
  stackName: 'web',
  renderable: true,
  serviceUrls: { api: 'https://api.example.com' },
  serviceUrlEdit: { api: 'root' },
  serviceUrlClear: { api: 'root' },
  ports: { api: [{ host: '8080', proto: 'tcp' }] },
};

describe('ServicePortLink edit affordance', () => {
  it('does not invite a save for a service outside the open compose file', () => {
    const onEdit = vi.fn();
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['web']}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('This service is not in the open compose file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('offers a save when the service is in the open compose file', () => {
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['api']}
        onEdit={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Set URL for api' })).toBeTruthy();
  });

  it('does not invite a save when another file sets the URL', () => {
    const onEdit = vi.fn();
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['api']}
        lockedServices={new Map([['api', 'other']])}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('This URL is set in another compose file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('explains an unverifiable source instead of inviting a save', () => {
    const onEdit = vi.fn();
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['api']}
        lockedServices={new Map([['api', 'unknown']])}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('Sencho cannot verify which compose file sets this URL.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('shows the plain port when a remote node has no host and no override', () => {
    const pilot: ServiceUrlEntry = {
      status: 'ready',
      nodeId: 3,
      stackName: 'web',
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: {},
      serviceUrlClear: {},
      ports: { web: [{ host: '8080', proto: 'tcp' }] },
    };
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="web"
        entry={pilot}
        node={{ type: 'remote', api_url: '' } as Node}
        canEdit={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('8080')).toBeTruthy();
    expect(screen.queryByText('Service URL unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers a retry only after the service URL list failed to load', () => {
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        entry={{ ...entry, status: 'unavailable', serviceUrls: {}, renderable: false, ports: {} }}
        node={{ type: 'remote', api_url: '' } as Node}
        canEdit={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('Service URL unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('holds the port until the first lookup resolves, then opens the configured URL', () => {
    const loading: ServiceUrlEntry = {
      status: 'loading',
      nodeId: 1,
      stackName: 'web',
      renderable: false,
      serviceUrls: {},
      serviceUrlEdit: {},
      serviceUrlClear: {},
      ports: {},
    };
    const props = {
      portLabel: '8080',
      publicPort: 8080,
      serviceName: 'api',
      node: { type: 'local' } as Node,
      canEdit: true,
      sourceServices: ['api'],
      onEdit: () => undefined,
    };
    const { rerender } = render(<ServicePortLink {...props} entry={loading} />);
    // No outcome yet: no anchor, and no edit affordance that could act on a
    // URL that is not known to exist.
    expect(screen.getByText('8080')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();

    rerender(<ServicePortLink {...props} entry={entry} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://api.example.com');
    expect(screen.getByRole('button', { name: 'Set URL for api' })).toBeTruthy();
  });

  it('keeps a long host inside the card and restores the open arrow', () => {
    render(
      <ServicePortLink
        portLabel="8080 → 80/tcp"
        publicPort={8080}
        serviceName="api"
        entry={{ ...entry, serviceUrls: { api: 'https://whoami.homelab.example.com' } }}
        node={{ type: 'local' } as Node}
        canEdit
        sourceServices={['api']}
        onEdit={() => undefined}
      />,
    );
    const link = screen.getByRole('link');
    const row = link.parentElement;
    expect(link.querySelector('svg')).toBeTruthy();
    expect(link.textContent).toContain('whoami.homelab.example.com');
    expect(link.querySelector('span')?.className).toContain('min-w-0');
    expect(row?.className).toContain('min-w-0');
    expect(row?.className).not.toContain('whitespace-nowrap');
    expect(row?.className).not.toContain('shrink-0');
    expect(screen.getByRole('button', { name: 'Copy service URL' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set URL for api' })).toBeTruthy();
  });
});

describe('ServicePortLink runtime ownership', () => {
  const runtimeEntry = (ports: ServiceUrlEntry['ports']): ServiceUrlEntry => ({
    status: 'ready',
    nodeId: 1,
    stackName: 'web',
    renderable: true,
    serviceUrls: { web: 'https://web.example.com', api: 'https://api.example.com' },
    serviceUrlEdit: { web: 'root', api: 'root' },
    serviceUrlClear: { web: 'root', api: 'root' },
    ports,
  });

  it('audit F01: keeps the anchor on the service URL after a fixed saved port changed', () => {
    // The running `web` container owns 8080; the saved file moved `web` to 9090
    // and gave `api` the old number. The card still opens `web`'s own URL.
    render(
      <ServicePortLink
        portLabel="8080 → 80/tcp"
        publicPort={8080}
        privatePort={80}
        serviceName="web"
        entry={runtimeEntry({
          web: [{ host: '9090', container: '80', proto: 'tcp' }],
          api: [{ host: '8080', container: '80', proto: 'tcp' }],
        })}
        node={{ type: 'local' } as Node}
        canEdit={false}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://web.example.com');
  });

  it('audit F01: keeps the anchor on the service URL after the saved binding is removed', () => {
    render(
      <ServicePortLink
        portLabel="8080 → 80/tcp"
        publicPort={8080}
        privatePort={80}
        serviceName="web"
        entry={runtimeEntry({})}
        node={{ type: 'local' } as Node}
        canEdit={false}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://web.example.com');
  });

  it('audit F01: opens the service URL on a hostless remote node', () => {
    render(
      <ServicePortLink
        portLabel="8080 → 80/tcp"
        publicPort={8080}
        privatePort={80}
        serviceName="web"
        entry={runtimeEntry({ web: [{ host: '9090', container: '80', proto: 'tcp' }] })}
        node={{ type: 'remote', api_url: '' } as Node}
        canEdit={false}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://web.example.com');
  });

  it('audit F01: an inferred caller still refuses another service automatic owner', () => {
    // No runtime private port: ownership is inferred from the saved model, so a
    // single fixed declaration with an automatic sibling stays ambiguous.
    render(
      <ServicePortLink
        portLabel=":49152"
        publicPort={49152}
        serviceName="web"
        entry={runtimeEntry({
          web: [{ host: '49152', container: '80', proto: 'tcp' }],
          worker: [{ host: '', container: '9000', proto: 'tcp' }],
        })}
        node={{ type: 'local' } as Node}
        canEdit={false}
      />,
    );
    expect(screen.getByText('More than one service publishes this port')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('audit F2: a runtime owner without an override keeps the generated anchor and copy target', async () => {
    // Running container `web` owns 8090:80 and has no override; the saved model
    // gave 8090 to `a` and `b`, which have one. The runtime card keeps the
    // generated link, and Copy copies that same address.
    const conflicting: ServiceUrlEntry = {
      status: 'ready',
      nodeId: 1,
      stackName: 'web',
      renderable: true,
      serviceUrls: { a: 'https://a.example.com', b: 'https://b.example.com' },
      serviceUrlEdit: { a: 'root', b: 'root' },
      serviceUrlClear: { a: 'root', b: 'root' },
      ports: {
        a: [{ host: '8090', container: '80', proto: 'tcp' }],
        b: [{ host: '8090', container: '80', proto: 'tcp' }],
      },
    };
    render(
      <ServicePortLink
        portLabel="8090 → 80/tcp"
        publicPort={8090}
        privatePort={80}
        serviceName="web"
        entry={conflicting}
        node={{ type: 'local' } as Node}
        canEdit={false}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('http://localhost:8090');
    expect(screen.getByRole('link').querySelector('svg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy service URL' }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('http://localhost:8090'));
  });
});
